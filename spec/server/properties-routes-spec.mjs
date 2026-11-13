'use strict';

import '../support/test-env.mjs';

// Properties-store P3 (plan: docs/plans/properties-store.md P3): the HTTP
// surface. The identity NEVER reaches the facade (§3) — the route runs as
// the `core` caller and enforces the transport's own scope rules:
//   - default scope = the caller's OWN account (theme writes need no scope),
//   - explicit account scope must equal the caller's id — hostile
//     cross-account reads AND writes are 403,
//   - global read allowed; global write = the identity bar (any signed-in
//     identity; with one operator account that is the owner),
//   - session/plugin scopes are not reachable over HTTP in v1 (403),
//   - secrets come back as hasValue ONLY — the plaintext never crosses the
//     transport, no matter who asks,
//   - optimistic version -> 409, 401/503 gate parity with the auth family.

import assert from 'node:assert/strict';
import test from 'node:test';

import { handlePropertiesRoutes } from '../../src/server/routes/properties-routes.mjs';
import { openPropertiesStore } from '../../src/core/properties/store.mjs';
import { createPropertiesFacade } from '../../src/core/properties/facade.mjs';
import { CorePropertyRegistry } from '../../src/core/properties/registry.mjs';
import { GrantsRegistry } from '../../src/core/properties/grants.mjs';
import { fakeContext, fakeRequest, fakeResponse } from '../support/fake-http.mjs';

const OPERATOR = { id: 'operator-1' };
const OTHER_USER = { id: 'someone-else' };

const silent = { warn() {}, error() {}, info() {}, debug() {}, log() {} };

async function makeContext(t, { withFacade = true, identity = OPERATOR } = {}) {
  const services = {};
  const store = await openPropertiesStore({ driver: 'sqlite', filename: ':memory:', encryptionKey: 'a'.repeat(64) });
  t.after(() => store.close());
  if (withFacade) {
    services.propertiesFacade = createPropertiesFacade({
      store,
      registry: new CorePropertyRegistry(),
      grants: new GrantsRegistry(),
      logger: silent,
    });
  }
  services.accountStore = {
    async resolveIdentity(request) {
      if (request.headers?.['x-no-identity'])
        throw Object.assign(new Error('Sign in required'), { status: 401 });
      return identity;
    },
  };
  return { context: fakeContext(services), store };
}

