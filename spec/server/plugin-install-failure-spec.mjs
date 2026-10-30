'use strict';

// What an install does when it does not finish.
//
// Why this file exists
// --------------------
// The campaign plan (§6) lists "failed migration" among the exit-proof tests P0 needs,
// and my earlier ledger recorded it as a loader test. It is not: loadPlugins() never
// touches migrations. An install is where the two meet - the route loads the plugin
// first and only then runs the plugin's SQL - which means the install route is the one
// place where a plugin can be *loaded* and its migrations *failed* at the same time.
//
// Measured on the code before this change: install called loadPlugins(), then
// migrations.run(), and the catch around both returned 500 without unloading anything.
// So a migration failure answered "install failed" while the plugin stayed in
// _pluginRegistrations and its mount stayed in the router. The caller is told the
// install did not happen and the server behaves as though it did - the worst of both,
// because whoever tries again installs it twice.
//
// The install route also runs migrations for plugins that were ALREADY loaded. Those
// did not just fail to install; they were installed and healthy beforehand, and a
// migration failure must not unload them. Both directions are asserted here, because a
// fix that unloads "the plugin whose migrations ran" gets the second case wrong.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handlePluginRoutes } from '../../src/server/routes/plugin-routes.mjs';
import { loadPlugins } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { PluginRouter } from '../../src/core/plugins/plugin-router.mjs';
import { PluginMigrations } from '../../src/core/plugins/plugin-migrations.mjs';

const silent = { warn() {}, info() {}, error() {}, debug() {} };

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

function fakeRequest({ method = 'POST', url = '/', body = '' } = {}) {
  let chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { for (let c of chunks) yield c; },
  };
}

function fakeContext(services) {
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

// Install is config-gated and identity-gated. Neither is under test here, so both are
// satisfied: the point of this file is what happens AFTER authorization succeeds.
const allowInstall = { get: async () => true };
const operator = { resolveIdentity: async () => ({ id: 'operator-1' }) };

function makeHarness({ migrationsRun } = {}) {
  let registry = new PluginRegistry({ logger: silent });
  let router = new PluginRouter({ logger: silent });
  let migrations = new PluginMigrations({ logger: silent });
  registry.setPluginRouter(router);
  registry.setPluginMigrations(migrations);

  // A migration failure has to come from the migration runner, not from a stubbed
  // loader: whether run() throws or reports is exactly the behaviour the route depends
  // on, and stubbing it here would assume the answer.
  if (migrationsRun)
    migrations.run = migrationsRun;

  return { registry, router, migrations };
}

// A plugin that loads cleanly and declares a migration directory. Nothing in it is
// expected to fail at load time - the failure must come from the migration step alone,
// or the test would be measuring the loader's rollback instead of the route's.
async function writeInstalledPlugin(root, name) {
  let dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'sql'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(
    path.join(dir, 'sql', '001-widget.sql'),
    `CREATE TABLE IF NOT EXISTS ${name.replace(/-/g, '_')}_widget (id TEXT PRIMARY KEY);`,
  );
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        const PluginInterface = ctx.registry.getClass('PluginInterface');
        class ProbeTool extends PluginInterface { async run() { return 'ok'; } }
        ctx.registry.registerTool(${JSON.stringify(name + '-tool')}, ProbeTool);
        ctx.mountHttp(async (_req, res) => { res.end('probe'); }, { auth: 'public' });
        ctx.registerMigrations({ directory: 'sql' });
      });
    }
  `);
  return dir;
}

async function install(harness, target) {
  let response = fakeResponse();
  let handled = await handlePluginRoutes({
    request: fakeRequest({ body: JSON.stringify({ path: target }) }),
    response,
    url: new URL('/api/v1/plugins/install', 'http://localhost'),
    context: fakeContext({
      pluginRouter: harness.router,
      pluginRegistry: harness.registry,
      pluginMigrations: harness.migrations,
      commandRegistry: { register() {}, get() { return null; }, list() { return []; } },
      config: allowInstall,
      accountStore: operator,
    }),
  });
  return { handled, response };
}

test('an install whose migrations fail does not leave the plugin loaded', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-install-'));
  let harness = makeHarness({ migrationsRun: async () => { throw new Error('migration exploded'); } });
  let dir = await writeInstalledPlugin(root, 'migration-probe');

  let { handled, response } = await install(harness, dir);

  assert.equal(handled, true);
  assert.equal(response.statusCode, 500, 'a failed migration must not report success');
  assert.match(JSON.parse(response.body).error.message, /migration exploded/);

  // The caller was told the install failed, so nothing may remain. A mount that still
  // serves is the case that matters: it is reachable by the browser without any further
  // action, and the next install attempt of the same path would double-register.
  assert.equal(
    response.statusCode === 500 && harness.registry._pluginRegistrations?.has('migration-probe'),
    false,
    'a plugin whose install failed is still in the registry',
  );
  assert.deepEqual(harness.router.listMounts().map((m) => m.pluginId), [], 'a failed install left its mount serving');
  assert.equal(harness.registry.getTool('migration-probe-tool'), null, 'a failed install left its tool registered');
  assert.deepEqual(harness.registry.listOwnedRegistrations('migration-probe'), [], 'the ownership ledger kept a failed install');
});

test('a failed install is still reported in the inventory errors', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-install-'));
  let harness = makeHarness({ migrationsRun: async () => { throw new Error('migration exploded'); } });
  let dir = await writeInstalledPlugin(root, 'migration-reported');

  let { response } = await install(harness, dir);

  // Rolling back must not erase the fact that it failed: "not installed" and "installed
  // and broken" have to stay distinguishable, which is the same contract the loader's
  // failure list exists to satisfy.
  let payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 500);
  assert.match(payload.error.message, /migration exploded/);
});

test('a migration failure does not unload plugins that were already loaded', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-install-'));
  let harness = makeHarness();
  let healthy = await writeInstalledPlugin(root, 'already-loaded');
  let doomed = await writeInstalledPlugin(root, 'newly-installed');

  // Load the healthy one directly, the way a boot would, before any install happens.
  let loaded = await loadPlugins({ pluginPaths: healthy, registry: harness.registry, logger: silent });
  assert.equal(loaded.length, 1, 'precondition: the healthy plugin must load');
  assert.ok(harness.registry._pluginRegistrations?.has('already-loaded'));

  // Now fail the migration step for the install that follows.
  harness.migrations.run = async () => { throw new Error('migration exploded'); };

  let { response } = await install(harness, doomed);

  assert.equal(response.statusCode, 500);
  assert.ok(
    harness.registry._pluginRegistrations?.has('already-loaded'),
    'a failed install unloaded an unrelated, already-loaded plugin',
  );
  assert.equal(
    harness.router.listMounts().filter((m) => m.pluginId === 'already-loaded').length,
    1,
    'a failed install removed another plugin\'s mount',
  );
  assert.equal(
    harness.registry._pluginRegistrations?.has('newly-installed'),
    false,
    'the plugin whose install failed is still loaded',
  );
});

test('a successful install reports what it added', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-install-'));
  let harness = makeHarness({ migrationsRun: async () => ({ skipped: false, applied: ['001-widget.sql'] }) });
  let dir = await writeInstalledPlugin(root, 'install-ok');

  let { handled, response } = await install(harness, dir);

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201, 'a newly added plugin answers 201');
  let payload = JSON.parse(response.body);
  assert.deepEqual(payload.data.added, ['install-ok']);
  assert.ok(harness.registry._pluginRegistrations?.has('install-ok'));
});
