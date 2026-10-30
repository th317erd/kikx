'use strict';

// Routes /api/plugins/<id>/... to the plugin that owns that mount.
// Returns false when the path is not under a plugin mount, so the built-in chain continues.

import { PLUGIN_ADMIN_ACTIONS, requireOperator } from './plugin-admin-policy.mjs';

// The admin branches below run before router.invoke(), which is what normally supplies a
// body reader, so they read the request themselves. Bounded because these payloads are a
// path or a name; a malformed or oversized body returns null rather than a partial parse,
// and the caller decides what a missing body means for its route.
async function readBoundedJsonBody(request, limit = 4096) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new Error('payload too large');
      chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  } catch (_e) { return null; }
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
    let map = registry?._pluginRegistrations;
    let records = map instanceof Map ? [...map.values()] : [];
    let bus = context.has?.('pluginEventBus') ? context.require('pluginEventBus') : null;
    let routerForList = context.has?.('pluginRouter') ? context.require('pluginRouter') : null;
    // Mount descriptors keyed once, so each plugin row can report the auth declaration
    // and the limits actually enforced on it. Campaign 4.3 says a public mount "must be
    // declared and reviewed"; that is only reviewable if the declaration is visible to
    // an operator without reading the plugin's source.
    let mountsById = new Map((routerForList?.listMounts?.() || []).map((m) => [ m.pluginId, m ]));

    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      data: {
        plugins: records.map((r) => ({
          name: r.pluginName,
          // Directories only, never absolute paths: an authenticated caller still does not
          // need the operator's filesystem layout.
          location: r.pluginLocation || null,
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
        })),
        failures: registry?._pluginLoadErrors || [],
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

  // Install a plugin from a directory, without a restart. Takes the path directly rather
  // than re-reading configuration: KIKX_PLUGIN_PATHS is an environment variable a running
  // process cannot re-read, which is why reload alone could never find a new plugin.
  if (url.pathname === '/api/v1/plugins/install' && request.method === 'POST') {
    // Identity first, config gate second. The config flag answers "is this deployment
    // willing to install at runtime"; it never answered "is this caller allowed to", and
    // anyone who can reach the port inherits it.
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.INSTALL);

    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    if (!registry) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin registry unavailable' } }));
      return true;
    }

    // Installing loads code from an arbitrary path into this process. Denied unless the
    // operator has explicitly turned it on - an open install endpoint is remote code
    // execution with a JSON body.
    let enabled = false;
    try {
      let config = context.has?.('config') ? context.require('config') : null;
      if (config && typeof config.get === 'function') {
        const { KIKX_PLUGIN_INSTALL_ENABLED_PATH } = await import('../../core/config/config-paths.mjs');
        let value = await config.get(KIKX_PLUGIN_INSTALL_ENABLED_PATH);
        enabled = value === true || value === 'true' || value === '1';
      }
    } catch (_e) { enabled = false; }
    if (!enabled) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: {
          message: 'plugin install is disabled',
          hint: 'set KIKX_PLUGIN_INSTALL_ENABLED=true to allow installing code at runtime',
        },
      }));
      return true;
    }

    // Bounded: an install payload is a path.
    let body = await readBoundedJsonBody(request);
    let target = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!target) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'install requires a path' } }));
      return true;
    }
    if (!target.startsWith('/')) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'install path must be absolute' } }));
      return true;
    }

    let before = new Set((registry._pluginRegistrations || new Map()).keys());
    let failuresBefore = (registry._pluginLoadErrors || []).length;
    // Plugins this install brought in - not plugins that were already loaded. The
    // distinction is the whole safety property here: migrations.run() applies every
    // registered directory, so a migration failure is not attributable to one plugin, and
    // unloading "everything that declared migrations" would tear down plugins that were
    // installed and healthy before this request arrived.
    let added = [];
    try {
      const { loadPlugins } = await import('../../core/plugins/plugin-loader.mjs');
      await loadPlugins({
        pluginPaths: target,
        registry,
        commandRegistry: context.require('commandRegistry'),
        context,
      });

      // Computed before migrations run, for the reason above: if the migration step
      // throws, this is the only accurate record of what this request added.
      added = [...(registry._pluginRegistrations || new Map()).keys()].filter((k) => !before.has(k));

      // Migrations run at startup, so a plugin installed afterwards has registered its
      // SQL and never had it applied - it would load and then fail on its first query.
      // Run them here for exactly this install.
      if (context.has?.('pluginMigrations')) {
        let outcome = await context.require('pluginMigrations').run({ logger: console });
        // run() returns { skipped, reason } when it does nothing. Discarding that made a
        // silent skip indistinguishable from a silent success.
        if (outcome?.skipped)
          console.warn('[plugin-install] migrations skipped:', outcome.reason);
        else
          console.warn('[plugin-install] migrations applied:', JSON.stringify(context.require('pluginMigrations').applied || []));
      }
    } catch (error) {
      // An install that reports failure must not leave the plugin running. The load above
      // succeeded, so the registry now holds a plugin whose SQL was never applied: its
      // mount is reachable and its first query fails at the caller's expense. Answering
      // 500 while keeping it loaded also makes a retry install it a second time.
      //
      // Only `added` is undone. Plugins that predate this request keep working even
      // though the failing directory may be shared with them.
      let unloaded = [];
      for (let name of added) {
        try {
          const { unloadPlugin } = await import('../../core/plugins/plugin-loader.mjs');
          await unloadPlugin(registry, name, { logger: console });
          unloaded.push(name);
        } catch (unloadError) {
          // A rollback failure must not replace the migration failure the caller needs to
          // see. It is reported alongside instead of masking it.
          console.warn(`[plugin-install] failed to unload "${name}" after a failed install:`, unloadError?.message);
        }
      }
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: { message: String(error?.message || error) },
        data: { path: target, added, unloaded },
      }));
      return true;
    }

    let after = new Set((registry._pluginRegistrations || new Map()).keys());
    // `added` was computed before migrations ran; nothing loads during the migration step.
    let newFailures = (registry._pluginLoadErrors || []).slice(failuresBefore);

    response.writeHead(added.length ? 201 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      data: { path: target, added, total: after.size, failures: newFailures },
    }));
    return true;
  }

  // Re-scan plugin paths without restarting. Installs a plugin by putting a directory
  // where the boot would find it, then asking for a reload. This previously had no gate
  // at all, unlike install, even though it also executes newly discovered plugin code.
  if (url.pathname === '/api/v1/plugins/reload' && request.method === 'POST') {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.RELOAD);

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
    if (!registry || !pluginPaths) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin reload is unavailable' } }));
      return true;
    }
    let before = new Set((registry._pluginRegistrations || new Map()).keys());
    try {
      const { loadPlugins } = await import('../../core/plugins/plugin-loader.mjs');
      await loadPlugins({ pluginPaths, registry, commandRegistry: context.require('commandRegistry'), context });
      let after = new Set((registry._pluginRegistrations || new Map()).keys());
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        data: {
          added: [...after].filter((k) => !before.has(k)),
          total: after.size,
          failures: registry._pluginLoadErrors || [],
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
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.UNLOAD);

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

  let match = router.match(url.pathname);
  if (!match)
    return false;

  await router.invoke({ match, request, response, context });
  return true;
}
