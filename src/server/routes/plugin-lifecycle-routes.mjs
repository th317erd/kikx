'use strict';

// The lifecycle surface — POST /api/v1/plugins/uninstall (plan 9.1.1 —
// approved in full 2026-11-05: managed dirs only, built-ins never, durable
// plugin data retained) and POST /api/v1/plugins/set-enabled (plan 9.1.2 —
// disable persists + unloads, not config-gated; enable loads from the stored
// location under install's config gate with rollback-to-disabled on any
// failure). Extracted from plugin-routes.mjs under the source line limits;
// the shared helpers below (managed roots, location lookup, config gate)
// move WITH the branches, and managedPluginRoots stays exported because the
// inventory classifies against the same ground.

import fs from 'node:fs';
import path from 'node:path';

import { readBoundedJsonBody } from './bounded-json-body.mjs';
import { PLUGIN_ADMIN_ACTIONS, requireOperator } from './plugin-admin-policy.mjs';

// Managed ground (S3/9.1.1): configured paths ∪ durable runtime list ∪ npm
// landing root — every place a location can legitimately come from. Unknown
// roots fail closed (never managed). Null only if config blows up, so callers
// can fall back to the plain configured list.
export async function managedPluginRoots(config) {
  try {
    const { mergePluginPaths, resolveNpmPluginBase } = await import('../../core/plugins/plugin-paths.mjs');
    const { runtimePathsForConfig, runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
    const { KIKX_PLUGIN_PATHS_PATH, KIKX_PLUGIN_NPM_DIR_PATH } = await import('../../core/config/config-paths.mjs');
    const configured = config && typeof config.get === 'function' ? await config.get(KIKX_PLUGIN_PATHS_PATH) : '';
    const npmDir = config && typeof config.get === 'function' ? await config.get(KIKX_PLUGIN_NPM_DIR_PATH) : undefined;
    const cwd = await runtimeRootForConfig(config);
    return mergePluginPaths(
      configured || [],
      await runtimePathsForConfig(config),
      resolveNpmPluginBase({ npmDir, cwd }),
    );
  } catch (_e) { return null; }
}

// Where a plugin's directory is, learned in order: live record → disabled
// set → runtime path list by basename. The last leg is what lets a retry
// finish an uninstall whose first attempt failed AFTER the record was already
// removed (the orphaned-directory case the uninstall spec pins).
async function locatePluginDirectory(name, record, cwd) {
  if (record && typeof record.pluginPath === 'string' && record.pluginPath)
    return record.pluginPath;
  try {
    const { getDisabledPlugin } = await import('../../core/config/runtime-disabled-plugins.mjs');
    const entry = getDisabledPlugin(name, { cwd });
    if (entry && entry.location)
      return entry.location;
  } catch (_e) { /* fall through to the runtime list */ }
  try {
    const { readRuntimePluginPaths } = await import('../../core/config/runtime-plugin-paths.mjs');
    return readRuntimePluginPaths({ cwd }).find((p) => path.basename(p) === name) || null;
  } catch (_e) { return null; }
}

async function installGateEnabled(config) {
  try {
    if (config && typeof config.get === 'function') {
      const { KIKX_PLUGIN_INSTALL_ENABLED_PATH } = await import('../../core/config/config-paths.mjs');
      const value = await config.get(KIKX_PLUGIN_INSTALL_ENABLED_PATH);
      return value === true || value === 'true' || value === '1';
    }
  } catch (_e) { /* fail closed */ }
  return false;
}

// Uninstall (plan 9.1.1 — APPROVED in full 2026-11-05: managed dirs only,
// built-ins never, durable plugin data retained). Identity first, config
// gate second — the plan's "same operator + config gates" as install. Then:
// learn the directory (record → disabled set → runtime list by basename),
// re-verify managed ground AT DELETE TIME (a tampered disabled file must
// not aim deletion at arbitrary paths), unload FIRST, delete AFTER — the
// ordering is asserted by a fixture that records directory existence from
// inside its own teardown.
export async function handlePluginUninstall({ request, response, context }) {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.UNINSTALL);
    let config = context.has?.('config') ? context.require('config') : null;
    if (!await installGateEnabled(config)) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: {
          message: 'plugin install is disabled (set KIKX_PLUGIN_INSTALL_ENABLED=true to manage plugin files)',
          hint: 'set KIKX_PLUGIN_INSTALL_ENABLED=true to allow installing code at runtime',
        },
      }));
      return true;
    }
    const body = await readBoundedJsonBody(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'uninstall requires a plugin name' } }));
      return true;
    }
    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    if (!registry) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin registry unavailable' } }));
      return true;
    }
    const map = registry._pluginRegistrations;
    const record = map instanceof Map ? map.get(name) : null;
    const { runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
    const cwd = await runtimeRootForConfig(config);
    const location = await locatePluginDirectory(name, record, cwd);
    if (!location) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: { message: `plugin "${name}" is not installed` },
        data: { name, loaded: map instanceof Map ? [ ...map.keys() ] : [] },
      }));
      return true;
    }
    const roots = (await managedPluginRoots(config)) ?? '';
    const { isManagedPluginLocation } = await import('../../core/plugins/plugin-paths.mjs');
    if (!isManagedPluginLocation(location, { configuredPaths: roots })) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: { message: 'Internal Plugin — cannot be uninstalled' },
        data: { name },
      }));
      return true;
    }
    let unloaded = false;
    if (record) {
      try {
        const { unloadPlugin } = await import('../../core/plugins/plugin-loader.mjs');
        const removed = await unloadPlugin(registry, name, { logger: console });
        if (removed === false) {
          response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({
            error: { message: `plugin "${name}" could not be unloaded` },
            data: { name, unloaded: false, removed: false },
          }));
          return true;
        }
        unloaded = true;
      } catch (error) {
        // The record may already be gone (unloadPlugin removes it first) — the
        // directory stays, and the runtime-list leg of locatePluginDirectory
        // lets the NEXT attempt finish the job instead of orphaning files.
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          error: { message: String(error?.message || error) },
          data: { name, unloaded: false, removed: false },
        }));
        return true;
      }
    }
    try {
      fs.rmSync(location, { recursive: true, force: true });
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: { message: `plugin files could not be removed: ${String(error?.message || error)}` },
        data: { name, unloaded, removed: false },
      }));
      return true;
    }
    try {
      const { removeRuntimePluginPath } = await import('../../core/config/runtime-plugin-paths.mjs');
      const { removePluginDisabled } = await import('../../core/config/runtime-disabled-plugins.mjs');
      removeRuntimePluginPath(location, { cwd });
      removePluginDisabled(name, { cwd });
    } catch (error) {
      console.warn('[plugin-uninstall] bookkeeping failed:', error?.message);
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ data: { name, unloaded, removed: true } }));
    return true;
}

