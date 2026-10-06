'use strict';

// HTTP surface for the Kikx-native auth subsystem. These specs drive
// handleAuthRoutes directly with fake request/response objects, a stub context,
// and a recording authService, so every endpoint, validation branch and 401
// gate is asserted without a real driver or socket.

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAuthRoutes } from '../../src/server/routes/auth-routes.mjs';

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function createRequest({ method = 'POST', headers = {}, body = null } = {}) {
  let chunks = body === null ? [] : [ Buffer.from(JSON.stringify(body)) ];
  return {
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (let chunk of chunks)
        yield chunk;
    },
  };
}

function createContext(services) {
  return {
    require(key) {
      if (!(key in services))
        throw new Error(`Required service is not registered: ${key}`);

      return services[key];
    },
    has(key) {
      return key in services;
    },
  };
}

function createFakeAuthService() {
  let calls = [];
  return {
    calls,
    async requestMagicLink(email, meta) {
      calls.push({ method: 'requestMagicLink', email, meta });
      return { ok: true };
    },
    async verifyMagicLink(code, meta) {
      calls.push({ method: 'verifyMagicLink', code, meta });
      return { token: 'access', refresh_token: 'refresh', expires_at: 123, user: { id: 'usr_1' } };
    },
    async exchangeApiKey(apiKey) {
      calls.push({ method: 'exchangeApiKey', apiKey });
      return { token: 'access', refresh_token: 'refresh', expires_at: 123 };
    },
    async refreshToken(refreshToken) {
      calls.push({ method: 'refreshToken', refreshToken });
      return { token: 'access', refresh_token: 'refresh', expires_at: 123 };
    },
    async revokeSession(sessionId) {
      calls.push({ method: 'revokeSession', sessionId });
      return true;
    },
    publicUser(user) {
      return user ? { id: user.id, email: user.email, username: user.username, name: user.name } : null;
    },
    async getUser(id) {
      calls.push({ method: 'getUser', id });
      return { id, email: 'me@example.com', username: 'me', name: 'Me', roles: [ 'user' ] };
    },
    async listApiKeys(userId) {
      calls.push({ method: 'listApiKeys', userId });
      return [ { id: 'key_1', label: 'laptop', prefix: 'abcd1234' } ];
    },
    async createApiKey(userId, options) {
      calls.push({ method: 'createApiKey', userId, options });
      return { key: { id: 'key_2', label: options.label }, apiKey: 'key_2.secret' };
    },
    async revokeApiKey(userId, keyId) {
      calls.push({ method: 'revokeApiKey', userId, keyId });
      return keyId === 'key_1';
    },
  };
}

function createFakeAccountStore(identity = null) {
  return {
    async resolveIdentity() {
      if (!identity) {
        let error = new Error('Sign in before opening account settings');
        error.status = 401;
        throw error;
      }

      return identity;
    },
  };
}

async function invoke({ method = 'POST', path, body = null, headers = {}, identity = null, authService = createFakeAuthService() }) {
  let request = createRequest({ method, headers, body });
  let response = createResponse();
  let context = createContext({
    authService,
    accountStore: createFakeAccountStore(identity),
  });
  try {
    let handled = await handleAuthRoutes({ request, response, url: new URL(`http://localhost${path}`), context });
    return { handled, response, body: response.body == null ? null : response.json(), authService };
  } catch (error) {
    return {
      handled: true,
      response: { statusCode: error.status || 500 },
      body: { error: { message: error.message } },
      authService,
    };
  }
}

test('POST /api/v1/auth/magic-link forwards email, redirect and request metadata', async () => {
  let result = await invoke({
    path: '/api/v1/auth/magic-link',
    body: { email: 'alice@example.com', redirect: '/app' },
    headers: { 'user-agent': 'kikx-test' },
  });

  assert.equal(result.handled, true);
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, { data: { ok: true } });
  assert.deepEqual(result.authService.calls[0], {
    method: 'requestMagicLink',
    email: 'alice@example.com',
    meta: { redirectTo: '/app', userAgent: 'kikx-test', ip: '127.0.0.1' },
  });
});

test('POST /api/v1/auth/magic-link rejects a missing or non-string email', async () => {
  let missing = await invoke({ path: '/api/v1/auth/magic-link', body: {} });
  assert.equal(missing.response.statusCode, 400);
  assert.deepEqual(missing.body, { error: { message: 'email is required' } });

  let nonString = await invoke({ path: '/api/v1/auth/magic-link', body: { email: 42 } });
  assert.equal(nonString.response.statusCode, 400);
  assert.equal(nonString.body.error.message, 'email is required');
});

test('GET /api/v1/auth/magic-link/verify forwards the code', async () => {
  let result = await invoke({ method: 'GET', path: '/api/v1/auth/magic-link/verify?code=abc123' });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.authService.calls[0].method, 'verifyMagicLink');
  assert.deepEqual(result.authService.calls[0].code, 'abc123');
  assert.equal(result.body.data.token, 'access');
});

test('GET /api/v1/auth/magic-link/verify rejects a missing code', async () => {
  let result = await invoke({ method: 'GET', path: '/api/v1/auth/magic-link/verify' });
  assert.equal(result.response.statusCode, 400);
  assert.deepEqual(result.body, { error: { message: 'code is required' } });
});

