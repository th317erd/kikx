'use strict';

// Routes /api/plugins/<id>/... to the plugin that owns that mount.
// Returns false when the path is not under a plugin mount, so the built-in chain continues.


import { readBoundedJsonBody } from './bounded-json-body.mjs';
import { handlePluginInstall } from './plugin-install-routes.mjs';
import {
  managedPluginRoots,
  handlePluginUninstall,
  handlePluginSetEnabled,
} from './plugin-lifecycle-routes.mjs';

import { PLUGIN_ADMIN_ACTIONS, requireOperator } from './plugin-admin-policy.mjs';
// Registry seams shared by the three S3 branches (search/updates/install):
// configured base URLs (config, never hardcoded — §10) and the injected fetch
// (pluginNpmRegistryFetch) that keeps tests off the real network.
async function configuredRegistryUrls(config) {
  try {
    if (config && typeof config.get === 'function') {
      const { KIKX_PLUGIN_REGISTRY_URLS_PATH } = await import('../../core/config/config-paths.mjs');
      return await config.get(KIKX_PLUGIN_REGISTRY_URLS_PATH);
    }
  } catch (_e) { /* fall back to the default registry */ }
  return undefined;
}

function registryFetchSeam(context) {
  return context.has?.('pluginNpmRegistryFetch') ? context.require('pluginNpmRegistryFetch') : globalThis.fetch;
}

