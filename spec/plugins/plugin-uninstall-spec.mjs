'use strict';

import '../support/test-env.mjs';

// Campaign uninstall (plan §9.1.1 — APPROVED in full by the owner 2026-11-05:
// managed dirs only, built-ins never, durable plugin data retained).
// POST /api/v1/plugins/uninstall {name}: same operator + config gates as
// install, NEW PLUGIN_ADMIN_ACTIONS.UNINSTALL, unload FIRST then delete files
// ONLY under managed roots. The ordering is the safety property: a plugin
// whose files vanish while it is serving is worse than no uninstall at all,
// so the fixture records directory existence FROM INSIDE its teardown.

import assert from 'node:assert/strict';
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
} from '../../src/core/config/config-paths.mjs';
import { appendRuntimePluginPath } from '../../src/core/config/runtime-plugin-paths.mjs';
import { fakeContext, fakeRequest, fakeResponse, noMounts, operator } from '../support/fake-http.mjs';

const silent = { warn() {}, info() {}, error() {}, debug() {} };

function makeHarness() {
  const registry = new PluginRegistry({ logger: silent });
  const router = new PluginRouter({ logger: silent });
  const migrations = new PluginMigrations({ logger: silent });
  registry.setPluginRouter(router);
  registry.setPluginMigrations(migrations);
  return { registry, router, migrations };
}

// The fixture records, from inside teardown, whether its directory still
// existed AT UNLOAD TIME — the ordering proof for unload-then-delete.
async function writeFixturePlugin(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `
    import fs from 'node:fs';
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        const PluginInterface = ctx.registry.getClass('PluginInterface');
        class T extends PluginInterface { async run() { return 'ok'; } }
        ctx.registry.registerTool(${JSON.stringify(`${name}-tool`)}, T);
        ctx.mountHttp(async (_q, res) => { res.end('x'); }, { auth: 'public' });
      });
      // setup()'s RETURN is the lifecycle value the loader records: a
      // function becomes teardown directly.
      return () => {
        fs.writeFileSync(${JSON.stringify(path.join(root, `${name}-teardown.txt`))},
          String(fs.existsSync(${JSON.stringify(dir)})));
      };
    }
  `);
  return dir;
}

function configStore({ cwd, roots, installEnabled = true }) {
  return {
    [KIKX_CWD_PATH]: cwd,
    [KIKX_PLUGIN_PATHS_PATH]: roots,
    [KIKX_PLUGIN_NPM_DIR_PATH]: path.join(cwd, 'npm-never'),
    [KIKX_PLUGIN_INSTALL_ENABLED_PATH]: installEnabled,
  };
}

async function loadFixture(harness, dir) {
  const { loadPlugins } = await import('../../src/core/plugins/plugin-loader.mjs');
  const loaded = await loadPlugins({
    pluginPaths: dir,
    registry: harness.registry,
    commandRegistry: { register() {}, get() { return null; }, list() { return []; } },
    context: {},
    logger: silent,
  });
  return loaded;
}

async function uninstall(harness, store, name) {
  const response = fakeResponse();
  const handled = await handlePluginRoutes({
    request: fakeRequest({ method: 'POST', body: JSON.stringify({ name }) }),
    response,
    url: new URL('/api/v1/plugins/uninstall', 'http://localhost'),
    context: fakeContext({
      pluginRouter: harness.router,
      pluginRegistry: harness.registry,
      pluginMigrations: harness.migrations,
      commandRegistry: { register() {}, get() { return null; }, list() { return []; } },
      config: { get: async (p) => store[p] },
      accountStore: operator,
      pluginRouterForNoMounts: noMounts,
    }),
  });
  return { handled, response };
}

function tmpRoots(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-uninst-'));
  const pluginsRoot = path.join(cwd, 'plugins');
  fs.mkdirSync(pluginsRoot, { recursive: true });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, pluginsRoot };
}

test('unmanaged location refuses with the card notice wording and changes nothing', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = await writeFixturePlugin(pluginsRoot, 'unmanaged-one');
  await loadFixture(harness, dir);

  // Configured roots deliberately do NOT cover the plugin directory.
  const store = configStore({ cwd, roots: path.join(cwd, 'somewhere-else') });
  const { response } = await uninstall(harness, store, 'unmanaged-one');

  assert.equal(response.statusCode, 403, 'built-ins / unknown roots are never uninstallable');
  assert.match(JSON.parse(response.body).error.message, /Internal Plugin — cannot be uninstalled/,
    'the route answer mirrors the card notice exactly');
  assert.ok(fs.existsSync(dir), 'the directory is untouched');
  assert.ok(harness.registry._pluginRegistrations?.has('unmanaged-one'), 'still loaded');
});

test('the config gate applies to uninstall exactly as it does to install', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = await writeFixturePlugin(pluginsRoot, 'gated-one');
  await loadFixture(harness, dir);

  const store = configStore({ cwd, roots: pluginsRoot, installEnabled: false });
  const { response } = await uninstall(harness, store, 'gated-one');

  assert.equal(response.statusCode, 403);
  assert.match(JSON.parse(response.body).error.message, /KIKX_PLUGIN_INSTALL_ENABLED/,
    'the same 403 hint the install gate surfaces');
  assert.ok(fs.existsSync(dir), 'a refused uninstall deletes nothing');
});

