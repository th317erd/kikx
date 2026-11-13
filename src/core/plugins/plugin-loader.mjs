import crypto from 'node:crypto';
'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentInterface } from './agent-interface.mjs';
import { invalidatePluginModules, registerReloadablePluginRoot } from './plugin-module-cache.mjs';
import { PluginInterface } from './plugin-interface.mjs';
import { admitPluginDirectory, parseSigningPublicKeys } from './plugin-signature.mjs';
import { normalizePluginID } from '../properties/grants.mjs';
import { pluginPropertiesAPI } from '../properties/facade.mjs';
import { PropertyStoreError } from '../properties/store.mjs';
import { snapshotEnvironment } from '../config/env-loader.mjs';

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
// Exported (plan 9.1.1): the inventory renders DISABLED plugins from their
// stored location file, and locations must never leave the server as paths —
// the same display token loaded records use.
export function pluginLocation(pluginPath) {
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
    // ENABLE/DISABLE TOGGLE (campaign 9.1.2): plugin DIRECTORY BASNAMES to
    // skip silently — before the signature gate and the import, so a disabled
    // plugin never executes and never lands in the failure list (absent by
    // CHOICE, not broken). Array or Set; null/empty = old behaviour.
    disabledNames = null,
  } = options;

  if (!registry)
    throw new TypeError('loadPlugins() requires registry');

  registry.registerClass('AgentInterface', AgentInterface, { pluginName: 'core' });
  registry.registerClass('PluginInterface', PluginInterface, { pluginName: 'core' });

  // S4: enforcement resolved ONCE per load pass. The config service is the
  // same seam routes use; process.env is the fallback for bare embedders and
  // test harnesses — but ONLY for fields the config service did not answer
  // (an explicit empty key list from config must never fall through to env).
  // Defaults are FAIL-CLOSED: 'required', zero keys.
  let signatureMode = 'required';
  let signingKeyMaterial = '';
  let modeFromConfig = false;
  let keysFromConfig = false;
  try {
    const config = context && typeof context.has === 'function' && context.has('config')
      ? context.require('config')
      : null;
    if (config && typeof config.get === 'function') {
      const { KIKX_PLUGIN_SIGNATURE_MODE_PATH, KIKX_PLUGIN_SIGNING_PUBLIC_KEYS_PATH } =
        await import('../config/config-paths.mjs');
      const mode = await config.get(KIKX_PLUGIN_SIGNATURE_MODE_PATH);
      const keys = await config.get(KIKX_PLUGIN_SIGNING_PUBLIC_KEYS_PATH);
      if (typeof mode === 'string' && mode.trim() !== '') {
        signatureMode = mode.trim();
        modeFromConfig = true;
      }
      if (typeof keys === 'string') {
        signingKeyMaterial = keys;
        keysFromConfig = true;
      }
    }
  } catch { /* fall through to the environment for unanswered fields */ }
  if (!modeFromConfig || !keysFromConfig) {
    // Ambient reads go through the sanctioned snapshot accessor — the
    // no-process-env gate keeps raw `process.env` inside core/config only.
    const env = snapshotEnvironment();
    if (!modeFromConfig) {
      const ambientMode = typeof env.KIKX_PLUGIN_SIGNATURE_MODE === 'string'
        ? env.KIKX_PLUGIN_SIGNATURE_MODE.trim() : '';
      signatureMode = ambientMode || 'required';
    }
    if (!keysFromConfig)
      signingKeyMaterial = env.KIKX_PLUGIN_SIGNING_PUBLIC_KEYS || '';
  }
  const signingPublicKeys = parseSigningPublicKeys(signingKeyMaterial);
  // LOUD by contract (plan §5-S4): unsafe mode is a development bypass and
  // must never be mistaken for enforcement — the inventory also reports it and
  // Settings → Plugins renders a banner.
  if (signatureMode === 'unsafe')
    logger.warn?.('[kikx] plugin signature verification DISABLED (KIKX_PLUGIN_SIGNATURE_MODE=unsafe) — development mode only; production must run required');

  let disabledSkipKeys = disabledNames instanceof Set
    ? disabledNames
    : (Array.isArray(disabledNames) ? new Set(disabledNames) : null);

  let loaded = [];
  for (let configuredPath of normalizePluginPaths(pluginPaths)) {
    for (let pluginPath of await expandPluginPathSites(configuredPath)) {
      // Skipped BEFORE the signature gate: a disabled plugin produces neither
      // a refusal entry nor an import — it is intentionally not loaded.
      if (disabledSkipKeys && disabledSkipKeys.has(pluginNameFromPath(pluginPath)))
        continue;
      // Declared outside the try so a failure part-way through can roll back what
      // this iteration already registered.
      let pluginName = null;
      let record = null;
      let ownedBefore = 0;
      // Plan P2 — properties grants: parsed from manifest.json (the file the
      // S4 envelope signs), registered BEFORE import/setup, rolled back in the
      // catch below if the load dies afterwards.
      let manifestPluginID = null;
      let grantsRegistry = null;
      let grantsRegistered = false;
      try {
        // HARD BOUNDARY: nothing a plugin does may escape this iteration.
        // Not a throw, not a rejection, not a timer that never fires.
        //
        // S4 SIGNATURE GATE — BEFORE resolve/import, so refused code never
        // executes. Every loader call site (engine startup, POST /install,
        // POST /reload) funnels through here, which is what makes the gate a
        // property of the platform rather than of each caller.
        let signatureRefusal = await admitPluginDirectory(pluginPath, {
          mode: signatureMode,
          publicKeys: signingPublicKeys,
        });
        if (signatureRefusal) {
          let refusedLocation = pluginLocation(pluginPath);
          if (!registry._pluginLoadErrors) registry._pluginLoadErrors = [];
          registry._pluginLoadErrors = registry._pluginLoadErrors
            .filter((e) => e.location !== refusedLocation)
            .concat([{ location: refusedLocation, message: signatureRefusal, at: new Date().toISOString() }])
            .slice(-50);
          logger.warn?.(`Refused plugin at ${pluginPath}: ${signatureRefusal}`);
          continue;
        }

        // Plan P2 — properties grants. manifest.json is the EXACT file the S4
        // signature envelope signs (payload = its bytes), so pluginID/access
        // parsed here are tamper-proof by admission. Parsed + registered BEFORE
        // import/setup: setup may use ctx.properties, and a malformed block
        // refuses before any plugin code runs.
        if (context && typeof context.has === 'function' && typeof context.require === 'function')
          grantsRegistry = context.has('propertiesGrants') ? context.require('propertiesGrants') : null;
        const propertiesManifest = await readPluginManifestDocument(pluginPath);
        if (propertiesManifest
          && (propertiesManifest.access !== undefined || propertiesManifest.pluginID !== undefined
            || propertiesManifest.properties !== undefined)) {
          if (propertiesManifest.pluginID === undefined)
            throw new PropertyStoreError('property_plugin_id_invalid',
              'manifest.json declares access/properties but no pluginID — grants need an owner');
          manifestPluginID = normalizePluginID(propertiesManifest.pluginID);
          if (grantsRegistry) {
            // Schemas normalize ATOMICALLY with access (P6): a malformed
            // `properties` block registers nothing and refuses the load.
            grantsRegistry.register(manifestPluginID, propertiesManifest.access, pluginPath,
              propertiesManifest.properties ?? null);
            grantsRegistered = true;
          }
        }

        let modulePath = await resolvePluginModule(pluginPath);

        // RELOAD MEANS RELOAD THE WHOLE PLUGIN, NOT JUST ITS ENTRY FILE.
        // The entry import below is cache-busted with ?t=, which re-parses
        // index.mjs and NOTHING ELSE: every `import ... from './other.mjs'`
        // inside it resolves to a plain URL that Node caches for the life of the
        // process. A reload therefore re-ran the entry against the OLD submodules
        // and returned 200 with no failures, so a plugin author's change to any
        // file but the entry silently never ran. Measured live: an image-only
        // Discord message was still dropped after reloading the fix that delivers
        // it. See plugin-module-cache.mjs for the reproduction.
        //
        // The plugin root is registered so the hook can recognise this plugin's
        // files, then invalidated so the next import of anything under it (entry
        // included, via static imports) is re-read from disk. Only URLs under a
        // registered plugin root are rewritten -- core and other plugins are
        // untouched.
        registerReloadablePluginRoot(pluginPath);
        invalidatePluginModules(pluginPath);
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
        record = { pluginPath, pluginName, modulePath, pluginLocation: pluginLocation(pluginPath), callbacks: [], teardown: null, pluginID: manifestPluginID };
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
            pluginID: manifestPluginID,
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

        // Grants were registered BEFORE setup (P2), so a load that dies later
        // must release them — a plugin that never loaded keeps no permissions.
        if (grantsRegistered && grantsRegistry && manifestPluginID)
          grantsRegistry.unregister(manifestPluginID, pluginPath);

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

  // Plan P2: release this record's grants — covers reload, disable AND
  // uninstall (a lingering entry would also make a reinstall collide with a
  // ghost). Path-guarded inside unregister(), so an impostor path cannot
  // release a legitimate plugin's grants.
  if (record.pluginID && registry._propertiesGrants)
    registry._propertiesGrants.unregister(record.pluginID, record.pluginPath);

  // onShutdown first, and it is not optional.
  //
  // A plugin that returns an object from setup() may declare onShutdown; the Discord
  // plugin opens a gateway websocket in onInit and closes it there. unloadPlugin() is
  // the path a RELOAD takes (loadPlugins unloads an already-registered path before
  // re-importing it), so while this hook was skipped, every reload started another
  // gateway and retired none. On the live 3003 instance that produced four concurrent
  // backoff loops against one bot token, Discord closing the duplicates with code 4000,
  // and the same MESSAGE_CREATE framed twice because two live gateways both saw it.
  // shutdownPlugins() always called this hook; only the reload path forgot it.
  //
  // Its own try/catch, and before teardown: stopping live work (sockets, timers) must
  // not depend on teardown succeeding, and must not be skipped because it threw.
  try {
    if (typeof record.onShutdown === 'function')
      await record.onShutdown();
  } catch (error) {
    logger.warn?.(`Plugin "${pluginName}" onShutdown failed: ${error.message}`);
  }

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

// The S4 signature covers manifest.json BYTES (plugin-signature.mjs); this
// reads the same file for the properties grants block (plan P2). Absent file
// = null (legacy plugins load unchanged); a malformed file refuses the load.
// ENOTDIR too: a configured plugin path may be a SINGLE FILE module
// (expandPluginPathSites), which has no manifest.json beside it.
async function readPluginManifestDocument(pluginPath) {
  try {
    return JSON.parse(await fs.readFile(path.join(pluginPath, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      return null;
    throw new PropertyStoreError('property_grant_invalid',
      `plugin manifest.json is unreadable or malformed: ${error.message}`);
  }
}

function createPluginSetupContext({ registry, commandRegistry, context, pluginPath, pluginName = null, pluginID = null, onProvide = null }) {
  // Attribute class registrations to the loading plugin so overrides can be
  // popped by unregisterPlugin / unloadPlugin.
  let registerClass = (...args) => registry.registerClass(...attributeToPlugin(args, pluginName));

  let directContext = {
    registry,
    commandRegistry,
    context,
    pluginPath,
    pluginName,
    // Plan P2: the ONLY non-core path to properties, bound to this plugin's
    // caller class. A null facade (direct loadPlugins harnesses) or an
    // undeclared pluginID refuses PER CALL, never at context creation — so
    // neither can break a load.
    properties: pluginPropertiesAPI(
      context && typeof context.has === 'function' && typeof context.require === 'function'
      && context.has('propertiesFacade') ? context.require('propertiesFacade') : null,
      pluginID),
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
    // Write a frame of a frame type this plugin registered.
    //
    // Same trust level as appendToSession - both put a message into a session and
    // wake its agents - but unlike appendToSession the type is not hardcoded to
    // UserMessage. A transport that is not the owner needs this: writing a Discord
    // message as a UserMessage is what made the owner's own words appear to come
    // from him. The frame type and its agent-only flag are resolved from the
    // registered class, so a caller cannot choose either.
    appendFrame: (sessionID, input) => {
      if (!registry._pluginFrameRuntime)
        throw new Error('appendFrame called before the frame runtime was attached');
      return registry._pluginFrameRuntime.appendFrame(sessionID, input);
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