export async function handlePluginRoutes({ request, response, url, context, json, rawBody }) {
  let router = null;
  try {
    router = context.has?.('pluginRouter') ? context.require('pluginRouter') : null;
  } catch (_error) {
    router = null;
  }

  if (!router || typeof router.match !== 'function')
    return false;

  // Plugin inventory. Read-only, but NOT public: it discloses which plugins are loaded,
  // their directory names, and which ones failed to load. Gated before the body is read.
  if (url.pathname === '/api/v1/plugins' && request.method === 'GET') {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.INVENTORY);

    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    // P6 disclosure (plan §4): grants/schemas ride the registry populated from
    // the SIGNED manifest.json parse at admission — never a re-read of disk.
    let grantsRegistry = context.has?.('propertiesGrants') ? context.require('propertiesGrants') : null;
    let map = registry?._pluginRegistrations;
    let records = map instanceof Map ? [...map.values()] : [];
    let bus = context.has?.('pluginEventBus') ? context.require('pluginEventBus') : null;
    let routerForList = context.has?.('pluginRouter') ? context.require('pluginRouter') : null;
    // Mount descriptors keyed once, so each plugin row can report the auth declaration
    // and the limits actually enforced on it. Campaign 4.3 says a public mount "must be
    // declared and reviewed"; that is only reviewable if the declaration is visible to
    // an operator without reading the plugin's source.
    let mountsById = new Map((routerForList?.listMounts?.() || []).map((m) => [ m.pluginId, m ]));
    // S2: every record says whether its location is MANAGED (operator-owned
    // configured path) — bundled platform code is not, and the card's
    // "Internal Plugin — cannot be uninstalled" notice plus the future
    // uninstall gate both read this. Classification fails CLOSED: an unknown
    // root is never managed.
    let configuredPaths = null;
    let config = context.has?.('config') ? context.require('config') : null;
    // Reported alongside the inventory so Settings → Plugins can show the
    // unsafe-mode banner from the same authoritative answer the gate uses.
    let signatureMode = null;
    try {
      if (config && typeof config.get === 'function') {
        const { KIKX_PLUGIN_PATHS_PATH, KIKX_PLUGIN_SIGNATURE_MODE_PATH } = await import('../../core/config/config-paths.mjs');
        configuredPaths = await config.get(KIKX_PLUGIN_PATHS_PATH);
        const mode = await config.get(KIKX_PLUGIN_SIGNATURE_MODE_PATH);
        if (typeof mode === 'string' && mode.trim() !== '')
          signatureMode = mode.trim();
      }
    } catch (_e) { configuredPaths = null; }
    if (signatureMode === null) {
      const { snapshotEnvironment } = await import('../../core/config/env-loader.mjs');
      const ambient = snapshotEnvironment();
      const fromEnv = typeof ambient.KIKX_PLUGIN_SIGNATURE_MODE === 'string'
        ? ambient.KIKX_PLUGIN_SIGNATURE_MODE.trim() : '';
      signatureMode = fromEnv || 'required';
    }
    const { isManagedPluginLocation } = await import('../../core/plugins/plugin-paths.mjs');
    let managedRoots = await managedPluginRoots(config);
    if (managedRoots === null) managedRoots = configuredPaths;
    // Provenance lookup (plan 10.4): install-time tag, absent = null.
    let tagsStore = context.has?.('tagsStore') ? context.require('tagsStore') : null;
    async function sourceFor(name) {
      if (!tagsStore || typeof tagsStore.getTag !== 'function') return null;
      try {
        const tag = await tagsStore.getTag({ target_type: 'plugin', target_id: name, name: 'source' });
        return JSON.parse(tag.value);
      } catch { return null; }
    }
    // Disabled plugins (plan 9.1.2) render as cards too — they are not in the
    // registrations, so the disabled file IS their inventory. Locations wear
    // the same display token as loaded records; never the raw path.
    let disabledPlugins = [];
    try {
      const { readDisabledPlugins } = await import('../../core/config/runtime-disabled-plugins.mjs');
      const { runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
      const { pluginLocation } = await import('../../core/plugins/plugin-loader.mjs');
      const disabledCwd = await runtimeRootForConfig(config);
      disabledPlugins = readDisabledPlugins({ cwd: disabledCwd }).map((entry) => ({
        name: entry.name,
        location: pluginLocation(entry.location),
        managed: isManagedPluginLocation(entry.location, { configuredPaths: managedRoots ?? configuredPaths }),
      }));
    } catch (_e) { disabledPlugins = []; }

    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      data: {
        plugins: await Promise.all(records.map(async (r) => ({
          name: r.pluginName,
          // Directories only, never absolute paths: an authenticated caller still does not
          // need the operator's filesystem layout.
          location: r.pluginLocation || null,
          // S3 (plan 10.4): provenance recorded at install time, plus whether
          // the load proves a signature: 'required' mode means the gate inside
          // loadPlugins admitted it (loaded = verified → true); 'unsafe' proves
          // nothing, reported honestly as unknown (null).
          source: await sourceFor(r.pluginName),
          signed: signatureMode === 'required' ? true : null,
          // Managed classification runs on the REAL directory (pluginPath),
          // never the display token: inventory location is deliberately
          // `basename#hash`, which resolves under no root and would fail
          // closed forever. pluginPath stays out of the response — the
          // operator's filesystem layout is not disclosed by listing.
          managed: isManagedPluginLocation(r.pluginPath, { configuredPaths: managedRoots ?? configuredPaths }),
          mounted: mountsById.has(r.pluginName),
          mount: mountsById.has(r.pluginName)
            ? {
              auth: mountsById.get(r.pluginName).auth ?? null,
              maxBodyBytes: mountsById.get(r.pluginName).maxBodyBytes ?? null,
              handlerTimeoutMS: mountsById.get(r.pluginName).handlerTimeoutMS ?? null,
            }
            : null,
          subscriptions: bus?.list?.().find((s) => s.pluginId === r.pluginName) || null,
          manifest: r.manifest || null,
          properties: r.pluginID && grantsRegistry
            ? (() => {
              const entry = grantsRegistry.get(r.pluginID);
              if (!entry) return null;
              return {
                pluginID: r.pluginID,
                read: entry.access.read.allow.slice(),
                write: entry.access.write.allow.slice(),
                declaredKeys: entry.schemas ? Object.keys(entry.schemas) : [],
              };
            })()
            : null,
        }))),
        // Disabled plugins (9.1.2): name + display token + managed flag — the
        // section renders Enable/Uninstall cards from this list.
        disabledPlugins,
        failures: registry?._pluginLoadErrors || [],
        signatureMode,
        // A class override does not change a live instance (campaign §8.1.5). create-server
        // resolves FrameRouter before plugins load, so a plugin override of it changes the
        // registry row while the router that is serving requests keeps executing core. Listing
        // those keys here is the difference between "the platform says it is overridden" and
        // "the platform says this needs a restart to become true".
        restartRequired: typeof registry.listRestartRequired === 'function'
          ? registry.listRestartRequired()
          : [],
        // Keys a plugin overrode where nothing in the running system resolves through
        // the class registry (interface base classes imported and `extends`-ed,
        // frame-type keys no production caller passes a registry for). Distinct from
        // restartRequired on purpose: a restart cannot make these take effect, so
        // reporting them there would promise a fix the platform cannot deliver.
        inertOverrides: typeof registry.listInertOverrides === 'function'
          ? registry.listInertOverrides()
          : [],
      },
    }));
    return true;
  }

  // Browse search (campaign S3, plan 5-S3): npm registry /-/v1/search scoped
  // to the owner-confirmed `kikx-plugin` keyword. Gated with INVENTORY — it
  // discloses nothing local, but it is an operator surface. Registry access
  // goes through the same injected seam installs use (pluginNpmRegistryFetch).
  if (url.pathname === '/api/v1/plugins/search' && request.method === 'GET') {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.INVENTORY);

    const q = (url.searchParams.get('q') || '').trim();
    if (!q || q.length > 100) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'search requires q (1-100 characters)' } }));
      return true;
    }
    const config = context.has?.('config') ? context.require('config') : null;
    const registryUrls = await configuredRegistryUrls(config);
    const fetchImpl = registryFetchSeam(context);
    const { searchPlugins, SEARCH_KEYWORD } = await import('../../core/plugins/npm-registry.mjs');
    let result;
    try {
      result = await searchPlugins({ q, registryUrls, fetchImpl });
    } catch (error) {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: `registry search failed: ${String(error?.error || error?.message || error)}` } }));
      return true;
    }
    if (result?.error) {
      response.writeHead(result.error === 'invalid-query' ? 400 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: `registry search failed: ${result.error}` } }));
      return true;
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ data: { query: q, keyword: SEARCH_KEYWORD, plugins: result.plugins } }));
    return true;
  }

  // Update check (S3 slice 6, plan 5-S3): ONE bounded batch when the Plugins
  // view opens. Per-package lookup failure = no chip (never a 500), the batch
  // is capped at 25, and the strict name regex applies — this endpoint fetches
  // the registry on the operator's behalf, so it wears the INVENTORY gate.
  if (url.pathname === '/api/v1/plugins/updates' && request.method === 'POST') {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.INVENTORY);

    const body = await readBoundedJsonBody(request);
    const packages = Array.isArray(body?.packages) ? body.packages : null;
    const badRequest = (message) => {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message } }));
      return true;
    };
    if (!packages)
      return badRequest('updates requires a packages array');
    if (packages.length > 25)
      return badRequest('updates batch is capped at 25 packages');

    // Validate the WHOLE batch before one byte leaves for the registry.
    const { parseNpmPackageSpec } = await import('../../core/plugins/npm-package.mjs');
    for (const [index, entry] of packages.entries()) {
      const name = entry && typeof entry.name === 'string' ? entry.name : null;
      const parsed = name ? parseNpmPackageSpec(name) : null;
      if (!parsed || parsed.version !== null || parsed.name !== name)
        return badRequest(`invalid package at index ${index} — bare registry names only`);
    }

    const { resolvePackage, isOutdated } = await import('../../core/plugins/npm-registry.mjs');
    const config = context.has?.('config') ? context.require('config') : null;
    const registryUrls = await configuredRegistryUrls(config);
    const fetchImpl = registryFetchSeam(context);
    const updates = {};
    let checked = 0;
    for (const entry of packages) {
      checked += 1;
      try {
        const meta = await resolvePackage(entry.name, null, { registryUrls, fetchImpl });
        const installed = typeof entry.version === 'string' ? entry.version : null;
        if (meta && !meta.error && isOutdated(installed, meta.version))
          updates[entry.name] = { latest: meta.version };
      } catch (_e) {
        // Per-package lookup failure = no chip (plan 5-S3) — the batch still 200s.
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ data: { updates, checked } }));
    return true;
  }

  // Install a plugin from a directory or the npm registry, without a restart.
  // Extracted to plugin-install-routes.mjs (source line limits): the branch
  // carries the whole {path}|{npm} pipeline — gates, staging/swap, rollback,
  // runtime-path append and provenance.
  if (url.pathname === '/api/v1/plugins/install' && request.method === 'POST')
    return await handlePluginInstall({ request, response, context });

  // Re-scan plugin paths without restarting. Installs a plugin by putting a directory
  // where the boot would find it, then asking for a reload. This previously had no gate
  // at all, unlike install, even though it also executes newly discovered plugin code.
  if (url.pathname === '/api/v1/plugins/reload' && request.method === 'POST') {
    const gate = await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.RELOAD);

    // Re-read the env file before anything loads. The launchers load it once, before
    // spawning this process, so a key added afterwards - a bot token, a channel
    // binding - is invisible to a config store that only ever sees `process.env`.
    // Without this a reload cannot apply the configuration it was performed for, and
    // the only remaining way to apply it is a restart - which is the guarantee this
    // platform rejects. Only keys the file owns are updated, so a deliberate shell
    // override such as KIKX_PORT stays pinned.
    let envRefresh = null;
    try {
      const { refreshEnvFromFile } = await import('../../core/config/env-refresh.mjs');
      envRefresh = await refreshEnvFromFile();
    } catch (error) {
      // A broken env file must not break the lifecycle: report it and continue with
      // whatever the process already holds.
      envRefresh = {
        skipped: 'error',
        error: String(error?.message || error),
        added: [], updated: [], pinned: [],
      };
    }

    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    // Re-read the configured paths rather than using the boot snapshot: installing a
    // plugin means adding a directory to the configuration, and a reload that scans the
    // old list can never find it.
    let pluginPaths = null;
    try {
      let config = context.has?.('config') ? context.require('config') : null;
      if (config && typeof config.get === 'function') {
        const { KIKX_PLUGIN_PATHS_PATH } = await import('../../core/config/config-paths.mjs');
        pluginPaths = await config.get(KIKX_PLUGIN_PATHS_PATH);
      }
    } catch (_e) { pluginPaths = null; }
    if (!pluginPaths && context.has?.('pluginPaths'))
      pluginPaths = context.require('pluginPaths');
    // S3: runtime installs append to <cwd>/.kikx/plugin-paths.json (ConfigStore
    // is read-only) — a reload must scan them too, or an npm install would
    // live exactly until something else reloaded the configured list.
    try {
      const { mergePluginPaths } = await import('../../core/plugins/plugin-paths.mjs');
      const { runtimePathsForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
      const cfg = context.has?.('config') ? context.require('config') : null;
      const merged = mergePluginPaths(pluginPaths || [], await runtimePathsForConfig(cfg));
      if (merged.length) pluginPaths = merged;
    } catch (_e) { /* keep the configured list */ }
    if (!registry || !pluginPaths) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin reload is unavailable' } }));
      return true;
    }
    let before = new Set((registry._pluginRegistrations || new Map()).keys());
    try {
      const { loadPlugins } = await import('../../core/plugins/plugin-loader.mjs');
      const { disabledSkipKeys } = await import('../../core/config/runtime-disabled-plugins.mjs');
      const { runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
      const cfgForSkip = context.has?.('config') ? context.require('config') : null;
      await loadPlugins({
        pluginPaths,
        registry,
        commandRegistry: context.require('commandRegistry'),
        context,
        disabledNames: disabledSkipKeys({ cwd: await runtimeRootForConfig(cfgForSkip) }),
      });
      let after = new Set((registry._pluginRegistrations || new Map()).keys());
      // S5: reload is repo-wide (pluginID null) — the event still tells every
      // client "plugins changed, look again", which is all the refetch needs.
      const { publishPluginChanged, actorFromGate } = await import('../plugin-changed.mjs');
      publishPluginChanged(context, { pluginID: null, action: 'reload', actor: actorFromGate(gate) });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        data: {
          added: [...after].filter((k) => !before.has(k)),
          total: after.size,
          failures: registry._pluginLoadErrors || [],
          // Reported rather than only logged: an operator reloading a plugin to pick
          // up new configuration needs to see whether that configuration was re-read.
          env: envRefresh,
        },
      }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
    }
    return true;
  }

  // Remove a loaded plugin without restarting the process.
  //
  // unloadPlugin() has long had a complete contract - mount, event subscriptions,
  // migrations, scoped database handle, plugin authority, class overrides - and
  // spec/plugins/plugin-unload-spec.mjs pins each of those. But nothing in the HTTP
  // surface reached it, so the only way to stop a plugin was to restart the server, and
  // the P7 exit criterion (install/reload/unload demonstrated against a live server) was
  // not reachable at all. This route is the missing surface, not new machinery.
  //
  // It does not remove the plugin's DIRECTORY. Unloading is a runtime action; whether the
  // code is still on disk is a configuration question, and deleting files from an admin
  // endpoint would be a destructive act nobody asked this route to perform. So an unload
  // followed by a reload of the configured paths will find the directory again and bring
  // the plugin back - deliberately, and it is reported in the response for that reason.
  if (url.pathname === '/api/v1/plugins/unload' && request.method === 'POST') {
    const gate = await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.UNLOAD);

    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    if (!registry) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin registry unavailable' } }));
      return true;
    }

    let body = await readBoundedJsonBody(request);
    let name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'unload requires a plugin name' } }));
      return true;
    }

    let map = registry._pluginRegistrations;
    // An unknown name is a 404, never a 200 with unloaded:false. This request is the one
    // that would have stopped a plugin, so a caller who named the wrong plugin must not
    // be answered in a way that reads as "it is stopped now".
    if (!(map instanceof Map) || !map.has(name)) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: { message: 'plugin "' + name + '" is not loaded' },
        data: { name, loaded: map instanceof Map ? [ ...map.keys() ] : [] },
      }));
      return true;
    }

    let location = map.get(name)?.pluginLocation || null;
    try {
      const { unloadPlugin } = await import('../../core/plugins/plugin-loader.mjs');
      let removed = await unloadPlugin(registry, name, { logger: console });
      // unloadPlugin() answers false when the record vanished between the check above and
      // the call. Reporting success there would claim a teardown that never happened.
      if (removed === false) {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          error: { message: 'plugin "' + name + '" could not be unloaded' },
        }));
        return true;
      }
      let remaining = registry._pluginRegistrations instanceof Map
        ? [ ...registry._pluginRegistrations.keys() ]
        : [];
      // S5: one announce on the success path only (the 500s above returned).
      const { publishPluginChanged, actorFromGate } = await import('../plugin-changed.mjs');
      publishPluginChanged(context, { pluginID: name, action: 'unload', actor: actorFromGate(gate) });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        data: {
          name,
          unloaded: true,
          location,
          total: remaining.length,
          loaded: remaining,
        },
      }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
    }
    return true;
  }

  // Uninstall (plan 9.1.1) and enable/disable (plan 9.1.2) — extracted to
  // plugin-lifecycle-routes.mjs (source line limits); gates, ordering,
  // managed checks, rollback and the shared helpers live there.
  if (url.pathname === '/api/v1/plugins/uninstall' && request.method === 'POST')
    return await handlePluginUninstall({ request, response, context });
  if (url.pathname === '/api/v1/plugins/set-enabled' && request.method === 'POST')
    return await handlePluginSetEnabled({ request, response, context });

  let match = router.match(url.pathname);
  if (!match)
    return false;

  await router.invoke({ match, request, response, context });
  return true;
}
