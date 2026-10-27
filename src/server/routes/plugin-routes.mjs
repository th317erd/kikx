'use strict';

// Dispatches requests whose path matches a route a plugin registered.
// Returns false when nothing matches so the built-in chain continues.

export async function handlePluginRoutes({ request, response, url, context }) {
  let router = null;
  try {
    router = context.has?.('pluginRouter') ? context.require('pluginRouter') : null;
  } catch (_error) {
    router = null;
  }

  if (!router || typeof router.match !== 'function')
    return false;

  let method = (request.method || 'GET').toUpperCase();
  let match = router.match(method, url.pathname);
  if (!match)
    return false;

  await router.invoke({ match, request, response, context });
  return true;
}
