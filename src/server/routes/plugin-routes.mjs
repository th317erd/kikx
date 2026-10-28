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
          location: typeof r.pluginPath === 'string'
            ? r.pluginPath.split(/[/\\]/).filter(Boolean).pop() || null
            : null,
          mounted: routerForList?.listMounts?.().some((m) => m.pluginId === r.pluginName) || false,
          subscriptions: bus?.list?.().find((s) => s.pluginId === r.pluginName) || null,
        })),
        failures: registry?._pluginLoadErrors || [],
      },
    }));
    return true;
  }

  let match = router.match(url.pathname);
  if (!match)
    return false;

  await router.invoke({ match, request, response, context });
  return true;
}