// Enable/disable (plan 9.1.2, decided in scope): disable persists the flag
// + unloads (identity gate only); enable reloads from the stored location
// under install's config gate, with rollback-to-disabled on any failure.
export async function handlePluginSetEnabled({ request, response, context }) {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.SET_ENABLED);
    let config = context.has?.('config') ? context.require('config') : null;
    const body = await readBoundedJsonBody(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : null;
    if (!name || enabled === null) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'set-enabled requires a plugin name and a boolean enabled' } }));
      return true;
    }
    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    if (!registry) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin registry unavailable' } }));
      return true;
    }
    const { runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
    const { getDisabledPlugin, setPluginDisabled, disabledSkipKeys } =
      await import('../../core/config/runtime-disabled-plugins.mjs');
    const cwd = await runtimeRootForConfig(config);
    const map = registry._pluginRegistrations;
    const record = map instanceof Map ? map.get(name) : null;

    if (enabled === false) {
      const existing = getDisabledPlugin(name, { cwd });
      if (!record && !existing) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: `plugin "${name}" is not loaded` } }));
        return true;
      }
      const location = (record && record.pluginPath) || existing.location;
      setPluginDisabled(name, location, true, { cwd });
      let unloaded = false;
      if (record) {
        try {
          const { unloadPlugin } = await import('../../core/plugins/plugin-loader.mjs');
          const removed = await unloadPlugin(registry, name, { logger: console });
          if (removed === false) throw new Error(`plugin "${name}" could not be unloaded`);
          unloaded = true;
        } catch (error) {
          // Roll the flag back: a disable that did not unload must not leave
          // the file claiming something the registry disagrees with.
          setPluginDisabled(name, location, false, { cwd });
          response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
          return true;
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ data: { name, enabled: false, unloaded } }));
      return true;
    }

    const entry = getDisabledPlugin(name, { cwd });
    if (!entry) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: `plugin "${name}" is not disabled` } }));
      return true;
    }
    if (!await installGateEnabled(config)) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: {
          message: 'plugin install is disabled (set KIKX_PLUGIN_INSTALL_ENABLED=true to load plugin code)',
          hint: 'set KIKX_PLUGIN_INSTALL_ENABLED=true to allow installing code at runtime',
        },
      }));
      return true;
    }
    const roots = (await managedPluginRoots(config)) ?? '';
    const { isManagedPluginLocation } = await import('../../core/plugins/plugin-paths.mjs');
    if (!isManagedPluginLocation(entry.location, { configuredPaths: roots })) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin location is outside managed ground — cannot be enabled' } }));
      return true;
    }
    // Clear BEFORE the load (the loader skips disabled basenames), restore on
    // every failure path below.
    setPluginDisabled(name, entry.location, false, { cwd });
    let loadedList = [];
    try {
      const { loadPlugins } = await import('../../core/plugins/plugin-loader.mjs');
      loadedList = await loadPlugins({
        pluginPaths: entry.location,
        registry,
        commandRegistry: context.require('commandRegistry'),
        context,
        disabledNames: disabledSkipKeys({ cwd }),
      });
    } catch (error) {
      setPluginDisabled(name, entry.location, true, { cwd });
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
      return true;
    }
    if (!loadedList.length) {
      setPluginDisabled(name, entry.location, true, { cwd });
      const failures = registry._pluginLoadErrors || [];
      const message = failures.length ? failures[failures.length - 1].message : 'plugin failed to load';
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: { message },
        data: { name, enabled: false, loaded: false },
      }));
      return true;
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ data: { name, enabled: true, loaded: true } }));
    return true;
}
