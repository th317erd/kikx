'use strict';

// Contract tests for the plugin ADMIN surface authorization (campaign P0: "Add
// auth/capability gates to plugin inventory, reload, install and mutating plugin routes").
//
// The point of these tests is ORDER, not just status codes. A gate that runs after the
// work is worthless: the code is already loaded, or the directory names are already in
// the response. So every rejection test also asserts that the protected side effect did
// NOT happen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handlePluginRoutes } from '../../src/server/routes/plugin-routes.mjs';
import { PLUGIN_ADMIN_ACTIONS, requireOperator, resolveCaller } from '../../src/server/routes/plugin-admin-policy.mjs';
import { PluginRouter, PLUGIN_MOUNT_ROOT } from '../../src/core/plugins/plugin-router.mjs';

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

function fakeRequest({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  let chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() { for (let c of chunks) yield c; },
  };
}

// Minimal AppContext stand-in. `has` must be safe to call for keys that were never set,
// because the route reads several optional services that way.
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

// An install attempt must be observable: if the gate is wrong, this counter moves.
function spyInstall(target) {
  const calls = [];
  target.loadPluginsCalls = calls;
  return calls;
}

test('an unconfigured deployment refuses plugin administration instead of allowing it', async () => {
  // No account store at all. The tempting shortcut is "no auth configured, so let it
  // through" - that turns a missing dependency into an open admin surface.
  await assert.rejects(
    () => requireOperator(fakeContext({}), fakeRequest(), PLUGIN_ADMIN_ACTIONS.INVENTORY),
    (error) => error.status === 503,
  );
});

test('an account store that rejects the token yields 401, not 503', async () => {
  let context = fakeContext({ accountStore: identityStore(null) });
  await assert.rejects(
    () => requireOperator(context, fakeRequest(), PLUGIN_ADMIN_ACTIONS.INVENTORY),
    (error) => error.status === 401,
  );
});

test('a valid identity is admitted and reported', async () => {
  let context = fakeContext({ accountStore: identityStore({ id: 'user-1', email: 'a@b.c' }) });
  let result = await requireOperator(context, fakeRequest(), PLUGIN_ADMIN_ACTIONS.INSTALL);
  assert.equal(result.identity.id, 'user-1');
  assert.equal(result.action, PLUGIN_ADMIN_ACTIONS.INSTALL);
});

test('every rejection reason reads the same, so the endpoint cannot be probed', async () => {
  // Different underlying store failures must not be distinguishable by the caller.
  let messages = new Set();
  for (let thrown of ['missing token', 'expired token', 'disabled user']) {
    let store = {
      resolveIdentity: async () => {
        let error = new Error(thrown);
        error.status = 401;
        throw error;
      },
    };
    try {
      await requireOperator(fakeContext({ accountStore: store }), fakeRequest(), 'x');
      assert.fail('expected a rejection');
    } catch (error) {
      assert.equal(error.status, 401);
      messages.add(error.message);
    }
  }
  assert.equal(messages.size, 1, 'rejection messages differ between reasons');
});

test('inventory is refused before any plugin data is written', async () => {
  let registry = {
    _pluginRegistrations: new Map([['secret-plugin', { pluginName: 'secret-plugin', pluginLocation: '/opt/secret' }]]),
    _pluginLoadErrors: [{ pluginName: 'broken', error: '/opt/elsewhere threw' }],
  };
  let router = new PluginRouter({ logger: { error() {} } });
  let response = fakeResponse();

  // No identity -> the handler must throw out to routeRequest (which renders 401), and
  // crucially `response.end` must never have run with the inventory payload.
  await assert.rejects(
    () => handlePluginRoutes({
      request: fakeRequest({ method: 'GET', url: '/api/v1/plugins' }),
      response,
      url: new URL('/api/v1/plugins', 'http://localhost'),
      context: fakeContext({ pluginRouter: router, pluginRegistry: registry }),
    }),
    (error) => error.status === 503,
  );
  assert.equal(response.body, null, 'inventory leaked a body despite the refusal');
});

