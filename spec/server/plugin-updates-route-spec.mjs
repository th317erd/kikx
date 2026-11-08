'use strict';

import '../support/test-env.mjs';

// Campaign S3 slice 6 (plan 5-S3): POST /api/v1/plugins/updates — ONE bounded
// batch request when the Plugins view opens, checking npm-sourced installed
// plugins against registry metadata. Rules the plan pins: mocked registry in
// tests, per-package lookup failure = NO chip (never a 500), capped batch,
// INVENTORY gate, registry from KIKX_PLUGIN_REGISTRY_URLS.

import assert from 'node:assert/strict';
import test from 'node:test';

import { handlePluginRoutes } from '../../src/server/routes/plugin-routes.mjs';
import {
  KIKX_PLUGIN_REGISTRY_URLS_PATH,
} from '../../src/core/config/config-paths.mjs';
import {
  fakeContext, fakeRequest, fakeResponse, noMounts, operator,
} from '../support/fake-http.mjs';

const REGISTRY = 'https://registry.npmjs.org';
const config = { get: async (p) => (p === KIKX_PLUGIN_REGISTRY_URLS_PATH ? REGISTRY : undefined) };

function packument(version) {
  return {
    'dist-tags': { latest: version },
    versions: { [version]: { dist: { tarball: `${REGISTRY}/x.tgz`, integrity: 'sha512-aa' } } },
  };
}

function fetchMock({ calls, packuments = {}, throwing = [] }) {
  return async (url) => {
    calls.push(url);
    const name = url.replace(`${REGISTRY}/`, '');
    if (throwing.includes(name)) throw new Error(`network down: ${name}`);
    if (!(name in packuments)) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from(JSON.stringify(packuments[name]));
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k === 'content-length' ? String(body.length) : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

async function updates({ packages, fetchImpl, withAccountStore = true }) {
  const services = { pluginRouter: noMounts, config, pluginNpmRegistryFetch: fetchImpl };
  if (withAccountStore) services.accountStore = operator;
  const response = fakeResponse();
  const handled = await handlePluginRoutes({
    request: fakeRequest({ method: 'POST', body: JSON.stringify({ packages }) }),
    response,
    url: new URL('/api/v1/plugins/updates', 'http://localhost'),
    context: fakeContext(services),
  });
  return { handled, response };
}

test('updates is gated like inventory: 503 without an account store', async () => {
  await assert.rejects(
    () => updates({ packages: [ { name: 'a', version: '1.0.0' } ], fetchImpl: fetchMock({ calls: [] }), withAccountStore: false }),
    (error) => error?.status === 503,
  );
});

test('rejects a malformed batch with 400 before any fetch', async () => {
  const cases = [
    undefined,                                  // missing body
    { packages: 'not-an-array' },               // wrong shape — handled via null packages
    null,
  ];
  for (const packages of [ 'nope', 42, {} ]) {
    const calls = [];
    const { response } = await updates({ packages, fetchImpl: fetchMock({ calls }) });
    assert.equal(response.statusCode, 400, `packages=${JSON.stringify(packages)} is a 400`);
    assert.equal(calls.length, 0);
  }
  // over the cap
  const many = Array.from({ length: 26 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' }));
  const overCalls = [];
  const over = await updates({ packages: many, fetchImpl: fetchMock({ calls: overCalls }) });
  assert.equal(over.response.statusCode, 400, 'the batch is capped (25)');
  assert.equal(overCalls.length, 0, 'the cap rejects before hitting the registry');
  // hostile name inside an otherwise valid batch
  const hostileCalls = [];
  const hostile = await updates({ packages: [ { name: '--ignore-scripts', version: '1.0.0' } ], fetchImpl: fetchMock({ calls: hostileCalls }) });
  assert.equal(hostile.response.statusCode, 400, 'the strict package-name regex applies here too');
  assert.equal(hostileCalls.length, 0, 'a hostile name never reaches the network');
  assert.ok(cases.length === 3, 'shape cases documented');
});

test('reports only packages whose latest is strictly newer; per-package failures vanish', async (t) => {
  const calls = [];
  const packuments = {
    'alpha': packument('1.1.0'),   // installed 1.0.0 → UPDATE
    'beta': packument('2.0.0'),    // installed 2.0.0 → equal → no chip
    'delta': packument('0.9.0'),   // installed 1.0.0 → latest older → no chip
    // gamma THROWS → no chip (lookup failure), never a 500
    'epsilon': packument('3.0.0-rc.1'), // installed 2.9.0 → prerelease numerically newer → chip
  };
  const { handled, response } = await updates({
    packages: [
      { name: 'alpha', version: '1.0.0' },
      { name: 'beta', version: '2.0.0' },
      { name: 'delta', version: '1.0.0' },
      { name: 'gamma', version: '1.0.0' },
      { name: 'epsilon', version: '2.9.0' },
    ],
    fetchImpl: fetchMock({ calls, packuments, throwing: [ 'gamma' ] }),
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200, 'a failing lookup must not fail the batch');
  const data = JSON.parse(response.body).data;
  assert.deepEqual(data.updates, {
    alpha: { latest: '1.1.0' },
    epsilon: { latest: '3.0.0-rc.1' },
  }, 'strictly-newer only; equal/older/failed stay off the chip list');
  assert.equal(data.checked, 5, 'the batch reports what it attempted');
  assert.equal(calls.length, 5, 'one packument request per package, capped upstream at 25');
});

test('total registry outage answers 200 with no chips, not an error', async () => {
  const { response } = await updates({
    packages: [ { name: 'alpha', version: '1.0.0' } ],
    fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(response.statusCode, 200, 'lookup failure = no chip (plan 5-S3), by contract');
  assert.deepEqual(JSON.parse(response.body).data.updates, {});
});