// Driver: the handler throws httpError for failures (auth-family style) and
// writes JSON on success — both shapes surface as { status, data }.
async function call(context, { method = 'GET', query = '', body, path = '/api/v1/properties' } = {}) {
  const request = fakeRequest({
    method,
    url: `${path}${query}`,
    body: body === undefined ? '' : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  const response = fakeResponse();
  const url = new URL(request.url, 'http://localhost');
  try {
    const handled = await handlePropertiesRoutes({ request, response, url, context });
    if (!handled)
      return { handled: false, status: response.statusCode };
    return { handled: true, status: response.statusCode, data: response.body ? JSON.parse(response.body) : null };
  } catch (error) {
    return {
      handled: false,
      status: error.status || 500,
      error,
      data: { error: { message: String(error.message || error), code: error.code ?? null } },
    };
  }
}

test('gate parity: 401 without identity, 503 without the store — every method', async (t) => {
  const { context } = await makeContext(t);
  for (const method of [ 'GET', 'PUT', 'DELETE' ]) {
    const noIdentity = await call(context, {
      method,
      query: '?key=/core/user/theme/primary_color',
      body: method === 'PUT' ? { value: 'x' } : undefined,
    }).then((result) => result.status);
    // Rebuild with the identity-refusing header.
    const request = fakeRequest({
      method, url: '/api/v1/properties?key=/x',
      body: method === 'PUT' ? JSON.stringify({ value: 1 }) : '',
      headers: { 'x-no-identity': '1' },
    });
    const response = fakeResponse();
    const url = new URL(request.url, 'http://localhost');
    let status;
    try {
      await handlePropertiesRoutes({ request, response, url, context });
      status = response.statusCode;
    } catch (error) {
      status = error.status || 500;
    }
    assert.equal(status, 401, `${method} without identity must 401 (auth-family parity)`);
    assert.ok(noIdentity);
  }

  const bare = await makeContext(t, { withFacade: false });
  for (const method of [ 'GET', 'PUT', 'DELETE' ]) {
    const result = await call(bare.context, {
      method,
      query: '?key=/core/x',
      body: method === 'PUT' ? { value: 1 } : undefined,
    });
    assert.equal(result.status, 503, `${method} without a properties store must 503`);
  }
});

test('default scope = own account: theme writes need no scope, reads come back', async (t) => {
  const { context } = await makeContext(t);
  const put = await call(context, {
    method: 'PUT',
    body: { key: '/core/user/theme/primary_color', value: 'purple' },
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.data.value, 'purple');
  assert.equal(put.data.data.hasValue, true);
  assert.equal(put.data.data.version, 1);
  assert.equal(put.data.data.updated_by, OPERATOR.id, 'audit seam records the identity');

  const get = await call(context, { query: '?key=/core/user/theme/primary_color' });
  assert.equal(get.status, 200);
  assert.equal(get.data.data.value, 'purple');

  const missing = await call(context, { query: '?key=/core/user/theme/nope' });
  assert.equal(missing.status, 404, 'never-set reads 404 (cleared reads 200, below)');
});

test('hostile scope matrix: cross-account, session/plugin, unknown vocabulary', async (t) => {
  const { context, store } = await makeContext(t);
  await store.put({ type: 'account', id: OTHER_USER.id }, '/core/user/theme/primary_color', 'their-color');

  // Hostile cross-account READ of a real row.
  const crossRead = await call(context,
    { query: '?key=/core/user/theme/primary_color&scope_type=account&scope_id=someone-else' });
  assert.equal(crossRead.status, 403, 'cross-account read must never leak the value');
  // Hostile cross-account WRITE.
  const crossWrite = await call(context, {
    method: 'PUT',
    body: { key: '/core/user/theme/primary_color', value: 'clobbered', scope_type: 'account', scope_id: 'someone-else' },
  });
  assert.equal(crossWrite.status, 403);
  assert.equal((await store.get({ type: 'account', id: OTHER_USER.id },
    '/core/user/theme/primary_color')).value, 'their-color', 'the victim row is untouched');

  // Own-account with an explicit matching id is fine.
  const own = await call(context,
    { query: '?key=/core/user/theme/primary_color&scope_type=account&scope_id=operator-1' });
  assert.equal(own.status, 404, 'own scope resolves (this key was never set for operator-1)');

  // session/plugin scopes: recognized but not reachable over HTTP in v1.
  for (const scopeType of [ 'session', 'plugin' ]) {
    const result = await call(context, { query: `?key=/x&scope_type=${scopeType}&scope_id=s1` });
    assert.equal(result.status, 403, `${scopeType} must be 403 at the transport`);
  }
  // Unknown vocabulary is a 400, not a 403 (validation, not authorization).
  const bogus = await call(context, { query: '?key=/x&scope_type=bogus' });
  assert.equal(bogus.status, 400);
});

test('global scope: read open, write behind the identity bar', async (t) => {
  const { context, store } = await makeContext(t);
  await store.put({ type: 'global', id: '' }, '/core/kikx/instance/name', 'kikx-dev2');

  const read = await call(context, { query: '?key=/core/kikx/instance/name&scope_type=global' });
  assert.equal(read.status, 200);
  assert.equal(read.data.data.value, 'kikx-dev2');

  const write = await call(context, {
    method: 'PUT',
    body: { key: '/core/kikx/instance/name', value: 'renamed', scope_type: 'global' },
  });
  assert.equal(write.status, 200, 'any signed-in identity may write global (the identity bar)');
  assert.equal((await store.get({ type: 'global', id: '' }, '/core/kikx/instance/name')).value, 'renamed');
});

test('secrets never cross the transport: hasValue only, on read AND write', async (t) => {
  const { context, store } = await makeContext(t);
  await store.put({ type: 'global', id: '' }, '/core/kikx/email/configuration',
    { host: 'smtp.example.com', password: 'hunter2' }, { secret: true, updatedBy: 'core' });

  const read = await call(context, { query: '?key=/core/kikx/email/configuration&scope_type=global' });
  assert.equal(read.status, 200);
  assert.equal(read.data.data.hasValue, true, 'the client may know a value EXISTS');
  assert.equal('value' in read.data.data, false, 'but the plaintext must never appear in the payload');

  const write = await call(context, {
    method: 'PUT',
    body: { key: '/core/kikx/email/configuration', value: { host: 'smtp2', password: 'new' }, secret: true, scope_type: 'global' },
  });
  assert.equal(write.status, 200);
  assert.equal(write.data.data.hasValue, true);
  assert.equal('value' in write.data.data, false, 'write responses do not echo secrets either');
  // The store really holds the new secret, readable server-side.
  assert.equal((await store.get({ type: 'global', id: '' },
    '/core/kikx/email/configuration')).value.password, 'new');
});

test('optimistic version: stale expectedVersion -> 409, fresh succeeds', async (t) => {
  const { context } = await makeContext(t);
  const first = await call(context, {
    method: 'PUT',
    body: { key: '/core/kikx/flag', value: 'a', scope_type: 'global' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.data.version, 1);

  const stale = await call(context, {
    method: 'PUT',
    body: { key: '/core/kikx/flag', value: 'b', scope_type: 'global', expectedVersion: 99 },
  });
  assert.equal(stale.status, 409, 'optimistic mismatch is a 409 (plan: form re-fetches)');
  assert.match(JSON.stringify(stale.data), /version_conflict/);

  const fresh = await call(context, {
    method: 'PUT',
    body: { key: '/core/kikx/flag', value: 'c', scope_type: 'global', expectedVersion: 1 },
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.data.version, 2);
});

test('validation: missing value, hostile key, bad version, bad secret flag', async (t) => {
  const { context } = await makeContext(t);
  const cases = [
    { body: { key: '/core/x' }, why: 'PUT without a value' },
    { body: { value: 1 }, why: 'PUT without a key' },
    { body: { key: '/a/../b', value: 1 }, why: 'traversal key' },
    { body: { key: '/core/x', value: 1, expectedVersion: 0 }, why: 'expectedVersion must be >= 1' },
    { body: { key: '/core/x', value: 1, secret: 'yes' }, why: 'secret must be a boolean' },
  ];
  for (const { body, why } of cases) {
    const result = await call(context, { method: 'PUT', body });
    assert.equal(result.status, 400, `${why} -> 400 (got ${result.status})`);
  }
});

test('soft delete: cleared reads 200 with hasValue false; never-set DELETE is 404', async (t) => {
  const { context } = await makeContext(t);
  await call(context, { method: 'PUT', body: { key: '/core/kikx/tmp', value: 'here', scope_type: 'global' } });

  const deleted = await call(context, { method: 'DELETE', query: '?key=/core/kikx/tmp&scope_type=global' });
  assert.equal(deleted.status, 200);

  const cleared = await call(context, { query: '?key=/core/kikx/tmp&scope_type=global' });
  assert.equal(cleared.status, 200, 'cleared is NOT never-set (plan §1)');
  assert.equal(cleared.data.data.hasValue, false);
  assert.equal(cleared.data.data.value, null);

  const never = await call(context, { method: 'DELETE', query: '?key=/core/kikx/never&scope_type=global' });
  assert.equal(never.status, 404, 'deleting what never existed names it honestly');
});
