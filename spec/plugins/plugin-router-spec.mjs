'use strict';

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

function mountWith(handler, options = {}) {
  let router = new PluginRouter({ logger: { error() {} }, ...options });
  let path = router.mount('miri', handler);
  return { router, path };
}

test('mount path is derived from the plugin id', () => {
  assert.equal(PluginRouter.mountPathFor('miri'), `${PLUGIN_MOUNT_ROOT}miri/`);
  assert.equal(PluginRouter.mountPathFor('kikx-plugin-miri'), `${PLUGIN_MOUNT_ROOT}kikx-plugin-miri/`);
});

test('reserved plugin ids are refused', () => {
  for (let id of ['plugins', 'v1', 'api', 'V1', 'API']) {
    assert.throws(() => PluginRouter.mountPathFor(id), /reserved/, id);
  }
});

test('unsafe plugin ids are refused', () => {
  for (let id of ['../etc', 'a/b', 'a b', '', '.hidden', '-leading']) {
    assert.throws(() => PluginRouter.mountPathFor(id), TypeError, id);
  }
});

test('duplicate mount is refused', () => {
  let router = new PluginRouter({ logger: { error() {} } });
  router.mount('miri', async () => {});
  assert.throws(() => router.mount('miri', async () => {}), /already has an HTTP mount/);
});

test('a non-function handler is refused', () => {
  let router = new PluginRouter({ logger: { error() {} } });
  assert.throws(() => router.mount('miri', 'nope'), TypeError);
});

test('matching captures the sub path below the mount', () => {
  let { router } = mountWith(async () => {});
  let m = router.match(`${PLUGIN_MOUNT_ROOT}miri/v1/auth/login`);
  assert.ok(m);
  assert.equal(m.subPath, '/v1/auth/login');
  assert.equal(m.mount.pluginId, 'miri');
});

test('a path outside any mount does not match', () => {
  let { router } = mountWith(async () => {});
  assert.equal(router.match('/api/v1/auth/me'), null);
  assert.equal(router.match(`${PLUGIN_MOUNT_ROOT}nosuch/x`), null);
});

test('the handler receives raw bytes and can parse them itself', async () => {
  let seen = null;
  let { router } = mountWith(async ({ rawBody, json }) => { seen = { raw: rawBody.toString(), parsed: json() }; });
  let match = router.match(`${PLUGIN_MOUNT_ROOT}miri/echo`);
  await router.invoke({ match, request: fakeRequest({ body: '{"a":1}' }), response: fakeResponse(), context: {} });
  assert.equal(seen.raw, '{"a":1}');
  assert.deepEqual(seen.parsed, { a: 1 });
});

test('a throwing handler yields 500 and does not propagate', async () => {
  let { router } = mountWith(async () => { throw new Error('boom'); });
  let match = router.match(`${PLUGIN_MOUNT_ROOT}miri/echo`);
  let response = fakeResponse();
  await router.invoke({ match, request: fakeRequest(), response, context: {} });
  assert.equal(response.statusCode, 500);
  assert.match(String(response.body), /Plugin handler failed/);
});

test('a handler that never settles yields 504', async () => {
  let { router } = mountWith(() => new Promise(() => {}), { handlerTimeoutMS: 50 });
  let match = router.match(`${PLUGIN_MOUNT_ROOT}miri/slow`);
  let response = fakeResponse();
  await router.invoke({ match, request: fakeRequest(), response, context: {} });
  assert.equal(response.statusCode, 504);
});

test('an oversized body yields 413 without reaching the handler', async () => {
  let reached = false;
  let { router } = mountWith(async () => { reached = true; }, { maxBodyBytes: 16 });
  let match = router.match(`${PLUGIN_MOUNT_ROOT}miri/big`);
  let response = fakeResponse();
  await router.invoke({
    match,
    request: fakeRequest({ body: 'x'.repeat(64) }),
    response,
    context: {},
  });
  assert.equal(response.statusCode, 413);
  assert.equal(reached, false);
});

test('a declared oversize content-length is refused before reading', async () => {
  let { router } = mountWith(async () => {}, { maxBodyBytes: 16 });
  let match = router.match(`${PLUGIN_MOUNT_ROOT}miri/big`);
  let response = fakeResponse();
  await router.invoke({
    match,
    request: fakeRequest({ headers: { 'content-length': '9999' }, body: 'x' }),
    response,
    context: {},
  });
  assert.equal(response.statusCode, 413);
});
