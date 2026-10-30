'use strict';

// Per-mount request limits and deterministic mount error mapping (campaign 4.3,
// P3 exit proof: "oversized body, malformed JSON, timeout and handler failure are
// deterministic").
//
// Before this spec the router had ONE deployment-wide body cap and ONE deadline,
// taken from the PluginRouter constructor. A plugin could not declare that its own
// mount is a webhook endpoint with a small body and a short deadline, and nothing
// in the inventory said which mounts were public or how big a request they accept.
// Three of these tests fail against the constructor-only router; the rest pin
// behaviour that must not regress.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PluginRouter, PLUGIN_MOUNT_ROOT } from '../../src/core/plugins/plugin-router.mjs';

function fakeRequest({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  let chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() { for (let c of chunks) yield c; },
  };
}

function fakeResponse() {
  return {
    statusCode: 0,
    headersSent: false,
    body: null,
    destroyed: false,
    writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
    end(payload) { if (payload !== undefined) this.body = String(payload); },
    destroy() { this.destroyed = true; this.headersSent = true; },
  };
}

function bodyOf(response) {
  try { return JSON.parse(String(response.body)); } catch { return null; }
}

async function call(router, path, requestOptions = {}, context = {}) {
  let response = fakeResponse();
  let match = router.match(`${PLUGIN_MOUNT_ROOT}miri/${path}`);
  assert.ok(match, `expected a match for ${path}`);
  await router.invoke({ match, request: fakeRequest(requestOptions), response, context });
  return response;
}

function routerWith(options = {}) {
  return new PluginRouter({ logger: { error() {} }, ...options });
}

// ---------------------------------------------------------------------------
// Per-mount body limits
// ---------------------------------------------------------------------------

test('a mount may declare a body cap tighter than the deployment cap', async () => {
  let reached = false;
  let router = routerWith({ maxBodyBytes: 1024 });
  router.mount('miri', async () => { reached = true; }, { auth: 'public', maxBodyBytes: 16 });

  let response = await call(router, 'hook', { method: 'POST', body: 'x'.repeat(64) });

  assert.equal(response.statusCode, 413);
  assert.equal(reached, false, 'the handler must not run for an oversized body');
  assert.equal(bodyOf(response)?.error?.message, 'Request body too large');
});

test('a tighter per-mount cap does not affect a second mount', async () => {
  let smallReached = false;
  let largeReached = false;
  let router = routerWith({ maxBodyBytes: 1024 });
  router.mount('miri', async () => { smallReached = true; }, { auth: 'public', maxBodyBytes: 16 });

  let response = await call(router, 'hook', { method: 'POST', body: 'x'.repeat(64) });
  assert.equal(response.statusCode, 413);
  assert.equal(smallReached, false);

  // A second plugin with no declaration still gets the deployment cap.
  router.mount('other', async () => { largeReached = true; }, { auth: 'public' });
  let otherResponse = fakeResponse();
  await router.invoke({
    match: router.match(`${PLUGIN_MOUNT_ROOT}other/upload`),
    request: fakeRequest({ method: 'POST', body: 'x'.repeat(64) }),
    response: otherResponse,
    context: {},
  });
  assert.equal(otherResponse.statusCode, 0);
  assert.equal(largeReached, true);
});

test('a per-mount body cap cannot raise the deployment cap', async () => {
  let reached = false;
  let router = routerWith({ maxBodyBytes: 32 });
  // The plugin asks for a bigger cap than the operator allowed. The operator wins.
  router.mount('miri', async () => { reached = true; }, { auth: 'public', maxBodyBytes: 1024 });

  let response = await call(router, 'hook', { method: 'POST', body: 'x'.repeat(64) });

  assert.equal(response.statusCode, 413);
  assert.equal(reached, false);
  assert.equal(router.listMounts()[0].maxBodyBytes, 32, 'inventory reports the enforced value, not the request');
});

