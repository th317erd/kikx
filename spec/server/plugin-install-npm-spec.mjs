'use strict';

import '../support/test-env.mjs';

// Campaign S3 slice 3 (plan 5-S3): POST /api/v1/plugins/install accepts
// {npm:"<pkg[@range]>"} alongside {path}. The whole pipeline, mocked at the
// network seam only (pluginNpmRegistryFetch) — everything else runs REAL:
// strict spec validation, sha512 integrity, tarbomb-guarded extraction,
// atomic landing under KIKX_PLUGIN_NPM_DIR, the existing load/migrations/
// rollback pipeline (so the S4 signature gate rides along), durable runtime
// path-append for reload, and provenance source {type,ref,registry} on both
// install shapes, surfaced by the inventory (plan §10 point 4).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handlePluginRoutes } from '../../src/server/routes/plugin-routes.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { PluginRouter } from '../../src/core/plugins/plugin-router.mjs';
import { PluginMigrations } from '../../src/core/plugins/plugin-migrations.mjs';
import {
  KIKX_CWD_PATH,
  KIKX_PLUGIN_INSTALL_ENABLED_PATH,
  KIKX_PLUGIN_NPM_DIR_PATH,
  KIKX_PLUGIN_PATHS_PATH,
  KIKX_PLUGIN_REGISTRY_URLS_PATH,
  KIKX_PLUGIN_SIGNATURE_MODE_PATH,
} from '../../src/core/config/config-paths.mjs';
import { gzipTar } from '../support/tar-fixture.mjs';

const silent = { warn() {}, info() {}, error() {}, debug() {} };
const REGISTRY = 'https://registry.npmjs.org';

function fakeResponse() {
  return {
    statusCode: 0, headersSent: false, body: null,
    writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
    end(payload) { if (payload !== undefined) this.body = String(payload); },
    destroy() { this.headersSent = true; },
  };
}

