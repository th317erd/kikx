'use strict';

// =============================================================================
// P7 exit proof: install / reload / unload against a running process.
// =============================================================================
// The campaign's remaining P7 item reads "demonstrating install/reload/unload on a
// live boot". Install and reload had HTTP surfaces; unload did not. `unloadPlugin()`
// itself was complete and already pinned by spec/plugins/plugin-unload-spec.mjs
// (mount, event subscriptions, migrations, scoped database handle, plugin authority,
// class overrides), but nothing in the HTTP layer reached it: the only way to stop a
// plugin was to restart the server. So the exit criterion was unreachable, and its
// own checklist said so — "there is no unload HTTP route today".
//
// This spec covers the surface that was missing, and nothing else. It does not
// re-test unloadPlugin's teardown; that contract already has its own spec and a
// failure there should point at it.
//
// Two properties matter more than the status codes:
//
//   1. ORDER. A gate that runs after the work is worthless — the plugin is already
//      gone. Every rejection test therefore also asserts the plugin is STILL LOADED
//      and its mount still registered.
//   2. An unknown name is a 404, never a 200 with unloaded:false. The caller of this
//      endpoint is trying to stop a plugin; answering in a way that reads as "it is
//      stopped now" when it was never loaded is how a caller concludes the wrong
//      thing about a process they cannot see inside.
//
// The plugin is written to a temp directory and loaded through the real `loadPlugins`,
// so the registry state under test is the state a server would have.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handlePluginRoutes } from '../../src/server/routes/plugin-routes.mjs';
import { PLUGIN_ADMIN_ACTIONS } from '../../src/server/routes/plugin-admin-policy.mjs';
import { loadPlugins } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/plugin-registry.mjs';
import { PluginRouter } from '../../src/core/plugins/plugin-router.mjs';
import { PluginEventBus } from '../../src/core/plugins/plugin-events.mjs';
import { PluginMigrations } from '../../src/core/plugins/plugin-migrations.mjs';

const silent = { log() {}, warn() {}, info() {}, error() {}, debug() {} };
const PLUGIN = 'unload-route-probe';
const SESSION = 'probe-session';

// ---- harness ---------------------------------------------------------------

function fakeResponse() {
  return {
    statusCode: 0,
    headersSent: false,
    body: null,
    writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
    end(payload) { if (payload !== undefined) this.body = String(payload); },
    destroy() { this.headersSent = true; },
  };
}

function fakeRequest({ method = 'POST', url = '/', body = '' } = {}) {
  let chunks = body ? [ Buffer.from(body) ] : [];
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { for (let c of chunks) yield c; },
  };
}

function fakeContext(services = {}) {
  return {
    has: (key) => Object.prototype.hasOwnProperty.call(services, key),
    require: (key) => {
      if (!Object.prototype.hasOwnProperty.call(services, key))
        throw new Error(`no service "${key}"`);
      return services[key];
    },
    get: (key) => services[key],
  };
}

function identityStore(identity) {
  return {
    resolveIdentity: async () => {
      if (identity) return identity;
      let error = new Error('Sign in required');
      error.status = 401;
      throw error;
    },
  };
}

// Config stand-in. Only the two paths the admin routes read are answered: whether
// install is enabled, and where the plugin paths are. Matching on the key's meaning
// rather than restating the constant keeps this from silently passing if a path is
// renamed — a wrong answer here makes the install test fail loudly instead.
function fakeConfig({ installEnabled, pluginPaths }) {
  return {
    get: async (key) => {
      let k = String(key || '');
      if (k.includes('install') && k.includes('enabled')) return installEnabled;
      if (k.includes('paths')) return pluginPaths;
      return null;
    },
  };
}

