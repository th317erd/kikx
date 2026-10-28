'use strict';

// Routes /api/plugins/<id>/... to the plugin that owns that mount.
// Returns false when the path is not under a plugin mount, so the built-in chain continues.

export async function handlePluginRoutes({ request, response, url, context }) {
  let router = null;
  try {
    router = context.has?.('pluginRouter') ? context.require('pluginRouter') : null;
  } catch (_error) {
    router = null;
  }

  if (!router || typeof router.match !== 'function')
    return false;

  // Plugin inventory. Read-only, and deliberately not under /plugin/ so it cannot
  // collide with a plugin mount.
  if (url.pathname === '/api/v1/plugins' && request.method === 'GET') {
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
          // Directories only, never absolute paths: this endpoint is reachable
          // unauthenticated and the operator's filesystem layout is not public.
          location: r.pluginLocation || null,
          mounted: routerForList?.listMounts?.().some((m) => m.pluginId === r.pluginName) || false,
          subscriptions: bus?.list?.().find((s) => s.pluginId === r.pluginName) || null,
          manifest: r.manifest || null,
        })),
        failures: registry?._pluginLoadErrors || [],
      },
    }));
    return true;
  }

  // Re-scan plugin paths without restarting. Installs a plugin by putting a directory
  // where the boot would find it, then asking for a reload.
  if (url.pathname === '/api/v1/plugins/reload' && request.method === 'POST') {
    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    let pluginPaths = context.has?.('pluginPaths') ? context.require('pluginPaths') : null;
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
