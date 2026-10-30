import crypto from 'node:crypto';
'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentInterface } from './agent-interface.mjs';
import { PluginInterface } from './plugin-interface.mjs';

const SETUP_TIMEOUT_MS = Number(globalThis.__KIKX_PLUGIN_SETUP_TIMEOUT_MS) || 15000;

// Resolve with the promise, or reject if it takes too long. The losing promise is not
// cancelled - JavaScript cannot - but startup stops waiting on it, which is the
// property that matters: one wedged plugin must not hang the whole server.
function withTimeout(promise, ms, message) {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    // Deliberately NOT unref'd. An unref'd timer does not keep the event loop alive, so
    // with a plugin that never settles there is nothing outstanding and the process
    // exits before the timer can fire. The timeout must be able to hold the loop open.
    promise.then(
      (value) => { if (timer) clearTimeout(timer); resolve(value); },
      (error) => { if (timer) clearTimeout(timer); reject(error); },
    );
  });
}


// A stable, non-disclosing identifier for a plugin directory. Two installs with the
// same directory name must not share a failure slot, and the absolute path must not be
// served to unauthenticated callers.
function pluginLocation(pluginPath) {
  let name = String(pluginPath).split(/[/\\]/).filter(Boolean).pop() || 'unknown';
  let hash = crypto.createHash('sha256').update(String(pluginPath)).digest('hex').slice(0, 8);
  return `${name}#${hash}`;
}


// Optional kikx-plugin.json beside index.mjs. Declares what the plugin is, so an
// inventory can describe it without loading the module, and so a future install step
// has something to validate against.
async function readPluginManifest(pluginPath) {
  let candidates = ['kikx-plugin.json', 'package.json'];
  for (let name of candidates) {
    let full = path.join(pluginPath, name);
    try {
      let raw = await fs.readFile(full, 'utf8');
      let parsed = JSON.parse(raw);
      return {
        // A plugin that ships its own kikx-plugin.json has declared itself. One that
        // only has package.json happens to be a Node package - not the same thing, and
        // an inventory should not present them identically.
        source: name === 'kikx-plugin.json' ? 'declared' : 'fallback',
        file: name,
        name: parsed.name || null,
        version: parsed.version || null,
        description: parsed.description || null,
        kikxVersion: parsed.kikxVersion || null,
      };
    } catch (_error) {
      continue;   // absent or unparseable: try the next candidate
    }
  }
  return null;
}

