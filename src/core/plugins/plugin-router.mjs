'use strict';

// Route registry for plugin-owned HTTP endpoints.
//
// Plugins run in-process, which means a plugin handler shares the event loop, the
// process and the failure modes of the server itself. Two rules follow from that and
// are enforced here rather than trusted to plugin authors:
//
//   1. A plugin may only register routes under "/plugin/<pluginName>/". A plugin able
//      to claim "/api/v1/auth/*" could bypass authentication entirely, so the prefix
//      is a boundary, not a convention.
//   2. Every handler runs inside a timeout and a try/catch. A throwing handler must
//      produce a 500 for that request, not a crash for every other session.

export const PLUGIN_ROUTE_PREFIX = '/plugin/';

const DEFAULT_HANDLER_TIMEOUT_MS = 30000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function normalizeMethod(method) {
  if (typeof method !== 'string' || !method.trim())
    throw new TypeError('registerRoute requires a method string');
  let upper = method.trim().toUpperCase();
  if (!ALLOWED_METHODS.has(upper))
    throw new TypeError(`registerRoute does not accept method "${method}"`);
  return upper;
}

function normalizePath(path, pluginName) {
  if (typeof path !== 'string' || !path.startsWith('/'))
    throw new TypeError('registerRoute requires a path beginning with "/"');

  let expected = `${PLUGIN_ROUTE_PREFIX}${pluginName}/`;
  if (!path.startsWith(expected))
    throw new TypeError(
      `registerRoute: plugin "${pluginName}" may only register under "${expected}" (got "${path}")`,
    );

  // Collapse duplicate slashes and reject traversal outright rather than normalising it away.
  if (path.includes('..'))
    throw new TypeError(`registerRoute: path may not contain ".." (got "${path}")`);

  return path.replace(/\/{2,}/g, '/');
}

export class PluginRouter {
  constructor(options = {}) {
    this.routes = [];
    this.handlerTimeoutMS = options.handlerTimeoutMS || DEFAULT_HANDLER_TIMEOUT_MS;
    this.logger = options.logger || console;
  }

  register({ method, path, handler, pluginName }) {
    if (typeof pluginName !== 'string' || !pluginName.trim())
      throw new TypeError('registerRoute requires a pluginName');

    let normalizedMethod = normalizeMethod(method);
    let normalizedPath = normalizePath(path, pluginName);

    if (typeof handler !== 'function')
      throw new TypeError('registerRoute requires a handler function');

    let duplicate = this.routes.find((r) => r.method === normalizedMethod
      && r.path === normalizedPath
      && r.pluginName === pluginName);
    if (duplicate)
      throw new TypeError(`registerRoute: ${normalizedMethod} ${normalizedPath} is already registered for "${pluginName}"`);

    this.routes.push({
      method: normalizedMethod,
      path: normalizedPath,
      handler,
      pluginName,
      segments: normalizedPath.split('/').filter(Boolean),
      registeredAt: new Date().toISOString(),
    });

    return true;
  }

  list(pluginName = null) {
    return this.routes
      .filter((r) => !pluginName || r.pluginName === pluginName)
      .map(({ method, path, pluginName: owner, registeredAt }) => ({ method, path, pluginName: owner, registeredAt }));
  }

  match(method, pathname) {
    let normalizedMethod = String(method || '').toUpperCase();
    let requested = pathname.split('/').filter(Boolean);

    let candidates = [];
    for (let route of this.routes) {
      if (route.method !== normalizedMethod)
        continue;
      if (route.segments.length !== requested.length)
        continue;

      let params = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        let segment = route.segments[i];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(requested[i]);
          continue;
        }
        if (segment !== requested[i]) { matched = false; break; }
      }
      if (matched)
        candidates.push({ route, params });
    }

    if (!candidates.length)
      return null;

    // Longest literal path wins so a specific route beats a parameterised one.
    candidates.sort((a, b) => b.route.segments.length - a.route.segments.length);
    let { route, params } = candidates[0];
    return { handler: route.handler, params, pluginName: route.pluginName, path: route.path };
  }

  async invoke({ match, request, response, context }) {
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve(match.handler({ request, response, context, params: match.params })),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error('Plugin route handler timed out'), { status: 504 })),
            this.handlerTimeoutMS,
          );
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return true;
    } catch (error) {
      this.logger?.error?.(
        `[plugin-router] ${match.pluginName} ${match.path} failed`,
        error?.message || error,
      );
      if (!response.headersSent) {
        response.writeHead(error?.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'Plugin route failed' } }));
      } else {
        // Headers already sent: the only honest response is to drop the connection.
        response.destroy();
      }
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

let defaultRouter = null;

export function getPluginRouter(options = {}) {
  if (!defaultRouter)
    defaultRouter = new PluginRouter(options);
  return defaultRouter;
}

export function resetPluginRouter() {
  defaultRouter = null;
}
