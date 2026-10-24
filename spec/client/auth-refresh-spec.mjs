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

function installStorage() {
  let values = new Map();
  globalThis.sessionStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
  return values;
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
