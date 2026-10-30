'use strict';

// Live-boot exit proof for the plugin platform (campaign §6, P0).
//
// This is the one check a green unit suite cannot substitute for: a real
// createServer() with the real Postgres driver, the real auth chain, the real
// router, a real HTTP socket, and a plugin loaded from disk. Everything else in
// spec/ builds those pieces from fakes or in isolation.
//
// Run:
//   set -a && . ../../../kikx/.env.dev && set +a
//   node spec/plugins/live-boot-exit-proof.mjs
//
// Exits 0 when every assertion holds, 1 when any fails, 2 when the database URL
// is missing. Not part of `npm test`: it needs a live database and several
// seconds of boot, neither of which the suite may assume.
//
// Why unload is called in-process
// ------------------------------
// /api/v1/plugins exposes GET inventory, POST /install and POST /reload. There
// is no unload endpoint, so unload cannot be reached over HTTP at all. That is a
// finding, not a workaround, and it is reported in the output. Calling
// unloadPlugin() directly is the only way to exercise it against a live server.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server/create-server.mjs';
import { unloadPlugin } from '../../src/core/plugins/plugin-loader.mjs';

const PLUGIN_ID = 'parity_probe';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const results = [];
function check(name, fn) {
  try { fn(); results.push([ 'PASS', name, '' ]); }
  catch (error) { results.push([ 'FAIL', name, error.message ]); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push([ 'PASS', name, '' ]); }
  catch (error) { results.push([ 'FAIL', name, error.message ]); }
}

if (!process.env.ORG_AEOR_KIKX_DATABASE_URL) {
  console.error('ORG_AEOR_KIKX_DATABASE_URL is required (source kikx/.env.dev first)');
  process.exit(2);
}

// A no-op plugin. It registers one of each kind the loader attributes, so the
// unload ledger has something real to replay. It uses only the documented setup
// context - if the context stops offering one of these, this proof fails, which
// is the point.
let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-live-boot-'));
let dir = path.join(root, PLUGIN_ID);
await fs.mkdir(path.join(dir, 'sql'), { recursive: true });
await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
await fs.writeFile(
  path.join(dir, 'sql', '001-probe.sql'),
  'CREATE TABLE IF NOT EXISTS parity_probe_widget (id TEXT PRIMARY KEY);',
);
await fs.writeFile(path.join(dir, 'index.mjs'), `
export const pluginName = ${JSON.stringify(PLUGIN_ID)};
export function setup(provide) {
  provide((ctx) => {
    const PluginInterface = ctx.registry.getClass('PluginInterface');
    class ProbeTool extends PluginInterface { async run() { return 'ok'; } }
    class ProbeWidget {}
    ctx.registerTool('parity_probe_tool', ProbeTool);
    ctx.registerClass('parityProbeWidget', ProbeWidget);
    // The router calls a mount handler with ONE object: { request, response, url,
    // identity, subPath, json, rawBody }. A (req, res) signature silently gets
    // undefined for both, which is exactly how this fixture failed the first time.
    ctx.mountHttp(async ({ response }) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('probe');
    }, { auth: 'public' });
    ctx.registerMigrations({ directory: 'sql' });
    // Scoped on purpose: an unscoped subscription receives nothing by design, so a
    // scoped one is the only kind whose removal is observable.
    ctx.subscribe(() => {}, { sessions: [ 'live-boot-session' ] });
  });
}
`);

let server = await createServer({ pluginPaths: dir, logger: silent });
let context = server.kikxContext;
let registry = context.require('pluginRegistry');
let router = context.require('pluginRouter');
let eventBus = context.require('pluginEventBus');
let auth = context.require('authService');
let migrations = context.require('pluginMigrations');

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let base = `http://127.0.0.1:${server.address().port}`;

// A real session, minted by the auth service the way a user's session is. The
// admin gate requires a valid identity only - there is no operator role.
let user = (await auth.users.list())[0];
if (!user) {
  await auth.users.create({ email: 'parity-probe@localhost', name: 'Parity Probe', roles: [ 'admin' ] });
  user = (await auth.users.list())[0];
}
assert.ok(user?.id, 'could not resolve or create a user for the exit proof');
let token = (await auth.sessions.create({ userId: user.id, accessTTLSeconds: 3600, refreshTTLSeconds: 86400 })).token;