// A plugin that owns a mount and an event subscription, written to disk so it is
// loaded through the same import path a server uses.
async function writePlugin(root, name) {
  let dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        ctx.mountHttp(async (_req, res) => { res.end('probe'); });
        ctx.subscribe(() => {}, { sessions: [ ${JSON.stringify(SESSION)} ] });
      });
    }
  `);
  return dir;
}

function makeStack() {
  let registry = new PluginRegistry({ logger: silent });
  let router = new PluginRouter({ logger: silent });
  let bus = new PluginEventBus({ logger: silent });
  let migrations = new PluginMigrations({ logger: silent });
  registry.setPluginRouter(router);
  registry.setPluginEventBus(bus);
  registry.setPluginMigrations(migrations);
  return { registry, router, bus, migrations };
}

// Calls the real route module. `services` is the AppContext; the caller decides
// whether an account store is wired, because "no account store" is itself a case.
async function callRoute({ services, method = 'POST', pathname, body = null }) {
  let response = fakeResponse();
  let request = fakeRequest({ method, url: pathname, body: body === null ? '' : JSON.stringify(body) });
  let handled = await handlePluginRoutes({
    request,
    response,
    url: new URL('http://localhost' + pathname),
    context: fakeContext(services),
    json: async () => {},
    rawBody: async () => body,
  });
  return { handled, response, json: response.body ? JSON.parse(response.body) : null };
}

async function loadProbe(stack, root) {
  await writePlugin(root, PLUGIN);
  await loadPlugins({
    pluginPaths: path.join(root, PLUGIN),
    registry: stack.registry,
    logger: silent,
  });
}

function assertStillLoaded(stack, label) {
  assert.equal(stack.registry._pluginRegistrations.has(PLUGIN), true, label + ': plugin must still be registered');
  assert.deepEqual(stack.router.listMounts().map((m) => m.pluginId), [ PLUGIN ], label + ': mount must still be registered');
}

// ---- the gate --------------------------------------------------------------

test('unload refuses an unauthenticated caller and leaves the plugin running', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-route-'));
  let stack = makeStack();
  await loadProbe(stack, root);

  // A rejecting identity store: 401, not 503. The deployment CAN authenticate; this
  // caller did not.
  await assert.rejects(
    () => callRoute({
      services: {
        accountStore: identityStore(null),
        pluginRegistry: stack.registry,
        pluginRouter: stack.router,
      },
      pathname: '/api/v1/plugins/unload',
      body: { name: PLUGIN },
    }),
    (error) => error.status === 401,
  );

  assertStillLoaded(stack, 'after a 401');
});

test('unload refuses when no account store is wired instead of allowing it', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-route-'));
  let stack = makeStack();
  await loadProbe(stack, root);

  // The tempting shortcut is "no auth configured, so let it through". That turns a
  // missing dependency into an open admin surface, and for unload it would be a
  // remote kill switch for every mount on the deployment.
  await assert.rejects(
    () => callRoute({
      services: {
        pluginRegistry: stack.registry,
        pluginRouter: stack.router,
      },
      pathname: '/api/v1/plugins/unload',
      body: { name: PLUGIN },
    }),
    (error) => error.status === 503,
  );

  assertStillLoaded(stack, 'after a 503');
});

test('unload is a declared admin action, so it cannot be gated by an invented permission', async () => {
  // The action name is what an authorization layer will key on once Kikx has a role
  // model. Asserting it exists keeps the route from being gated by a bare boolean
  // that a future capability check could not see.
  assert.equal(typeof PLUGIN_ADMIN_ACTIONS.UNLOAD, 'string');
  assert.notEqual(PLUGIN_ADMIN_ACTIONS.UNLOAD, PLUGIN_ADMIN_ACTIONS.RELOAD);
});

// ---- the behaviour ---------------------------------------------------------

test('unload stops a live plugin: registration, mount and subscription all go', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-route-'));
  let stack = makeStack();
  await loadProbe(stack, root);

  assertStillLoaded(stack, 'before unload');
  assert.deepEqual(stack.bus.list().map((s) => s.pluginId), [ PLUGIN ], 'subscription present while loaded');

  let { handled, response, json } = await callRoute({
    services: {
      accountStore: identityStore({ id: 'user-1', email: 'a@b.c' }),
      pluginRegistry: stack.registry,
      pluginRouter: stack.router,
      pluginEventBus: stack.bus,
    },
    pathname: '/api/v1/plugins/unload',
    body: { name: PLUGIN },
  });

  assert.equal(handled, true, 'the route must claim the request');
  assert.equal(response.statusCode, 200);
  assert.equal(json.data.unloaded, true);
  assert.equal(json.data.name, PLUGIN);
  assert.equal(json.data.total, 0, 'no plugins should remain loaded');
  assert.deepEqual(json.data.loaded, []);

  // The three surfaces a stopped-but-still-reachable plugin would keep serving.
  assert.equal(stack.registry._pluginRegistrations.has(PLUGIN), false, 'registration must be gone');
  assert.deepEqual(stack.router.listMounts(), [], 'mount must be gone');
  assert.deepEqual(stack.bus.list(), [], 'subscription must be gone');
});

test('unload reports the directory it freed, without leaking an absolute path', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-route-'));
  let stack = makeStack();
  await loadProbe(stack, root);

  let { json } = await callRoute({
    services: {
      accountStore: identityStore({ id: 'user-1', email: 'a@b.c' }),
      pluginRegistry: stack.registry,
      pluginRouter: stack.router,
    },
    pathname: '/api/v1/plugins/unload',
    body: { name: PLUGIN },
  });

  // Same posture as the inventory route: an authenticated caller still does not need
  // the operator's filesystem layout.
  assert.equal(typeof json.data.location, 'string');
  assert.ok(json.data.location.length > 0, 'the location must be reported');
  assert.equal(json.data.location.includes(root), false, 'location must not be an absolute path');
});

test('unload of an unknown name is a 404 and does not disturb a loaded plugin', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-route-'));
  let stack = makeStack();
  await loadProbe(stack, root);

  let { response, json } = await callRoute({
    services: {
      accountStore: identityStore({ id: 'user-1', email: 'a@b.c' }),
      pluginRegistry: stack.registry,
      pluginRouter: stack.router,
    },
    pathname: '/api/v1/plugins/unload',
    body: { name: 'no-such-plugin' },
  });

  assert.equal(response.statusCode, 404);
  assert.match(json.error.message, /is not loaded/);
  // The wrong target must not read as a successful stop, so the response names what
  // IS loaded — and the loaded plugin is untouched.
  assert.deepEqual(json.data.loaded, [ PLUGIN ]);
  assertStillLoaded(stack, 'after a 404');
});

test('unload without a name is a 400 and does not unload anything', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-route-'));
  let stack = makeStack();
  await loadProbe(stack, root);

  let { response } = await callRoute({
    services: {
      accountStore: identityStore({ id: 'user-1', email: 'a@b.c' }),
      pluginRegistry: stack.registry,
      pluginRouter: stack.router,
    },
    pathname: '/api/v1/plugins/unload',
    body: { name: '   ' },
  });

  assert.equal(response.statusCode, 400);
  assertStillLoaded(stack, 'after a 400');
});

test('unload answers 503 when a router exists but no plugin registry does', async () => {
  // handlePluginRoutes bails out with `false` when there is no pluginRouter at all, so
  // no admin branch is reachable in that case — that is the pre-existing shape of every
  // admin route here (inventory, install, reload included), not something unload
  // introduces. The guard that IS reachable is the missing-registry one, and it must
  // report unavailability rather than answering as though the unload happened.
  let { response, json } = await callRoute({
    services: {
      accountStore: identityStore({ id: 'user-1', email: 'a@b.c' }),
      pluginRouter: new PluginRouter({ logger: silent }),
    },
    pathname: '/api/v1/plugins/unload',
    body: { name: PLUGIN },
  });

  assert.equal(response.statusCode, 503);
  assert.match(json.error.message, /unavailable/);
});

test('with no plugin router the request is not a plugin admin request at all', async () => {
  // Pinned rather than assumed: the route reports "not mine" so the built-in chain
  // continues, rather than answering 200 to a request it never handled.
  let { handled, response } = await callRoute({
    services: { accountStore: identityStore({ id: 'user-1', email: 'a@b.c' }) },
    pathname: '/api/v1/plugins/unload',
    body: { name: PLUGIN },
  });

  assert.equal(handled, false);
  assert.equal(response.statusCode, 0, 'an unhandled request must not write a status');
});

// ---- the whole cycle, on one process ---------------------------------------

test('install, unload and install again work in sequence on one running process', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-route-'));
  let stack = makeStack();
  let dir = await writePlugin(root, PLUGIN);
  let services = {
    accountStore: identityStore({ id: 'user-1', email: 'a@b.c' }),
    pluginRegistry: stack.registry,
    pluginRouter: stack.router,
    pluginEventBus: stack.bus,
    pluginMigrations: stack.migrations,
    commandRegistry: {},
    config: fakeConfig({ installEnabled: true, pluginPaths: dir }),
  };

  let installed = await callRoute({
    services, pathname: '/api/v1/plugins/install', body: { path: dir },
  });
  assert.equal(installed.response.statusCode, 201, JSON.stringify(installed.json));
  assertStillLoaded(stack, 'after install');

  let unloaded = await callRoute({
    services, pathname: '/api/v1/plugins/unload', body: { name: PLUGIN },
  });
  assert.equal(unloaded.response.statusCode, 200);
  assert.deepEqual(stack.router.listMounts(), [], 'mount must be gone between unload and reinstall');

  // This is the assertion the exit criterion is actually about: an unload is not a
  // one-way door. The loader re-imports with a cache-busting query, so `setup()` runs
  // again rather than the process reusing the module it already evaluated.
  let reinstall = await callRoute({
    services, pathname: '/api/v1/plugins/install', body: { path: dir },
  });
  assert.equal(reinstall.response.statusCode, 201, JSON.stringify(reinstall.json));
  assertStillLoaded(stack, 'after reinstall');
  assert.deepEqual(stack.bus.list().map((s) => s.pluginId), [ PLUGIN ], 'subscription re-established, not duplicated');
});