export async function loadPlugins(options = {}) {
  let {
    pluginPaths = '',
    registry,
    commandRegistry = null,
    context = {},
    logger = console,
  } = options;

  if (!registry)
    throw new TypeError('loadPlugins() requires registry');

  registry.registerClass('AgentInterface', AgentInterface, { pluginName: 'core' });
  registry.registerClass('PluginInterface', PluginInterface, { pluginName: 'core' });

  let loaded = [];
  for (let configuredPath of normalizePluginPaths(pluginPaths)) {
    for (let pluginPath of await expandPluginPathSites(configuredPath)) {
      // Declared outside the try so a failure part-way through can roll back what
      // this iteration already registered.
      let pluginName = null;
      let record = null;
      let ownedBefore = 0;
      try {
        // HARD BOUNDARY: nothing a plugin does may escape this iteration.
        // Not a throw, not a rejection, not a timer that never fires.
        let modulePath = await resolvePluginModule(pluginPath);
        let pluginModule = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);

        if (typeof pluginModule.setup !== 'function')
          continue;

        pluginName = pluginModule.pluginName || pluginNameFromPath(pluginPath);

        // A path that is already loaded is a RELOAD, and it must unload first.
        //
        // POST /api/v1/plugins/reload re-scans the configured paths and calls loadPlugins
        // again. registerPluginRecord only refuses a name when a DIFFERENT directory claims
        // it, so reloading the same directory was accepted - setup() ran a second time and
        // simply replaced the record. Two things leaked from that:
        //   - the previous registration kept its subscriptions on the bus while the new
        //     load added another, so one runtime event invoked the handler twice per
        //     reload, and N times after N reloads. Nothing looks broken, because the
        //     handler does run;
        //   - the replaced record held the only reference to that registration teardown,
        //     so replacing it dropped the teardown and the resources it would release.
        // Unloading here also gives a reload the teardown a plugin is entitled to expect.
        if (registry._pluginRegistrations?.get(pluginName)?.pluginPath === pluginPath)
          await unloadPlugin(registry, pluginName, { logger });

        // A successful load clears any stale failure for this location, so a
        // fixed plugin stops being reported as broken.
        if (registry._pluginLoadErrors?.length) {
          let loc = pluginLocation(pluginPath);
          registry._pluginLoadErrors = registry._pluginLoadErrors.filter((e) => e.location !== loc);
        }
        record = { pluginPath, pluginName, modulePath, pluginLocation: pluginLocation(pluginPath), callbacks: [], teardown: null };
        record.manifest = await readPluginManifest(pluginPath);
        let providerIDsBefore = agentProviderIDs(registry);
        // Everything the plugin registers during setup belongs to it.
        //
        // Snapshot the ledger depth first: two paths may declare the same plugin name,
        // and a rollback must only undo what this iteration added, never an earlier
        // load's registrations.
        if (typeof registry.listOwnedRegistrations === 'function')
          ownedBefore = registry.listOwnedRegistrations(pluginName).length;
        if (typeof registry.beginPluginLoad === 'function')
          registry.beginPluginLoad(pluginName);
        let teardown = await withTimeout(
          Promise.resolve(pluginModule.setup(createPluginSetupContext({
            registry,
            commandRegistry,
            context,
            pluginPath,
            pluginName,
            onProvide: (callback) => record.callbacks.push(callback),
          }))),
          SETUP_TIMEOUT_MS,
          `Plugin "${pluginName}" setup did not finish within ${SETUP_TIMEOUT_MS}ms`,
        );
        if (typeof teardown === 'function')
          record.teardown = teardown;

        // A plugin may return an object instead of a function, declaring lifecycle
        // hooks explicitly. onInit runs after every provide callback for this plugin
        // has fired, so initialisation sees the full registry.
        if (typeof registry.endPluginLoad === 'function')
          registry.endPluginLoad();

        if (teardown && typeof teardown === 'object') {
          record.onShutdown = typeof teardown.onShutdown === 'function' ? teardown.onShutdown : null;
          record.onInit = typeof teardown.onInit === 'function' ? teardown.onInit : null;
          if (typeof teardown.teardown === 'function')
            record.teardown = teardown.teardown;
        }

        // Provide callbacks have already been invoked synchronously during setup(),
        // so the registry is complete for this plugin by this point.
        if (record.onInit) {
          try {
            if (typeof registry.beginPluginLoad === 'function')
              registry.beginPluginLoad(pluginName);
            await withTimeout(
              Promise.resolve(record.onInit()),
              SETUP_TIMEOUT_MS,
              `Plugin "${pluginName}" onInit did not finish within ${SETUP_TIMEOUT_MS}ms`,
            );
          } catch (error) {
            logger.error?.(`Plugin "${pluginName}" onInit failed: ${error.message}`);
            throw error;
          } finally {
            if (typeof registry.endPluginLoad === 'function')
              registry.endPluginLoad();
          }
        }

        if (typeof registry.registerPluginPath === 'function') {
          let registeredProviderIDs = [];
          for (let key of agentProviderIDs(registry)) {
            if (!providerIDsBefore.has(key))
              registeredProviderIDs.push(key);
          }

          registry.registerPluginPath(pluginName, pluginPath, registeredProviderIDs);
        }

        // A refused duplicate must not be reported as loaded. registerPluginRecord
        // returns the refusal message when another directory already owns this name, and
        // pushing the entry anyway made the inventory list a plugin that the registry had
        // just declined to record - while its registrations stayed in the ownership
        // ledger, attributed to the plugin that legitimately loaded. Throwing here routes
        // the refusal through the same rollback as any other failure, and the rollback is
        // scoped by the ledger depth so the already-loaded plugin keeps its own work.
        // Rethrowing the recorded message rather than a fresh one preserves its
        // locations-only wording, which the catch block would otherwise overwrite.
        let refusal = registerPluginRecord(registry, record);
        if (refusal)
          throw new Error(refusal);

        loaded.push({ path: pluginPath, modulePath, pluginName });
      } catch (error) {
        if (typeof registry.endPluginLoad === 'function')
          registry.endPluginLoad();

        // Unwinding the load scope alone is not a rollback. A plugin that throws
        // part-way through setup has usually registered something already - a tool the
        // model can still call, a mount that still serves, a migration that still claims
        // its directory - and those registrations stay live, owned by nobody, with no
        // record left to unload later because this plugin never reached
        // _pluginRegistrations. The campaign plan requires a failed setup to roll back
        // its partial registrations, so undo them through the same path unloadPlugin()
        // uses.
        if (pluginName)
          await rollbackPartialLoad(registry, pluginName, { record, since: ownedBefore, logger });

        logger.warn?.(`Failed to load plugin at ${pluginPath}: ${error.message}`);
        // Keep the failure so the inventory can report it. Omission would make
        // "not installed" and "installed and broken" look identical.
        if (!registry._pluginLoadErrors) registry._pluginLoadErrors = [];
        // One entry per location, newest wins: a plugin that fails on every reload
        // must not grow this list without limit, and a stale failure for a location
        // that has since been fixed should not survive a later successful load.
        let location = pluginLocation(pluginPath);
        registry._pluginLoadErrors = registry._pluginLoadErrors
          .filter((e) => e.location !== location)
          .concat([{
            location,
            message: String(error?.message || error),
            at: new Date().toISOString(),
          }])
          .slice(-50);
      }
    }
  }

  return loaded;
}

