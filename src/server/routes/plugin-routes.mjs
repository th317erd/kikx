'use strict';

// Routes /api/plugins/<id>/... to the plugin that owns that mount.
// Returns false when the path is not under a plugin mount, so the built-in chain continues.

import { PLUGIN_ADMIN_ACTIONS, requireOperator } from './plugin-admin-policy.mjs';

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

    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      data: {
        plugins: records.map((r) => ({
          name: r.pluginName,
          // Directories only, never absolute paths: an authenticated caller still does not
          // need the operator's filesystem layout.
          location: r.pluginLocation || null,
          mounted: routerForList?.listMounts?.().some((m) => m.pluginId === r.pluginName) || false,
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

    // This branch runs before router.invoke, which is what normally supplies a body
    // reader, so the request body is read here. Bounded: an install payload is a path.
    let body = null;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) throw new Error('install payload too large');
        chunks.push(chunk);
      }
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    } catch (_e) { body = null; }
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

  let match = router.match(url.pathname);
  if (!match)
    return false;

  await router.invoke({ match, request, response, context });
  return true;
}