test('managed uninstall: unload BEFORE delete, runtime list pruned, data outside retained', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = await writeFixturePlugin(pluginsRoot, 'doomed');
  await loadFixture(harness, dir);
  assert.ok(harness.registry._pluginRegistrations?.has('doomed'), 'precondition: loaded');

  // The plugin's dir is a runtime-managed path (as an npm/path install would be).
  appendRuntimePluginPath(dir, { cwd });
  // Durable data lives OUTSIDE the plugin dir and must survive (owner ruling:
  // durable plugin data retained — purge is a separate future action).
  const dataFile = path.join(cwd, 'plugin-data', 'doomed-state.json');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, '{"keep":"me"}');

  const store = configStore({ cwd, roots: path.join(cwd, 'not-covering') });
  const { handled, response } = await uninstall(harness, store, 'doomed');

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200, 'runtime list covers it → managed → uninstallable');
  const payload = JSON.parse(response.body).data;
  assert.equal(payload.unloaded, true, 'the runtime was torn down');
  assert.equal(payload.removed, true, 'and the files are gone');

  assert.equal(fs.existsSync(dir), false, 'the managed directory is deleted');
  assert.ok(!harness.registry._pluginRegistrations?.has('doomed'), 'not in the registry');
  assert.equal(harness.registry.getTool('doomed-tool'), null, 'its tool is unregistered');
  assert.deepEqual(harness.router.listMounts(), [], 'its mount no longer serves');

  // Ordering proof: at teardown time (unload), the directory still existed.
  // (The record file lands BESIDE the fixture in pluginsRoot, not at cwd.)
  const teardownRecord = fs.readFileSync(path.join(pluginsRoot, 'doomed-teardown.txt'), 'utf8');
  assert.equal(teardownRecord, 'true',
    'unload ran while the directory still existed — files may only vanish AFTER teardown');

  const runtimeList = JSON.parse(fs.readFileSync(path.join(cwd, '.kikx', 'plugin-paths.json'), 'utf8'));
  assert.ok(!runtimeList.includes(dir), 'the runtime path list no longer names a deleted dir (reload stays clean)');

  assert.ok(fs.existsSync(dataFile), 'durable plugin data outside the directory is retained');
});

test('a failed unload refuses the uninstall: 500, directory intact — and a retry recovers', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = await writeFixturePlugin(pluginsRoot, 'sticky');
  await loadFixture(harness, dir);
  appendRuntimePluginPath(dir, { cwd });

  // unloadPlugin() deliberately swallows teardown errors (documented: an
  // unreleased mount serving a dead plugin is worse than a noisy shutdown),
  // so the honest way to hit the route's failure branch is a release that
  // throws — which unloadPlugin does NOT catch.
  harness.registry.releasePlugin = async () => { throw new Error('release exploded'); };

  const store = configStore({ cwd, roots: pluginsRoot });
  const { response } = await uninstall(harness, store, 'sticky');

  assert.equal(response.statusCode, 500, 'a failed unload must not report success');
  assert.match(JSON.parse(response.body).error.message, /release exploded/);
  assert.ok(fs.existsSync(dir), 'and must NOT delete the files of a plugin whose release failed');

  // RETRY after the partial unload: the record is gone, but the runtime path
  // list still names the directory — the second attempt must find it by that
  // route and finish the job instead of answering 404 and orphaning files.
  delete harness.registry.releasePlugin;
  const retry = await uninstall(harness, store, 'sticky');
  assert.equal(retry.response.statusCode, 200, 'the retry completes what the failed attempt started');
  const data = JSON.parse(retry.response.body).data;
  assert.equal(data.unloaded, false, 'nothing was left to unload');
  assert.equal(data.removed, true);
  assert.equal(fs.existsSync(dir), false, 'the orphaned directory is cleaned up');
});

test('unknown name is a 404 that names the loaded set, never a 200', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  await writeFixturePlugin(pluginsRoot, 'present');
  await loadFixture(harness, path.join(pluginsRoot, 'present'));

  const store = configStore({ cwd, roots: pluginsRoot });
  const { response } = await uninstall(harness, store, 'ghost');

  assert.equal(response.statusCode, 404);
  const payload = JSON.parse(response.body);
  assert.match(payload.error.message, /not installed|not loaded/);
  assert.deepEqual(payload.data.loaded, [ 'present' ], 'the caller can see what IS installed');
});

test('a DISABLED plugin uninstalls from its stored location without an unload', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = await writeFixturePlugin(pluginsRoot, 'sleeping');
  // Not loaded — disabled earlier; only the disabled set knows its location.
  const { setPluginDisabled } = await import('../../src/core/config/runtime-disabled-plugins.mjs');
  setPluginDisabled('sleeping', dir, true, { cwd });

  // Managed ground must cover the stored location — the managed check runs
  // at UNINSTALL time regardless of how the location was learned (a tampered
  // disabled file must not point deletion at arbitrary paths).
  const store = configStore({ cwd, roots: pluginsRoot });
  const { response } = await uninstall(harness, store, 'sleeping');

  assert.equal(response.statusCode, 200, 'disabled entries are uninstallable — the card shows them');
  const payload = JSON.parse(response.body).data;
  assert.equal(payload.unloaded, false, 'nothing was loaded to unload');
  assert.equal(payload.removed, true);
  assert.equal(fs.existsSync(dir), false, 'the directory is gone');
  const { getDisabledPlugin } = await import('../../src/core/config/runtime-disabled-plugins.mjs');
  assert.equal(getDisabledPlugin('sleeping', { cwd }), null, 'the disabled entry is cleaned up too');
});