// A configured path may be a single plugin module, a plugin directory, or a
// container of plugin directories. Expanding containers is what makes an
// in-repo plugins/ tree one ingestion site instead of requiring every child to
// be listed separately.
async function expandPluginPathSites(pluginPath) {
  let stat;
  try {
    stat = await fs.stat(pluginPath);
  } catch (_error) {
    return [ pluginPath ];
  }
  if (!stat.isDirectory())
    return [ pluginPath ];

  if (await hasPluginEntry(pluginPath))
    return [ pluginPath ];

  let children = [];
  try {
    let entries = await fs.readdir(pluginPath, { withFileTypes: true });
    for (let entry of entries) {
      if (!entry.isDirectory())
        continue;
      let child = path.join(pluginPath, entry.name);
      if (await hasPluginEntry(child))
        children.push(child);
    }
  } catch (_error) {}
  return children.length > 0 ? children : [ pluginPath ];
}

async function hasPluginEntry(pluginPath) {
  for (let entry of [ 'index.mjs', 'package.json' ]) {
    try {
      let stat = await fs.stat(path.join(pluginPath, entry));
      if (stat.isFile())
        return true;
    } catch (_error) {}
  }
  return false;
}

// Unload a plugin: run its teardown, pop its class overrides, and forget its
// registrations. Returns true if a plugin by that name was loaded.
// Run every loaded plugin's shutdown hooks, newest first, then its teardown.
// Never throws: one misbehaving plugin must not prevent the others from closing, and
// must not stop the process from exiting.
export async function shutdownPlugins(registry, { logger = console } = {}) {
  let map = registry?._pluginRegistrations;
  let records = map instanceof Map ? [...map.values()] : [];

  for (let record of [...records].reverse()) {
    let name = record?.pluginName || 'unknown';
    if (typeof record?.onShutdown === 'function') {
      try {
        await record.onShutdown();
      } catch (error) {
        logger.warn?.(`Plugin "${name}" onShutdown failed: ${error.message}`);
      }
    }
    if (typeof record?.teardown === 'function') {
      try {
        await record.teardown();
      } catch (error) {
        logger.warn?.(`Plugin "${name}" teardown failed: ${error.message}`);
      }
    }
  }
}

