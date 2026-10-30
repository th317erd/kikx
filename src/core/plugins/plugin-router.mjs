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
const AUTH_MODES = new Set(['required', 'public']);

// Marks an error this module raised itself. Only these may have their message
// echoed to the client: a caller who sent a 3 MB body should be told the body was
// too large rather than "Plugin handler failed". A plugin's own error keeps the
// generic body regardless of the status it chose, because a plugin is free to put
// internals in an error message and this response is network-visible. Keying on
// status alone would leak any plugin's 4xx text.
const CORE_ERROR = Symbol('kikx.pluginRouter.coreError');

function coreError(message, status) {
  return Object.assign(new Error(message), { status, [CORE_ERROR]: true });
}

function readLimit(value, label, { allowZero = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${label} must be a finite number of milliseconds or bytes, got ${value}`);
  if (value < 0 || (!allowZero && value === 0))
    throw new TypeError(`${label} must be ${allowZero ? 'zero or positive' : 'positive'}, got ${value}`);
  return Math.floor(value);
}

export class PluginRouter {
  constructor(options = {}) {
    this.mounts = new Map();
    this.handlerTimeoutMS = options.handlerTimeoutMS || DEFAULT_HANDLER_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
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

  // Options:
  //   auth              'required' (default) | 'public'
  //   maxBodyBytes      per-mount body cap; may only tighten the router-wide cap
  //   handlerTimeoutMS  per-mount deadline; may only tighten the router-wide one
  //   dispose           called once when the mount is removed or replaced
  //
  // A per-mount limit may not RAISE the router-wide ceiling. The router-wide values
  // are the operator's decision about this deployment; a plugin that could raise
  // its own body cap or deadline would make that decision meaningless. Tightening
  // is the case a plugin actually needs: a webhook handler wants a small body and a
  // bounded deadline, while a bulk import wants more time and gets it only if the
  // operator raised the ceiling for the whole deployment.
  mount(pluginId, handler, { auth = 'required', maxBodyBytes, handlerTimeoutMS, dispose } = {}) {
    if (typeof handler !== 'function')
      throw new TypeError('mount requires a handler function');
    if (!AUTH_MODES.has(auth))
      throw new TypeError(`mount auth must be "required" or "public", got "${auth}"`);
    if (dispose !== undefined && typeof dispose !== 'function')
      throw new TypeError('mount dispose must be a function when provided');

    let declaredBody = readLimit(maxBodyBytes, 'mount maxBodyBytes', { allowZero: true });
    let declaredTimeout = readLimit(handlerTimeoutMS, 'mount handlerTimeoutMS');

    let path = PluginRouter.mountPathFor(pluginId);
    let existing = this.mounts.get(pluginId);
    if (existing) {
      // A reload supplies a fresh handler for the same mount. Replace rather than throw;
      // a different path for the same plugin is still a conflict.
      if (existing.path !== path)
        throw new TypeError(`plugin "${pluginId}" already mounted at ${existing.path}, cannot move to ${path}`);
      // The replaced mount's dispose must run or its resources leak on every reload.
      this.#disposeMount(existing, 'replaced');
      this.mounts.delete(pluginId);
    }

    this.mounts.set(pluginId, {
      pluginId,
      path,
      handler,
      auth,
      // Resolved effective values, so the inventory reports what is actually
      // enforced rather than what was requested.
      maxBodyBytes: declaredBody === undefined ? this.maxBodyBytes : Math.min(declaredBody, this.maxBodyBytes),
      handlerTimeoutMS: declaredTimeout === undefined ? this.handlerTimeoutMS : Math.min(declaredTimeout, this.handlerTimeoutMS),
      dispose: dispose || null,
    });
    return path;
  }

  listMounts() {
    return [...this.mounts.values()].map((mount) => ({
      pluginId: mount.pluginId,
      path: mount.path,
      // "public must be declared and reviewed" (campaign 4.3) is only auditable if
      // the declaration is visible in the inventory an operator actually reads.
      auth: mount.auth,
      maxBodyBytes: mount.maxBodyBytes,
      handlerTimeoutMS: mount.handlerTimeoutMS,
      disposable: typeof mount.dispose === 'function',
    }));
  }

  // Remove a mount. Returns true when one was removed, so a caller can tell the
  // difference between "nothing to release" and "released". Without this an
  // unloaded plugin keeps serving requests through a handler nothing owns.
  //
  // The mount is deleted BEFORE dispose runs, so an unload is immediately
  // route-not-found even when the plugin's own cleanup throws or blocks.
  unmount(pluginId) {
    let mount = this.mounts.get(pluginId);
    if (!mount) return false;
    this.mounts.delete(pluginId);
    this.#disposeMount(mount, 'unmounted');
    return true;
  }

  #disposeMount(mount, reason) {
    if (typeof mount.dispose !== 'function') return;
    try {
      mount.dispose();
    } catch (error) {
      // A failing cleanup must not resurrect the mount or mask the unload.
      this.logger?.error?.(
        `[plugin-router] ${mount.pluginId} mount dispose failed (${reason})`,
        error?.message || error,
      );
    }
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
      let identity = await this.#authorize(match.mount, request, context);
      await Promise.race([
        this.#dispatch(match, request, response, context, identity),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(coreError('Plugin handler timed out', 504)),
            match.mount.handlerTimeoutMS ?? this.handlerTimeoutMS,
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
        // Deterministic error mapping: a status core assigned is reported with its
        // own message; anything else is the plugin's and stays generic.
        let status = Number(error?.status) || 500;
        let message = error?.[CORE_ERROR] && error?.message
          ? String(error.message)
          : 'Plugin handler failed';
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message, status } }));
      } else {
        response.destroy();
      }
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #authorize(mount, request, context) {
    if (mount.auth === 'public')
      return null;

    let accountStore = context?.has?.('accountStore')
      ? context.require('accountStore')
      : context?.accountStore || null;
    if (!accountStore || typeof accountStore.resolveIdentity !== 'function')
      throw coreError('Plugin mount requires an authenticated Kikx identity', 503);

    let identity;
    try {
      identity = await accountStore.resolveIdentity(request);
    } catch (error) {
      throw coreError('Sign in required to access this plugin route', 401);
    }
    if (!identity)
      throw coreError('Sign in required to access this plugin route', 401);
    return identity;
  }

  async #dispatch(match, request, response, context, identity = null) {
    let rawBody = await this.#bufferBody(request, match.mount.maxBodyBytes ?? this.maxBodyBytes);

    // The plugin sees the raw bytes and may parse them itself. `json()` is a
    // convenience that never mutates the buffer.
    //
    // Malformed JSON is a CLIENT error, not a handler failure. The parse error is
    // tagged 400 so an uncaught one maps deterministically; the plugin may still
    // catch it and answer differently, which is its business.
    let json = null;
    let jsonError = null;
    let parsed = false;
    let parseJSON = () => {
      if (!parsed) {
        parsed = true;
        try { json = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null; }
        catch (error) {
          jsonError = Object.assign(coreError('Malformed JSON request body', 400), { cause: error });
        }
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
      identity,
      subPath: match.subPath,
      mountPath: match.mount.path,
      url,
      rawBody,
      json: parseJSON,
    });
  }

  async #bufferBody(request, maxBodyBytes) {
    let declared = Number(request.headers?.['content-length'] || 0);
    if (declared && declared > maxBodyBytes)
      throw coreError('Request body too large', 413);

    let chunks = [];
    let total = 0;
    for await (let chunk of request) {
      total += chunk.length;
      if (total > maxBodyBytes)
        throw coreError('Request body too large', 413);
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