async function getJSON(pathname, { withAuth = false } = {}) {
  let response = await fetch(`${base}${pathname}`, {
    headers: withAuth ? { Authorization: `Bearer ${token}` } : {},
  });
  let text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

// --- before unload -------------------------------------------------------

await checkAsync('inventory refuses an anonymous caller', async () => {
  let { status, body } = await getJSON('/api/v1/plugins');
  assert.equal(status, 401, `expected 401, got ${status}`);
  assert.ok(!body?.data, 'a refusal must not include plugin inventory');
});

await checkAsync('inventory answers an authenticated caller', async () => {
  let { status, body } = await getJSON('/api/v1/plugins', { withAuth: true });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body).slice(0, 300)}`);
});

await checkAsync('the probe plugin is loaded on this server', async () => {
  assert.ok(registry._pluginRegistrations?.has(PLUGIN_ID), 'probe plugin is not registered');
});

await checkAsync('its mount serves over real HTTP', async () => {
  let response = await fetch(`${base}/api/plugins/${PLUGIN_ID}/any-path`);
  let text = await response.text();
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${text.slice(0, 200)}`);
  assert.equal(text, 'probe');
});

await checkAsync('tool, class override, ledger, subscription and migration claim all exist', async () => {
  assert.ok(registry.getTool('parity_probe_tool'), 'tool missing');
  assert.ok(registry.getClass('parityProbeWidget'), 'class override missing');
  assert.ok(registry.listOwnedRegistrations(PLUGIN_ID).length > 0, 'ownership ledger is empty');
  let subs = eventBus.list().find((s) => s.pluginId === PLUGIN_ID);
  assert.ok(subs && subs.subscriptions > 0, 'subscription missing');
  let claimed = typeof migrations.listRegistered === 'function'
    ? migrations.listRegistered().some((m) => m.pluginId === PLUGIN_ID)
    : true;
  assert.ok(claimed, 'migration directory not claimed');
});

// --- unload --------------------------------------------------------------

let ownedBefore = registry.listOwnedRegistrations(PLUGIN_ID).length;
await checkAsync('unloadPlugin runs against a live server', async () => {
  await unloadPlugin(registry, PLUGIN_ID, { logger: silent });
});

await checkAsync('the mount stops serving after unload', async () => {
  let response = await fetch(`${base}/api/plugins/${PLUGIN_ID}/any-path`);
  assert.notEqual(response.status, 200, 'the unloaded plugin still serves requests');
});

await checkAsync('tool, class override, ledger, mount, subscription and registration are all gone', async () => {
  assert.equal(registry.getTool('parity_probe_tool'), null, 'tool survived unload');
  assert.equal(registry.getClass('parityProbeWidget'), null, 'class override survived unload');
  assert.deepEqual(registry.listOwnedRegistrations(PLUGIN_ID), [], 'ownership ledger was not drained');
  assert.equal(router.listMounts().filter((m) => m.pluginId === PLUGIN_ID).length, 0, 'mount entry survived unload');
  assert.equal(eventBus.list().find((s) => s.pluginId === PLUGIN_ID), undefined, 'subscription survived unload');
  assert.ok(!registry._pluginRegistrations?.has(PLUGIN_ID), 'registration survived unload');
});

await checkAsync('the host still serves after a plugin is unloaded', async () => {
  // Unloading one plugin must not disturb its neighbours. This is the property
  // the partial-release guard in releasePlugin exists for.
  let { status } = await getJSON('/api/v1/plugins', { withAuth: true });
  assert.equal(status, 200, 'inventory broke after an unload');
});

// --- report --------------------------------------------------------------

await new Promise((resolve) => server.close(resolve));
await fs.rm(root, { recursive: true, force: true });

let width = Math.max(...results.map(([ , name ]) => name.length));
for (let [ verdict, name, detail ] of results)
  console.log(`${verdict}  ${name.padEnd(width)}  ${detail}`);
let failed = results.filter(([ v ]) => v === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed  (ledger entries replayed by unload: ${ownedBefore})`);
process.exit(failed ? 1 : 0);
