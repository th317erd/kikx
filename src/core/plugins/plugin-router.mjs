'use strict';

// HTTP mounting for plugins.
//
// A plugin does not register individual paths. It gets one mount point,
// /api/plugins/<pluginId>/, and everything below it is the plugin's business. That
// removes per-route matching from core, makes collisions impossible, and lets a
// plugin own its own versioning (/v1/...) without core knowing what "v1" means.
//
// The prefix is a boundary rather than a convention: a plugin that could claim
// /api/v1/auth/* could bypass authentication, so mount points are derived from the
// plugin id and cannot be chosen freely.
//
// Bodies are NOT parsed by core. `request` is a stream and reads exactly once; if
// core consumed it, a plugin could not verify a webhook signature over the raw
// bytes. Core buffers the raw body once into `rawBody` and the plugin may ask for
// `json()` or keep the bytes.

export const PLUGIN_MOUNT_ROOT = '/api/plugins/';
const RESERVED_PLUGIN_IDS = new Set(['plugins', 'v1', 'api']);
const DEFAULT_HANDLER_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export class PluginRouter {
  constructor(options = {}) {
    this.mounts = new Map();
    this.handlerTimeoutMS = options.handlerTimeoutMS || DEFAULT_HANDLER_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
    this.logger = options.logger || console;
  }

  static mountPathFor(pluginId) {
    if (typeof pluginId !== 'string' || !pluginId.trim())
      throw new TypeError('mountPathFor requires a plugin id');
    let id = pluginId.trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id))
      throw new TypeError(`plugin id "${id}" is not a safe path segment`);
    if (RESERVED_PLUGIN_IDS.has(id.toLowerCase()))
      throw new TypeError(`plugin id "${id}" is reserved`);
    return `${PLUGIN_MOUNT_ROOT}${id}/`;
  }

  mount(pluginId, handler) {
    if (typeof handler !== 'function')
      throw new TypeError('mount requires a handler function');
    let path = PluginRouter.mountPathFor(pluginId);
    let existing = this.mounts.get(pluginId);
    if (existing) {
      // A reload supplies a fresh handler for the same mount. Replace rather than throw;
      // a different path for the same plugin is still a conflict.
      if (existing.path !== path)
        throw new TypeError(`plugin "${pluginId}" already mounted at ${existing.path}, cannot move to ${path}`);
      this.mounts.delete(pluginId);
    }
    this.mounts.set(pluginId, { pluginId, path, handler });
    return path;
  }

  listMounts() {
    return [...this.mounts.values()].map(({ pluginId, path }) => ({ pluginId, path }));
  }

  match(pathname) {
    if (!pathname.startsWith(PLUGIN_MOUNT_ROOT))
      return null;
    for (let mount of this.mounts.values()) {
      if (pathname === mount.path.slice(0, -1) || pathname.startsWith(mount.path))
        return { mount, subPath: '/' + pathname.slice(mount.path.length) };
    }
    return null;
  }

  async invoke({ match, request, response, context }) {
    let timer = null;
    try {
      await Promise.race([
        this.#dispatch(match, request, response, context),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error('Plugin handler timed out'), { status: 504 })),
            this.handlerTimeoutMS,
          );
          // Deliberately NOT unref'd: an unref'd timer cannot keep the loop alive, so a
          // handler that never settles would let the process exit before the timeout
          // fires. See the same fix in plugin-loader.mjs.
        }),
      ]);
      return true;
    } catch (error) {
      this.logger?.error?.(`[plugin-router] ${match.mount.pluginId} failed`, error?.message || error);
      if (!response.headersSent) {
        response.writeHead(error?.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'Plugin handler failed' } }));
      } else {
        response.destroy();
      }
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #dispatch(match, request, response, context) {
    let rawBody = await this.#bufferBody(request);

    // The plugin sees the raw bytes and may parse them itself. `json()` is a
    // convenience that never mutates the buffer.
    let json = null;
    let jsonError = null;
    let parsed = false;
    let parseJSON = () => {
      if (!parsed) {
        parsed = true;
        try { json = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null; }
        catch (error) { jsonError = error; }
      }
      if (jsonError) throw jsonError;
      return json;
    };

    let url = new URL(request.url, 'http://localhost');
    await match.mount.handler({
      request,
      response,
      context,
      pluginId: match.mount.pluginId,
      subPath: match.subPath,
      mountPath: match.mount.path,
      url,
      rawBody,
      json: parseJSON,
    });
  }

  async #bufferBody(request) {
    let declared = Number(request.headers?.['content-length'] || 0);
    if (declared && declared > this.maxBodyBytes)
      throw Object.assign(new Error('Request body too large'), { status: 413 });

    let chunks = [];
    let total = 0;
    for await (let chunk of request) {
      total += chunk.length;
      if (total > this.maxBodyBytes)
        throw Object.assign(new Error('Request body too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
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