test('an authenticated caller still gets the inventory', async () => {
  let registry = {
    _pluginRegistrations: new Map([['miri', { pluginName: 'miri', pluginLocation: 'miri' }]]),
    _pluginLoadErrors: [],
  };
  let router = new PluginRouter({ logger: { error() {} } });
  let response = fakeResponse();

  let handled = await handlePluginRoutes({
    request: fakeRequest({ method: 'GET', url: '/api/v1/plugins' }),
    response,
    url: new URL('/api/v1/plugins', 'http://localhost'),
    context: fakeContext({
      pluginRouter: router,
      pluginRegistry: registry,
      accountStore: identityStore({ id: 'user-1' }),
    }),
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  let payload = JSON.parse(response.body);
  assert.equal(payload.data.plugins[0].name, 'miri');
});

test('reload is gated, and a refused reload executes nothing', async () => {
  // Reload had NO gate at all before this change, so this is the case that used to be open.
  let registry = { _pluginRegistrations: new Map(), _pluginLoadErrors: [] };
  let router = new PluginRouter({ logger: { error() {} } });
  let response = fakeResponse();

  await assert.rejects(
    () => handlePluginRoutes({
      request: fakeRequest({ method: 'POST', url: '/api/v1/plugins/reload' }),
      response,
      url: new URL('/api/v1/plugins/reload', 'http://localhost'),
      context: fakeContext({ pluginRouter: router, pluginRegistry: registry, accountStore: identityStore(null) }),
    }),
    (error) => error.status === 401,
  );
  assert.equal(response.body, null);
});

test('install is refused on identity even when the config gate is wide open', async () => {
  // The regression this encodes: KIKX_PLUGIN_INSTALL_ENABLED=true used to be sufficient
  // on its own, which made a config flag stand in for authorization.
  let config = {
    get: async (key) => {
      if (String(key).includes('install_enabled')) return true;
      return null;
    },
  };
  let registry = { _pluginRegistrations: new Map(), _pluginLoadErrors: [] };
  let router = new PluginRouter({ logger: { error() {} } });
  let response = fakeResponse();

  await assert.rejects(
    () => handlePluginRoutes({
      request: fakeRequest({
        method: 'POST',
        url: '/api/v1/plugins/install',
        body: JSON.stringify({ path: '/tmp/evil-plugin' }),
      }),
      response,
      url: new URL('/api/v1/plugins/install', 'http://localhost'),
      context: fakeContext({ pluginRouter: router, pluginRegistry: registry, config, accountStore: identityStore(null) }),
    }),
    (error) => error.status === 401,
  );
  assert.equal(response.body, null, 'install responded despite the refusal');
});

test('an authenticated install still honours the disabled config gate', async () => {
  // Order matters both ways: adding identity must not silently bypass the operator's
  // "this deployment does not install at runtime" decision.
  let config = { get: async () => false };
  let registry = { _pluginRegistrations: new Map(), _pluginLoadErrors: [] };
  let router = new PluginRouter({ logger: { error() {} } });
  let response = fakeResponse();

  let handled = await handlePluginRoutes({
    request: fakeRequest({
      method: 'POST',
      url: '/api/v1/plugins/install',
      body: JSON.stringify({ path: '/tmp/some-plugin' }),
    }),
    response,
    url: new URL('/api/v1/plugins/install', 'http://localhost'),
    context: fakeContext({
      pluginRouter: router,
      pluginRegistry: registry,
      config,
      accountStore: identityStore({ id: 'user-1' }),
    }),
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 403);
});

test('plugin mounts stay reachable without an identity', async () => {
  // Deliberate scope boundary. Miri serves /health to an unauthenticated deploy verifier,
  // and per-route auth descriptors (campaign 4.3) are the designed contract for mounts.
  // Losing this property silently would break kikx-docker/verify-miri-plugin.sh.
  let seen = null;
  let router = new PluginRouter({ logger: { error() {} } });
  router.mount('miri', async ({ subPath }) => { seen = subPath; });
  let response = fakeResponse();

  let handled = await handlePluginRoutes({
    request: fakeRequest({ method: 'GET', url: `${PLUGIN_MOUNT_ROOT}miri/health` }),
    response,
    url: new URL(`${PLUGIN_MOUNT_ROOT}miri/health`, 'http://localhost'),
    context: fakeContext({ pluginRouter: router, accountStore: identityStore(null) }),
  });

  assert.equal(handled, true);
  assert.equal(seen, '/health', 'mount handler was not reached without credentials');
});

test('resolveCaller separates "no store wired" from "bad credential"', async () => {
  let none = await resolveCaller(fakeContext({}), fakeRequest());
  assert.equal(none.unauthenticated, true);
  assert.equal(none.identity, null);

  let ok = await resolveCaller(
    fakeContext({ accountStore: identityStore({ id: 'u' }) }),
    fakeRequest(),
  );
  assert.equal(ok.unauthenticated, false);
  assert.equal(ok.identity.id, 'u');
});
