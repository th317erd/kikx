'use strict';

import '../support/test-env.mjs';

// Campaign enable/disable (plan §9.1.2, decided in scope): POST
// /api/v1/plugins/set-enabled {name, enabled}. Disable = persist flag +
// unload (never config-gated — it stops code, it doesn't start any). Enable
// = same config gate as install (it LOADS code) + reload-path from the stored
// location + flag cleared only on success; a failed enable ROLLS BACK to
// disabled, so the flag never claims something the registry disagrees with.

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
import {
  getDisabledPlugin,
  setPluginDisabled,
} from '../../src/core/config/runtime-disabled-plugins.mjs';
import { fakeContext, fakeRequest, fakeResponse, operator } from '../support/fake-http.mjs';

const silent = { warn() {}, info() {}, error() {}, debug() {} };
const commands = { register() {}, get() { return null; }, list() { return []; } };

function makeHarness() {
  const registry = new PluginRegistry({ logger: silent });
  const router = new PluginRouter({ logger: silent });
  const migrations = new PluginMigrations({ logger: silent });
  registry.setPluginRouter(router);
  registry.setPluginMigrations(migrations);
  return { registry, router, migrations };
}

function writePlugin(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        const PluginInterface = ctx.registry.getClass('PluginInterface');
        class T extends PluginInterface { async run() { return 'ok'; } }
        ctx.registry.registerTool(${JSON.stringify(`${name}-tool`)}, T);
        ctx.mountHttp(async (_q, res) => { res.end('x'); }, { auth: 'public' });
      });
    }
  `);
  return dir;
}

async function loadFixture(harness, dir) {
  const { loadPlugins } = await import('../../src/core/plugins/plugin-loader.mjs');
  return loadPlugins({ pluginPaths: dir, registry: harness.registry, commandRegistry: commands, context: {}, logger: silent });
}

function store({ cwd, roots, installEnabled = true }) {
  return {
    [KIKX_CWD_PATH]: cwd,
    [KIKX_PLUGIN_PATHS_PATH]: roots,
    [KIKX_PLUGIN_NPM_DIR_PATH]: path.join(cwd, 'npm-base'),
    [KIKX_PLUGIN_INSTALL_ENABLED_PATH]: installEnabled,
  };
}

async function setEnabled(harness, config, body) {
  const response = fakeResponse();
  const handled = await handlePluginRoutes({
    request: fakeRequest({ method: 'POST', body: JSON.stringify(body) }),
    response,
    url: new URL('/api/v1/plugins/set-enabled', 'http://localhost'),
    context: fakeContext({
      pluginRouter: harness.router,
      pluginRegistry: harness.registry,
      pluginMigrations: harness.migrations,
      commandRegistry: commands,
      config: { get: async (p) => config[p] },
      accountStore: operator,
    }),
  });
  return { handled, response };
}

function tmpRoots(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-senen-'));
  const pluginsRoot = path.join(cwd, 'plugins');
  fs.mkdirSync(pluginsRoot, { recursive: true });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, pluginsRoot };
}

test('disable: persists name+location, unloads runtime, answers honestly', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = writePlugin(pluginsRoot, 'toggle-me');
  await loadFixture(harness, dir);
  assert.ok(harness.registry._pluginRegistrations?.has('toggle-me'), 'precondition: loaded');

  const config = store({ cwd, roots: pluginsRoot });
  const { handled, response } = await setEnabled(harness, config, { name: 'toggle-me', enabled: false });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body).data;
  assert.equal(data.enabled, false);
  assert.equal(data.unloaded, true, 'disable → unload (plan 9.1.2)');

  assert.ok(!harness.registry._pluginRegistrations?.has('toggle-me'), 'out of the registry');
  assert.equal(harness.registry.getTool('toggle-me-tool'), null, 'its tool is gone');
  assert.deepEqual(harness.router.listMounts(), [], 'its mount stopped serving');

  const entry = getDisabledPlugin('toggle-me', { cwd });
  assert.ok(entry, 'the flag is durable across restarts');
  assert.equal(entry.location, dir, 'with the location Enable reloads from');
  assert.ok(fs.existsSync(dir), 'disable NEVER deletes files — that is uninstall\'s job');
});

test('disable is not config-gated (stopping code needs no permission beyond identity)', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = writePlugin(pluginsRoot, 'stop-me');
  await loadFixture(harness, dir);

  const config = store({ cwd, roots: pluginsRoot, installEnabled: false });
  const { response } = await setEnabled(harness, config, { name: 'stop-me', enabled: false });

  assert.equal(response.statusCode, 200, 'a deployment that cannot install can still STOP a plugin');
  assert.ok(!harness.registry._pluginRegistrations?.has('stop-me'));
});

test('enable: config-gated, reloads from the stored location, clears the flag', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = writePlugin(pluginsRoot, 'wake-me');
  // Previously disabled: not loaded, only the disabled set knows the location.
  setPluginDisabled('wake-me', dir, true, { cwd });

  // Managed ground covers the container; the exact directory comes FROM THE
  // FILE — config never names the plugin dir itself.
  const config = store({ cwd, roots: pluginsRoot });
  const { response } = await setEnabled(harness, config, { name: 'wake-me', enabled: true });

  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body).data;
  assert.equal(data.enabled, true);
  assert.equal(data.loaded, true, 'enable → reload-path from the stored location');
  assert.ok(harness.registry._pluginRegistrations?.has('wake-me'), 'actually running again');
  assert.ok(harness.registry.getTool('wake-me-tool'), 'its registrations are back');
  assert.equal(getDisabledPlugin('wake-me', { cwd }), null, 'the flag is cleared only AFTER the load succeeded');
});

test('enable respects the install config gate and leaves the flag untouched', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = writePlugin(pluginsRoot, 'blocked');
  setPluginDisabled('blocked', dir, true, { cwd });

  const config = store({ cwd, roots: pluginsRoot, installEnabled: false });
  const { response } = await setEnabled(harness, config, { name: 'blocked', enabled: true });

  assert.equal(response.statusCode, 403, 'enable LOADS code — same gate as install');
  assert.ok(!harness.registry._pluginRegistrations?.has('blocked'), 'not loaded');
  assert.ok(getDisabledPlugin('blocked', { cwd }), 'still disabled — no partial state');
});

test('enable of an unknown, never-disabled plugin is a 404', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const config = store({ cwd, roots: pluginsRoot });

  const { response } = await setEnabled(harness, config, { name: 'phantom', enabled: true });
  assert.equal(response.statusCode, 404, 'nowhere to load from = honest 404, never a silent no-op');
});

test('a failing enable rolls back to disabled: 500, flag kept, nothing loaded', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const dir = path.join(cwd, 'broken-loc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const pluginName = "broken";\nexport function setup() { throw new Error("setup exploded"); }');
  setPluginDisabled('broken', dir, true, { cwd });

  const config = store({ cwd, roots: cwd });
  const { response } = await setEnabled(harness, config, { name: 'broken', enabled: true });

  assert.equal(response.statusCode, 500, 'a failed load reports failure');
  assert.match(JSON.parse(response.body).error.message, /setup exploded/);
  assert.ok(getDisabledPlugin('broken', { cwd }),
    'ROLLBACK: the flag returns to disabled — state never claims a load that failed');
  assert.ok(!harness.registry._pluginRegistrations?.has('broken'));
});

test('malformed bodies are 400s', async (t) => {
  const { cwd, pluginsRoot } = tmpRoots(t);
  const harness = makeHarness();
  const config = store({ cwd, roots: pluginsRoot });

  for (const body of [ {}, { name: '' }, { enabled: 'yes' }, { name: 'x' } ]) {
    const { response } = await setEnabled(harness, config, body);
    assert.equal(response.statusCode, 400, `body ${JSON.stringify(body)} is a 400`);
  }
});
