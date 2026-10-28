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

  let match = router.match(url.pathname);
  if (!match)
    return false;

  await router.invoke({ match, request, response, context });
  return true;
}