export async function unloadPlugin(registry, pluginName, { logger = console } = {}) {
  let record = removePluginRecord(registry, pluginName);
  if (!record)
    return false;

  // Plugin first, then the generic release. A teardown that throws must not stop the
  // registry from letting go: an unreleased mount keeps serving requests through a
  // handler whose plugin is gone, which is worse than a noisy shutdown.
  try {
    if (typeof record.teardown === 'function')
      await record.teardown();
  } catch (error) {
    logger.warn?.(`Plugin "${pluginName}" teardown failed: ${error.message}`);
  }

  // Subscriptions are keyed by plugin id in a bus the registry does not own the
  // lifecycle of, so they are dropped here rather than in releasePlugin().
  dropPluginSubscriptions(registry, pluginName);

  if (typeof registry.releasePlugin === 'function')
    await registry.releasePlugin(pluginName, { logger });

  // Class overrides (registerClass) are attributed by the ClassRegistry, not by the
  // ownership ledger, so they are popped separately.
  if (typeof registry.unregisterPlugin === 'function')
    registry.unregisterPlugin(pluginName);

  return true;
}

function agentProviderIDs(registry) {
  if (typeof registry.getAgentProviders !== 'function')
    return new Set();

  return new Set(registry.getAgentProviders().keys());
}

function registerPluginRecord(registry, record) {
  if (!registry._pluginRegistrations)
    registry._pluginRegistrations = new Map();

    // A duplicate name silently replaced the earlier plugin - data loss with no trace.
    // Refuse instead, and record it so the inventory can report it.
    let existing = registry._pluginRegistrations.get(record.pluginName);
    if (existing && existing.pluginPath !== record.pluginPath) {
      // Locations only: this message is served to unauthenticated callers.
      let message = 'plugin name "' + record.pluginName + '" is already registered as '
        + (existing.pluginLocation || 'unknown') + '; refusing ' + (record.pluginLocation || 'unknown');
      if (!registry._pluginLoadErrors) registry._pluginLoadErrors = [];
      registry._pluginLoadErrors = registry._pluginLoadErrors
        .filter((e) => e.location !== record.pluginLocation)
        .concat([{ location: record.pluginLocation, message, at: new Date().toISOString() }])
        .slice(-50);
      return message;
    }

  registry._pluginRegistrations.set(record.pluginName, record);
  return null;
}

// Undo a load that did not complete. Deliberately mirrors unloadPlugin(): teardown
// first, then subscriptions, then the ownership ledger, then class overrides. Every
// step is guarded, because a rollback that throws would mask the original failure and
// leave the caller with no idea why the plugin did not load.
async function rollbackPartialLoad(registry, pluginName, { record = null, since = 0, logger = console } = {}) {
  if (record && typeof record.teardown === 'function') {
    try {
      await record.teardown();
    } catch (error) {
      logger.warn?.(`Plugin "${pluginName}" teardown failed during rollback: ${error.message}`);
    }
  }

  dropPluginSubscriptions(registry, pluginName);

  try {
    if (typeof registry.releasePlugin === 'function')
      await registry.releasePlugin(pluginName, { logger, since });
  } catch (error) {
    logger.warn?.(`Plugin "${pluginName}" ownership release failed during rollback: ${error.message}`);
  }

  // Class overrides live on the ClassRegistry stack, which attributes by plugin name
  // only, so popping is only safe when this failed load is the first use of the name.
  if (!since && typeof registry.unregisterPlugin === 'function') {
    try {
      registry.unregisterPlugin(pluginName);
    } catch (error) {
      logger.warn?.(`Plugin "${pluginName}" class override release failed during rollback: ${error.message}`);
    }
  }
}