test('POST /api/v1/auth/token exchanges an api key', async () => {
  let result = await invoke({ path: '/api/v1/auth/token', body: { api_key: 'key_1.secret' } });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.authService.calls[0].apiKey, 'key_1.secret');
  assert.equal(result.body.data.token, 'access');
});

test('POST /api/v1/auth/token rejects a missing api_key', async () => {
  let result = await invoke({ path: '/api/v1/auth/token', body: {} });
  assert.equal(result.response.statusCode, 400);
  assert.deepEqual(result.body, { error: { message: 'api_key is required' } });
});

test('POST /api/v1/auth/refresh rotates a refresh token', async () => {
  let result = await invoke({ path: '/api/v1/auth/refresh', body: { refresh_token: 'rt_1' } });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.authService.calls[0].refreshToken, 'rt_1');
  assert.equal(result.body.data.refresh_token, 'refresh');
});

test('POST /api/v1/auth/refresh rejects a missing refresh_token', async () => {
  let result = await invoke({ path: '/api/v1/auth/refresh', body: {} });
  assert.equal(result.response.statusCode, 400);
  assert.deepEqual(result.body, { error: { message: 'refresh_token is required' } });
});

test('POST /api/v1/auth/logout revokes the bearer session', async () => {
  let result = await invoke({
    path: '/api/v1/auth/logout',
    identity: { id: 'usr_1', sessionId: 'sess_1', token: 'access' },
  });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, { data: { ok: true } });
  assert.deepEqual(result.authService.calls, [ { method: 'revokeSession', sessionId: 'sess_1' } ]);
});

test('POST /api/v1/auth/logout tolerates a missing identity', async () => {
  let result = await invoke({ path: '/api/v1/auth/logout', identity: null });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, { data: { ok: true } });
  assert.deepEqual(result.authService.calls, []);
});

test('GET /api/v1/auth/me returns the public user for a valid token', async () => {
  let result = await invoke({
    method: 'GET',
    path: '/api/v1/auth/me',
    identity: { id: 'usr_1', sessionId: 'sess_1', token: 'access' },
  });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, {
    data: { user: { id: 'usr_1', email: 'me@example.com', username: 'me', name: 'Me' } },
  });
});

test('GET /api/v1/auth/me requires a valid token', async () => {
  let result = await invoke({ method: 'GET', path: '/api/v1/auth/me', identity: null });
  assert.equal(result.response.statusCode, 401);
  assert.equal(result.body.error.message, 'Sign in before opening account settings');
});

test('GET /api/v1/auth/api-keys lists keys for the signed-in user', async () => {
  let result = await invoke({
    method: 'GET',
    path: '/api/v1/auth/api-keys',
    identity: { id: 'usr_1', sessionId: 'sess_1', token: 'access' },
  });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, { data: { keys: [ { id: 'key_1', label: 'laptop', prefix: 'abcd1234' } ] } });
  assert.deepEqual(result.authService.calls[0], { method: 'listApiKeys', userId: 'usr_1' });
});

test('GET /api/v1/auth/api-keys requires a valid token', async () => {
  let result = await invoke({ method: 'GET', path: '/api/v1/auth/api-keys', identity: null });
  assert.equal(result.response.statusCode, 401);
});

test('POST /api/v1/auth/api-keys creates a labelled key', async () => {
  let result = await invoke({
    path: '/api/v1/auth/api-keys',
    body: { label: 'laptop' },
    identity: { id: 'usr_1', sessionId: 'sess_1', token: 'access' },
  });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, { data: { key: { id: 'key_2', label: 'laptop' }, apiKey: 'key_2.secret' } });
  assert.deepEqual(result.authService.calls[0], {
    method: 'createApiKey',
    userId: 'usr_1',
    options: { label: 'laptop' },
  });
});

test('POST /api/v1/auth/api-keys requires a valid token', async () => {
  let result = await invoke({ path: '/api/v1/auth/api-keys', body: { label: 'laptop' }, identity: null });
  assert.equal(result.response.statusCode, 401);
});

test('DELETE /api/v1/auth/api-keys/:id revokes an owned key', async () => {
  let result = await invoke({
    method: 'DELETE',
    path: '/api/v1/auth/api-keys/key_1',
    identity: { id: 'usr_1', sessionId: 'sess_1', token: 'access' },
  });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, { data: { revoked: true } });
  assert.deepEqual(result.authService.calls[0], { method: 'revokeApiKey', userId: 'usr_1', keyId: 'key_1' });
});

test('DELETE /api/v1/auth/api-keys/:id returns false for an unknown key', async () => {
  let result = await invoke({
    method: 'DELETE',
    path: '/api/v1/auth/api-keys/key_missing',
    identity: { id: 'usr_1', sessionId: 'sess_1', token: 'access' },
  });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, { data: { revoked: false } });
});

test('DELETE /api/v1/auth/api-keys/:id requires a valid token', async () => {
  let result = await invoke({ method: 'DELETE', path: '/api/v1/auth/api-keys/key_1', identity: null });
  assert.equal(result.response.statusCode, 401);
});

test('unrelated routes are not handled', async () => {
  let result = await invoke({ method: 'GET', path: '/api/v1/other' });
  assert.equal(result.handled, false);
});