test('an invalid or non-finite body cap is refused at mount time', () => {
  let router = routerWith();
  for (let bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '16']) {
    assert.throws(
      () => router.mount('miri', async () => {}, { auth: 'public', maxBodyBytes: bad }),
      /maxBodyBytes/,
      `expected ${String(bad)} to be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-mount deadlines
// ---------------------------------------------------------------------------

test('a mount may declare a deadline tighter than the deployment deadline', async () => {
  let router = routerWith({ handlerTimeoutMS: 30000 });
  router.mount('miri', () => new Promise(() => {}), { auth: 'public', handlerTimeoutMS: 40 });

  let response = await call(router, 'slow');

  assert.equal(response.statusCode, 504);
  assert.equal(bodyOf(response)?.error?.message, 'Plugin handler timed out');
});

test('a per-mount deadline cannot raise the deployment deadline', async () => {
  let router = routerWith({ handlerTimeoutMS: 40 });
  router.mount('miri', () => new Promise(() => {}), { auth: 'public', handlerTimeoutMS: 60000 });

  let response = await call(router, 'slow');

  assert.equal(response.statusCode, 504);
  assert.equal(router.listMounts()[0].handlerTimeoutMS, 40);
});

test('an invalid deadline is refused at mount time', () => {
  let router = routerWith();
  for (let bad of [0, -5, Number.NaN, '40']) {
    assert.throws(
      () => router.mount('miri', async () => {}, { auth: 'public', handlerTimeoutMS: bad }),
      /handlerTimeoutMS/,
      `expected ${String(bad)} to be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Malformed JSON is a client error, not a handler failure
// ---------------------------------------------------------------------------

test('malformed JSON that reaches core is a deterministic 400', async () => {
  // The plugin parses and does not catch: the client sent broken JSON, so the
  // answer must say so rather than blaming the plugin with a 500.
  let router = routerWith();
  router.mount('miri', async ({ json }) => { json(); }, { auth: 'public' });

  let response = await call(router, 'echo', { method: 'POST', body: '{"a":' });

  assert.equal(response.statusCode, 400);
  assert.equal(bodyOf(response)?.error?.message, 'Malformed JSON request body');
});

test('a plugin may catch the malformed-JSON error and answer differently', async () => {
  // The raw bytes are still valid input the plugin may want to inspect (a webhook
  // signature, a form-encoded body). Core must not decide the response for it.
  let router = routerWith();
  router.mount('miri', async ({ json, response }) => {
    try { json(); } catch { response.writeHead(422); response.end('no'); return; }
  }, { auth: 'public' });

  let response = await call(router, 'echo', { method: 'POST', body: 'not json' });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body, 'no');
});

test('an empty body is not malformed JSON', async () => {
  let seen = 'unset';
  let router = routerWith();
  router.mount('miri', async ({ json }) => { seen = json(); }, { auth: 'public' });

  let response = await call(router, 'echo', { method: 'POST', body: '' });

  assert.equal(response.statusCode, 0);
  assert.equal(seen, null);
});

// ---------------------------------------------------------------------------
// Handler failure mapping does not leak plugin text
// ---------------------------------------------------------------------------

test('a plugin error keeps the generic body regardless of the status it chose', async () => {
  let router = routerWith();
  router.mount('miri', async () => {
    throw Object.assign(new Error('connection string postgres://user:hunter2@db'), { status: 400 });
  }, { auth: 'public' });

  let response = await call(router, 'boom');

  assert.equal(response.statusCode, 400, "the plugin's status is honoured");
  assert.equal(bodyOf(response)?.error?.message, 'Plugin handler failed', 'but its message is not echoed');
  assert.doesNotMatch(String(response.body), /hunter2/);
});

test('a plugin error without a status is a 500 with the generic body', async () => {
  let router = routerWith();
  router.mount('miri', async () => { throw new Error('secret internals'); }, { auth: 'public' });

  let response = await call(router, 'boom');

  assert.equal(response.statusCode, 500);
  assert.equal(bodyOf(response)?.error?.message, 'Plugin handler failed');
  assert.equal(bodyOf(response)?.error?.status, 500);
});

// ---------------------------------------------------------------------------
// Mount dispose on unmount and on reload
// ---------------------------------------------------------------------------

test('unmounting runs the mount dispose exactly once', () => {
  let disposals = 0;
  let router = routerWith();
  router.mount('miri', async () => {}, { auth: 'public', dispose: () => { disposals += 1; } });

  assert.equal(router.unmount('miri'), true);
  assert.equal(disposals, 1);
  assert.equal(router.unmount('miri'), false, 'a second unmount releases nothing');
  assert.equal(disposals, 1, 'and does not run dispose again');
});

test('re-mounting a plugin disposes the handler it replaced', () => {
  let first = 0;
  let second = 0;
  let router = routerWith();
  router.mount('miri', async () => {}, { auth: 'public', dispose: () => { first += 1; } });
  router.mount('miri', async () => {}, { auth: 'public', dispose: () => { second += 1; } });

  assert.equal(first, 1, 'the replaced mount is disposed or a reload leaks it');
  assert.equal(second, 0, 'the live mount is not');

  router.unmount('miri');
  assert.equal(second, 1);
});

test('a mount is unroutable immediately even when its dispose throws', () => {
  let router = routerWith();
  router.mount('miri', async () => {}, {
    auth: 'public',
    dispose: () => { throw new Error('cleanup exploded'); },
  });

  assert.equal(router.unmount('miri'), true);
  assert.equal(router.match(`${PLUGIN_MOUNT_ROOT}miri/health`), null, 'unload must not be blocked by cleanup');
});

test('a non-function dispose is refused at mount time', () => {
  let router = routerWith();
  assert.throws(
    () => router.mount('miri', async () => {}, { auth: 'public', dispose: 'nope' }),
    /dispose/,
  );
});

// ---------------------------------------------------------------------------
// Inventory is auditable
// ---------------------------------------------------------------------------

test('mount inventory reports auth and the enforced limits', () => {
  let router = routerWith({ maxBodyBytes: 512, handlerTimeoutMS: 2000 });
  router.mount('miri', async () => {}, { auth: 'public', maxBodyBytes: 64, handlerTimeoutMS: 100 });
  router.mount('private', async () => {});

  let byId = new Map(router.listMounts().map((m) => [m.pluginId, m]));

  // "public must be declared and reviewed" is only auditable if it is visible.
  assert.equal(byId.get('miri').auth, 'public');
  assert.equal(byId.get('miri').maxBodyBytes, 64);
  assert.equal(byId.get('miri').handlerTimeoutMS, 100);
  assert.equal(byId.get('miri').disposable, false);
  assert.equal(byId.get('private').auth, 'required', 'authenticated by default stays the default');
  assert.equal(byId.get('private').maxBodyBytes, 512, 'undeclared limits fall back to the deployment values');
  assert.equal(byId.get('private').handlerTimeoutMS, 2000);
});

test('a zero body cap is allowed so a mount can refuse request bodies outright', async () => {
  let reached = false;
  let router = routerWith({ maxBodyBytes: 1024 });
  router.mount('miri', async () => { reached = true; }, { auth: 'public', maxBodyBytes: 0 });
  assert.equal(router.listMounts()[0].maxBodyBytes, 0);

  let response = await call(router, 'nobody', { method: 'POST', body: 'x' });
  assert.equal(response.statusCode, 413);
  assert.equal(reached, false);

  // A bodyless request still gets through.
  response = await call(router, 'nobody', { method: 'GET' });
  assert.equal(response.statusCode, 0);
  assert.equal(reached, true);
});