function dropPluginSubscriptions(registry, pluginName) {
  if (registry?._pluginEventBus && typeof registry._pluginEventBus.unsubscribe === 'function')
    registry._pluginEventBus.unsubscribe(pluginName);
}

function removePluginRecord(registry, pluginName) {
  let map = registry._pluginRegistrations;
  if (!map || !map.has(pluginName))
    return null;

  let record = map.get(pluginName);
  map.delete(pluginName);
  return record;
}

function pluginNameFromPath(pluginPath) {
  let normalized = String(pluginPath).replace(/[/\\]+$/g, '');
  let base = normalized.split(/[/\\]/).pop() || normalized;
  return base.replace(/\.[^.]+$/, '');
}

function createPluginSetupContext({ registry, commandRegistry, context, pluginPath, pluginName = null, onProvide = null }) {
  // Attribute class registrations to the loading plugin so overrides can be
  // popped by unregisterPlugin / unloadPlugin.
  let registerClass = (...args) => registry.registerClass(...attributeToPlugin(args, pluginName));

  let directContext = {
    registry,
    commandRegistry,
    context,
    pluginPath,
    pluginName,
    PluginInterface,
    AgentInterface,
    registerClass,
    registerTool: (...args) => registry.registerTool(...attributeToPlugin(args, pluginName)),
    mountHttp: (handler, options = {}) => registry.mountHttp(pluginName, handler, options),
    // Scoped database handle. Enforces the plugin's table prefix and refuses DDL.
    db: () => registry.getPluginDatabase(pluginName),
    // Deny-by-default capability check. A transport must call this before acting.
    authorize: (request) => registry.getPluginAuthority(pluginName).authorize(request),
    // Scoped events. A subscription must name the sessions it cares about; naming none
    // receives nothing. Safe to call before the runtime exists - it queues.
    // Drop a message into a session as a user frame. Real-time transports use this to
    // put an inbound message where the session's agents will see it.
    // Config access. Plugins must not read process.env directly - that bypasses the
    // ConfigStore and the architecture spec forbids it outside src/core/config.
    readConfig: (path, fallback = null) => {
      let store = context?.config || (typeof context?.require === 'function' && context.has?.('config') ? context.require('config') : null);
      if (!store || typeof store.get !== 'function') return Promise.resolve(fallback);
      return Promise.resolve(store.get(path)).then((v) => (v === undefined || v === null ? fallback : v));
    },
    appendToSessionQuietly: (sessionID, input) => {
      if (!registry._pluginFrameRuntime)
        throw new Error('appendToSessionQuietly called before the frame runtime was attached');
      return registry._pluginFrameRuntime.appendUserMessageQuietly(sessionID, input);
    },
    appendToSession: (sessionID, input) => {
      if (!registry._pluginFrameRuntime)
        throw new Error('appendToSession called before the frame runtime was attached');
      return registry._pluginFrameRuntime.appendUserMessage(sessionID, input);
    },
    subscribe: (handler, options = {}) => {
      if (!registry._pluginEventBus)
        throw new Error('subscribe() called before the plugin event bus was attached');
      return registry._pluginEventBus.subscribe(pluginName, handler, options);
    },
    registerService: (name, definition = {}, options = {}) =>
      registry.registerService(name, definition, withPluginName(options, pluginName)),
    registerPromptSection: (name, definition = {}, options = {}) =>
      registry.registerPromptSection(name, definition, withPluginName(options, pluginName)),
    registerLoopControl: (name, definition = {}, options = {}) =>
      registry.registerLoopControl(name, definition, withPluginName(options, pluginName)),
    registerMigrations: (options = {}) => {
      // A relative directory is resolved against the plugin, so a plugin never has to
      // know where it is installed.
      let directory = options.directory || 'sql';
      if (!path.isAbsolute(directory))
        directory = path.join(pluginPath, directory);
      return registry.registerMigrations(pluginName, { ...options, directory });
    },
    registerAgentProvider: (...args) => registry.registerAgentProvider(...attributeToPlugin(args, pluginName)),
    registerAgentType: (...args) => registry.registerAgentType(...attributeToPlugin(args, pluginName)),
    registerCommand: (...args) => {
      if (!commandRegistry)
        throw new Error('Command registry is not available in this plugin context');

      return commandRegistry.registerCommand(...args);
    },
    registerSelector: (...args) => registry.registerSelector(...attributeToPlugin(args, pluginName)),
    // Descriptor-taking registrations put the descriptor in the second slot and
    // options in the third (the fourth for registerComponent). A helper that always
    // writes slot 2 is correct only when the call has exactly two arguments; on a
    // three-argument call it replaces the caller options with { pluginName }, so the
    // registration lands unattributed and unloadPlugin() can never undo it.
    registerComponent: (kind, key, descriptor = {}, options = {}) =>
      registry.registerComponent(kind, key, descriptor, withPluginName(options, pluginName)),
    registerFrameComponent: (frameType, descriptor = {}, options = {}) =>
      registry.registerFrameComponent(frameType, descriptor, withPluginName(options, pluginName)),
    registerClientSurface: (kind, key, descriptor = {}, options = {}) =>
      registry.registerClientSurface(kind, key, descriptor, withPluginName(options, pluginName)),
    registerMainApp: (key, descriptor = {}, options = {}) =>
      registry.registerMainApp(key, descriptor, withPluginName(options, pluginName)),
    registerToolComponent: (toolName, descriptor = {}, options = {}) =>
      registry.registerToolComponent(toolName, descriptor, withPluginName(options, pluginName)),
    registerAgentConfigForm: (pluginID, descriptor = {}, options = {}) =>
      registry.registerAgentConfigForm(pluginID, descriptor, withPluginName(options, pluginName)),
    registerTagDefinition: (name, definition = {}, options = {}) =>
      registry.registerTagDefinition(name, definition, withPluginName(options, pluginName)),
    registerFrameIndex: (name, definition = {}, options = {}) =>
      registry.registerFrameIndex(name, definition, withPluginName(options, pluginName)),
    registerDatabaseDriver: (...args) => registry.registerDatabaseDriver(...attributeToPlugin(args, pluginName)),
  };

  return (callback) => {
    if (typeof callback === 'function') {
      onProvide?.(callback);
      return callback(directContext);
    }

    return directContext;
  };
}

