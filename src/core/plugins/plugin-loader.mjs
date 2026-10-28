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
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
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
      try {
        let modulePath = await resolvePluginModule(pluginPath);
        let pluginModule = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);

        if (typeof pluginModule.setup !== 'function')
          continue;

        let pluginName = pluginModule.pluginName || pluginNameFromPath(pluginPath);

        // A successful load clears any stale failure for this location, so a
        // fixed plugin stops being reported as broken.
        if (registry._pluginLoadErrors?.length) {
          let loc = pluginLocation(pluginPath);
          registry._pluginLoadErrors = registry._pluginLoadErrors.filter((e) => e.location !== loc);
        }
        let record = { pluginPath, pluginName, modulePath, pluginLocation: pluginLocation(pluginPath), callbacks: [], teardown: null };
        record.manifest = await readPluginManifest(pluginPath);
        let providerIDsBefore = agentProviderIDs(registry);
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
            await withTimeout(
              Promise.resolve(record.onInit()),
              SETUP_TIMEOUT_MS,
              `Plugin "${pluginName}" onInit did not finish within ${SETUP_TIMEOUT_MS}ms`,
            );
          } catch (error) {
            logger.error?.(`Plugin "${pluginName}" onInit failed: ${error.message}`);
            throw error;
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

        registerPluginRecord(registry, record);
        loaded.push({ path: pluginPath, modulePath, pluginName });
      } catch (error) {
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

  try {
    if (typeof record.teardown === 'function')
      await record.teardown();
  } catch (error) {
    logger.warn?.(`Plugin "${pluginName}" teardown failed: ${error.message}`);
  }

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
      return false;
    }

  registry._pluginRegistrations.set(record.pluginName, record);
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
    registerTool: (...args) => registry.registerTool(...args),
    mountHttp: (handler) => registry.mountHttp(pluginName, handler),
    // Scoped events. A subscription must name the sessions it cares about; naming none
    // receives nothing. Safe to call before the runtime exists - it queues.
    subscribe: (handler, options = {}) => {
      if (!registry._pluginEventBus)
        throw new Error('subscribe() called before the plugin event bus was attached');
      return registry._pluginEventBus.subscribe(pluginName, handler, options);
    },
    registerMigrations: (options = {}) => {
      // A relative directory is resolved against the plugin, so a plugin never has to
      // know where it is installed.
      let directory = options.directory || 'sql';
      if (!path.isAbsolute(directory))
        directory = path.join(pluginPath, directory);
      return registry.registerMigrations(pluginName, { ...options, directory });
    },
    registerAgentProvider: (...args) => registry.registerAgentProvider(...args),
    registerAgentType: (...args) => registry.registerAgentType(...args),
    registerCommand: (...args) => {
      if (!commandRegistry)
        throw new Error('Command registry is not available in this plugin context');

      return commandRegistry.registerCommand(...args);
    },
    registerSelector: (...args) => registry.registerSelector(...args),
    registerComponent: (...args) => registry.registerComponent(...args),
    registerFrameComponent: (...args) => registry.registerFrameComponent(...args),
    registerToolComponent: (...args) => registry.registerToolComponent(...args),
    registerAgentConfigForm: (...args) => registry.registerAgentConfigForm(...args),
    registerTagDefinition: (...args) => registry.registerTagDefinition(...args),
    registerDatabaseDriver: (...args) => registry.registerDatabaseDriver(...args),
  };

  return (callback) => {
    if (typeof callback === 'function') {
      onProvide?.(callback);
      return callback(directContext);
    }

    return directContext;
  };
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