function fakeRequest({ method = 'POST', url = '/', body = '' } = {}) {
  let chunks = body ? [Buffer.from(body)] : [];
  return { method, url, headers: {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}

function fakeContext(services) {
  return {
    has: (key) => Object.prototype.hasOwnProperty.call(services, key),
    require: (key) => { if (!Object.prototype.hasOwnProperty.call(services, key)) throw new Error(`no service "${key}"`); return services[key]; },
    get: (key) => services[key],
  };
}

const operator = { resolveIdentity: async () => ({ id: 'operator-1' }) };

function makeHarness() {
  const registry = new PluginRegistry({ logger: silent });
  const router = new PluginRouter({ logger: silent });
  const migrations = new PluginMigrations({ logger: silent });
  registry.setPluginRouter(router);
  registry.setPluginMigrations(migrations);
  return { registry, router, migrations };
}

// Keyed config: every path answers its own value — no all-true shortcut, so
// signature mode ('unsafe' for these fixtures, matching test-env) and the
// install gate are each exercised honestly.
function configMock(store) {
  return { get: async (propertyPath) => store[propertyPath] };
}

function baseStore({ cwd, npmDir }) {
  return {
    [KIKX_PLUGIN_INSTALL_ENABLED_PATH]: true,
    [KIKX_CWD_PATH]: cwd,
    [KIKX_PLUGIN_NPM_DIR_PATH]: npmDir,
    [KIKX_PLUGIN_REGISTRY_URLS_PATH]: REGISTRY,
    [KIKX_PLUGIN_PATHS_PATH]: '',
    [KIKX_PLUGIN_SIGNATURE_MODE_PATH]: 'unsafe',
  };
}

function fakeTags() {
  const rows = new Map();
  const key = (t) => `${t.target_type}/${t.target_id}/${t.name}`;
  return {
    rows,
    async upsertTag(tag) { rows.set(key(tag), JSON.parse(JSON.stringify(tag))); return rows.get(key(tag)); },
    async getTag({ target_type, target_id, name }) {
      const row = rows.get(`${target_type}/${target_id}/${name}`);
      if (!row) { const e = new Error('not found'); e.status = 404; throw e; }
      return { ...row };
    },
  };
}

const ECHO_INDEX = `export const pluginName = 'kikx-echo';
export function setup(provide) {
  provide((ctx) => {
    const PluginInterface = ctx.registry.getClass('PluginInterface');
    class EchoTool extends PluginInterface { async run() { return 'ok'; } }
    ctx.registry.registerTool('kikx-echo-tool', EchoTool);
    ctx.mountHttp(async (_req, res) => { res.end('echo'); }, { auth: 'public' });
  });
}`;

function echoTarball() {
  return gzipTar([
    { name: 'package/package.json', data: JSON.stringify({ name: 'kikx-echo', main: 'index.mjs' }) },
    { name: 'package/index.mjs', data: ECHO_INDEX },
  ]);
}

function sriOf(bytes) {
  return 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
}

function npmFetch({ packument, tarball, calls }) {
  return async (url) => {
    calls.push(url);
    const body = url.endsWith('.tgz') ? (tarball || Buffer.alloc(0)) : Buffer.from(JSON.stringify(packument || {}));
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-length' ? String(body.length) : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

async function installNpm({ harness, store, tags, spec, fetchImpl }) {
  const response = fakeResponse();
  const handled = await handlePluginRoutes({
    request: fakeRequest({ body: JSON.stringify({ npm: spec }) }),
    response,
    url: new URL('/api/v1/plugins/install', 'http://localhost'),
    context: fakeContext({
      pluginRouter: harness.router,
      pluginRegistry: harness.registry,
      pluginMigrations: harness.migrations,
      commandRegistry: { register() {}, get() { return null; }, list() { return []; } },
      config: configMock(store),
      accountStore: operator,
      tagsStore: tags,
      pluginNpmRegistryFetch: fetchImpl,
    }),
  });
  return { handled, response };
}

async function getInventory({ harness, store, tags }) {
  const response = fakeResponse();
  const handled = await handlePluginRoutes({
    request: fakeRequest({ method: 'GET' }),
    response,
    url: new URL('/api/v1/plugins', 'http://localhost'),
    context: fakeContext({
      pluginRouter: harness.router,
      pluginRegistry: harness.registry,
      config: configMock(store),
      accountStore: operator,
      tagsStore: tags,
    }),
  });
  return { handled, response };
}

function tmpRoots(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-npmcwd-'));
  const npmDir = path.join(cwd, 'npm-landing');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, npmDir };
}

const goodPackument = (tarball) => ({
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': { dist: { tarball: `${REGISTRY}/kikx-echo/-/kikx-echo-1.0.0.tgz`, integrity: sriOf(tarball) } } },
});

test('an invalid npm spec is a 400 before any network call', async (t) => {
  const { cwd, npmDir } = tmpRoots(t);
  const harness = makeHarness();
  const store = baseStore({ cwd, npmDir });
  const tags = fakeTags();
  const calls = [];

  const { response } = await installNpm({
    harness, store, tags, spec: '--ignore-scripts',
    fetchImpl: npmFetch({ calls, tarball: echoTarball(), packument: goodPackument(echoTarball()) }),
  });

  assert.equal(response.statusCode, 400, 'hostile spec must never reach the network');
  assert.equal(calls.length, 0, 'zero fetches for a rejected spec');
  assert.equal(JSON.parse(response.body).error.message.includes('npm'), true, 'the error names the npm field');
  assert.equal(fs.existsSync(npmDir), false, 'nothing was landed');
});

test('a registry install lands atomically, loads, records provenance, and survives reload', async (t) => {
  const { cwd, npmDir } = tmpRoots(t);
  const harness = makeHarness();
  const store = baseStore({ cwd, npmDir });
  const tags = fakeTags();
  const calls = [];
  const tarball = echoTarball();

  const { handled, response } = await installNpm({
    harness, store, tags, spec: 'kikx-echo@1.0.0',
    fetchImpl: npmFetch({ calls, tarball, packument: goodPackument(tarball) }),
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201, 'a newly added plugin answers 201');
  const payload = JSON.parse(response.body);
  assert.deepEqual(payload.data.added, ['kikx-echo'], 'the plugin loaded through the real pipeline');
  assert.deepEqual(payload.data.source, { type: 'npm', ref: 'kikx-echo@1.0.0', registry: REGISTRY });
  assert.ok(harness.registry._pluginRegistrations?.has('kikx-echo'));

  const dest = path.join(npmDir, 'kikx-echo');
  assert.ok(fs.existsSync(path.join(dest, 'index.mjs')), 'files landed under KIKX_PLUGIN_NPM_DIR');
  assert.ok(fs.existsSync(path.join(dest, 'package.json')), 'the package/ root was stripped');
  const leftovers = fs.readdirSync(npmDir).filter((n) => n.startsWith('.staging-'));
  assert.deepEqual(leftovers, [], 'staging directories are gone after the swap');

  const runtimeFile = path.join(cwd, '.kikx', 'plugin-paths.json');
  assert.ok(fs.existsSync(runtimeFile), 'the durable runtime path list exists — reload re-reads it');
  const runtimePaths = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  assert.ok(runtimePaths.includes(dest), `runtime list holds ${dest}`);
  assert.equal(store[KIKX_PLUGIN_PATHS_PATH], '', 'the read-only config store was not pretended-writable');

  const sourceTag = tags.rows.get('plugin/kikx-echo/source');
  assert.ok(sourceTag, 'provenance tag written');
  assert.deepEqual(JSON.parse(sourceTag.value), { type: 'npm', ref: 'kikx-echo@1.0.0', registry: REGISTRY });

  const { response: inv } = await getInventory({ harness, store, tags });
  assert.equal(inv.statusCode, 200);
  const row = JSON.parse(inv.body).data.plugins.find((p) => p.name === 'kikx-echo');
  assert.deepEqual(row.source, { type: 'npm', ref: 'kikx-echo@1.0.0', registry: REGISTRY }, 'inventory exposes source');
  assert.equal(row.managed, true, 'the npm landing root counts as managed ground');
  assert.equal(row.signed, null, 'unsafe mode: load proves nothing about signatures — unknown, honestly null');
  assert.equal(JSON.parse(inv.body).data.signatureMode, 'unsafe');
});

test('missing dist.integrity fails closed with 502 and lands nothing', async (t) => {
  const { cwd, npmDir } = tmpRoots(t);
  const harness = makeHarness();
  const store = baseStore({ cwd, npmDir });
  const tags = fakeTags();
  const packument = {
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { dist: { tarball: `${REGISTRY}/kikx-echo/-/kikx-echo-1.0.0.tgz` } } },
  };

  const { response } = await installNpm({
    harness, store, tags, spec: 'kikx-echo',
    fetchImpl: npmFetch({ calls: [], tarball: echoTarball(), packument }),
  });

  assert.equal(response.statusCode, 502, 'an unverifiable registry answer is not a 201');
  assert.match(JSON.parse(response.body).error.message, /integrity/i);
  assert.equal(fs.existsSync(npmDir), false, 'no directory was created');
  assert.ok(!harness.registry._pluginRegistrations?.has('kikx-echo'), 'the plugin is not loaded');
  assert.equal(tags.rows.size, 0, 'no provenance for a failed install');
});

test('a tampered tarball never reaches extraction (502, nothing landed)', async (t) => {
  const { cwd, npmDir } = tmpRoots(t);
  const harness = makeHarness();
  const store = baseStore({ cwd, npmDir });
  const tags = fakeTags();
  const packument = {
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { dist: { tarball: `${REGISTRY}/kikx-echo/-/kikx-echo-1.0.0.tgz`, integrity: sriOf(Buffer.from('other-bytes')) } } },
  };

  const { response } = await installNpm({
    harness, store, tags, spec: 'kikx-echo',
    fetchImpl: npmFetch({ calls: [], tarball: echoTarball(), packument }),
  });

  assert.equal(response.statusCode, 502);
  assert.match(JSON.parse(response.body).error.message, /integrity/i);
  assert.equal(fs.existsSync(npmDir), false, 'a failed download must not extract');
  assert.ok(!harness.registry._pluginRegistrations?.has('kikx-echo'), 'the plugin is not loaded');
});

test('a path install records provenance {type:path} too (plan 5-S3, 10.4)', async (t) => {
  const { cwd, npmDir } = tmpRoots(t);
  const harness = makeHarness();
  const store = baseStore({ cwd, npmDir });
  const tags = fakeTags();

  const dir = path.join(cwd, 'path-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `
    export const pluginName = 'path-probe';
    export function setup(provide) {
      provide((ctx) => {
        const PluginInterface = ctx.registry.getClass('PluginInterface');
        class T extends PluginInterface { async run() { return 'ok'; } }
        ctx.registry.registerTool('path-probe-tool', T);
      });
    }`);

  const response = fakeResponse();
  await handlePluginRoutes({
    request: fakeRequest({ body: JSON.stringify({ path: dir }) }),
    response,
    url: new URL('/api/v1/plugins/install', 'http://localhost'),
    context: fakeContext({
      pluginRouter: harness.router,
      pluginRegistry: harness.registry,
      pluginMigrations: harness.migrations,
      commandRegistry: { register() {}, get() { return null; }, list() { return []; } },
      config: configMock(store),
      accountStore: operator,
      tagsStore: tags,
    }),
  });

  assert.equal(response.statusCode, 201);
  const sourceTag = tags.rows.get('plugin/path-probe/source');
  assert.ok(sourceTag, 'path installs record provenance as well');
  assert.deepEqual(JSON.parse(sourceTag.value), { type: 'path', ref: dir, registry: null });
});