// Descriptor-taking registrations carry options in the third slot, after the
// descriptor. Merge the plugin name into those options instead of splatting a new
// object into a fixed position.
function withPluginName(options, pluginName) {
  if (!pluginName)
    return options;

  let merged = (options && typeof options === 'object') ? options : {};
  return { pluginName: merged.pluginName || pluginName, ...merged };
}

// registerClass(...) may take options as the 2nd (class + options) or 3rd
// (key + class + options) argument. Inject pluginName only when absent.
function attributeToPlugin(args, pluginName) {
  if (!pluginName)
    return args;

  let next = args.slice();
  if (typeof next[0] === 'string') {
    let options = (next[2] && typeof next[2] === 'object') ? next[2] : {};
    next[2] = { pluginName, ...options };
  } else {
    let options = (next[1] && typeof next[1] === 'object') ? next[1] : {};
    next[1] = { pluginName, ...options };
  }

  return next;
}

function normalizePluginPaths(pluginPaths) {
  if (Array.isArray(pluginPaths))
    return pluginPaths.filter(Boolean);

  if (!pluginPaths || typeof pluginPaths !== 'string')
    return [];

  return pluginPaths
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function resolvePluginModule(pluginPath) {
  let stat = await fs.stat(pluginPath);
  if (stat.isFile())
    return pluginPath;

  let packageJSONPath = path.join(pluginPath, 'package.json');
  try {
    let packageJSON = JSON.parse(await fs.readFile(packageJSONPath, 'utf8'));
    return path.join(pluginPath, packageJSON.main || 'index.mjs');
  } catch (_error) {
    return path.join(pluginPath, 'index.mjs');
  }
}
