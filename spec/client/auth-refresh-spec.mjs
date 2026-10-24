'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { document, window } = installDom();
globalThis.document = document;
globalThis.window = window;

const { refreshAuthToken } = await import('../../src/client/components/kikx-data.mjs');

function createStorage() {
  let values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

function installStorage() {
  let session = createStorage();
  let local = createStorage();
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;
  return { session, local };
}

test('refreshAuthToken rotates the access token and persists the new session', async () => {
  installStorage();
  let requests = [];
  let originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      data: {
        token: 'access-2',
        refresh_token: 'refresh-2',
        expires_at: 12345,
        user: { id: 'usr_1', name: 'Wyatt' },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    let app = {
      _state: {
        authToken: 'expired',
        refreshToken: 'refresh-1',
        account: { id: 'usr_1', name: 'Wyatt' },
      },
    };
    assert.equal(await refreshAuthToken(app), true);
    assert.equal(app._state.authToken, 'access-2');
    assert.equal(app._state.refreshToken, 'refresh-2');
    assert.equal(requests[0].url, '/api/v1/auth/refresh');
    assert.deepEqual(JSON.parse(requests[0].options.body), { refresh_token: 'refresh-1' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshAuthToken is a no-op without a refresh token', async () => {
  installStorage();
  let app = { _state: { authToken: 'expired', refreshToken: '' } };
  assert.equal(await refreshAuthToken(app), false);
  assert.equal(app._state.authToken, 'expired');
});

test('refreshAuthToken single-flights concurrent refresh requests', async () => {
  installStorage();
  let resolveFetch;
  let calls = 0;
  let originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return await new Promise((resolve) => {
      resolveFetch = () => resolve(new Response(JSON.stringify({
        data: { token: 'access-2', refresh_token: 'refresh-2', expires_at: 12345 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
  };
  try {
    let app = { _state: { authToken: 'expired', refreshToken: 'refresh-1' } };
    let first = refreshAuthToken(app);
    let second = refreshAuthToken(app);
    assert.equal(calls, 1);
    resolveFetch();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(app._state.refreshToken, 'refresh-2');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshAuthToken adopts a newer shared tab session before refreshing', async () => {
  let storage = installStorage();
  storage.local.setItem('kikx.auth.shared', JSON.stringify({
    token: 'shared-access',
    refresh_token: 'shared-refresh',
    expires_at: Date.now() + 60_000,
  }));
  let calls = 0;
  let originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('should not refresh');
  };
  try {
    let app = { _state: { authToken: 'expired', refreshToken: 'stale-refresh' } };
    assert.equal(await refreshAuthToken(app), true);
    assert.equal(calls, 0);
    assert.equal(app._state.authToken, 'shared-access');
    assert.equal(app._state.refreshToken, 'shared-refresh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshAuthToken recovers if a sibling tab rotates during the request', async () => {
  let storage = installStorage();
  let originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    storage.local.setItem('kikx.auth.shared', JSON.stringify({
      token: 'sibling-access',
      refresh_token: 'sibling-refresh',
      expires_at: Date.now() + 60_000,
    }));
    return new Response(JSON.stringify({ error: { message: 'Refresh token is invalid or expired' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    let app = { _state: { authToken: 'expired', refreshToken: 'stale-refresh' } };
    assert.equal(await refreshAuthToken(app), true);
    assert.equal(app._state.authToken, 'sibling-access');
    assert.equal(app._state.refreshToken, 'sibling-refresh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
