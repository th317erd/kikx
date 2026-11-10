'use strict';

import '../support/test-env.mjs';

// Campaign S5 (plan §5-S5 + 9.1.3): after EVERY successful admin action the
// route publishes exactly one `plugin.changed {pluginID, action, actor}` through
// frameRuntime.emitRuntimeEvent — the same seam session.saved/tokens.updated
// already ride to every SSE subscriber (the gateway lets session-less events
// through filtered subscribers). Failure paths must publish NOTHING: a refused
// action that told other clients to refresh would be a lie.

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
  KIKX_PLUGIN_SIGNATURE_MODE_PATH,
} from '../../src/core/config/config-paths.mjs';
import { fakeContext, fakeRequest, fakeResponse, operator } from '../support/fake-http.mjs';

const silent = { warn() {}, info() {}, error() {}, debug() {} };
const commands = { register() {}, get() { return null; }, list() { return []; } };

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
        ctx.registerTool(${JSON.stringify(`${name}-tool`)}, T);
      });
    }
  `);
  return dir;
}

async function loadFixture(registry, dir) {
  const { loadPlugins } = await import('../../src/core/plugins/plugin-loader.mjs');
  return loadPlugins({ pluginPaths: dir, registry, commandRegistry: commands, context: {}, logger: silent });
}

async function call(harness, store, publishCalls, pathname, body) {
  const response = fakeResponse();
  const before = publishCalls.length;
  const handled = await handlePluginRoutes({
    request: fakeRequest({ method: 'POST', body: JSON.stringify(body) }),
    response,
    url: new URL(pathname, 'http://localhost'),
    context: fakeContext({
      pluginRouter: harness.router,
      pluginRegistry: harness.registry,
      pluginMigrations: harness.migrations,
      commandRegistry: commands,
      config: { get: async (p) => store[p] },
      accountStore: operator,
      // The S5 publish seam: emitRuntimeEvent(type, payload) — recorder only.
      frameRuntime: { emitRuntimeEvent: (type, payload) => publishCalls.push([ type, payload ]) },
    }),
  });
  return { handled, response, published: publishCalls.slice(before) };
}

test('each successful action publishes exactly one plugin.changed with a real actor', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-s5-'));
  const pluginsRoot = path.join(cwd, 'plugins');
  fs.mkdirSync(pluginsRoot, { recursive: true });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const store = {
    [KIKX_CWD_PATH]: cwd,
    [KIKX_PLUGIN_PATHS_PATH]: pluginsRoot,
    [KIKX_PLUGIN_NPM_DIR_PATH]: path.join(cwd, 'npm-base'),
    [KIKX_PLUGIN_INSTALL_ENABLED_PATH]: true,
    [KIKX_PLUGIN_SIGNATURE_MODE_PATH]: 'unsafe',
  };
  const harness = {
    registry: new PluginRegistry({ logger: silent }),
    router: new PluginRouter({ logger: silent }),
    migrations: new PluginMigrations({ logger: silent }),
  };
  harness.registry.setPluginRouter(harness.router);
  harness.registry.setPluginMigrations(harness.migrations);

  const baseDir = writePlugin(pluginsRoot, 'base-one');
  const secondDir = writePlugin(pluginsRoot, 'second-one');
  await loadFixture(harness.registry, baseDir);
  assert.ok(harness.registry._pluginRegistrations?.has('base-one'), 'precondition: loaded');

  const publishes = [];
  const expectOne = (published, action, pluginID) => {
    assert.equal(published.length, 1, `${action}: exactly ONE publish per successful action`);
    const [ type, payload ] = published[0];
    assert.equal(type, 'plugin.changed', 'through the shared runtime-event seam');
    assert.equal(payload.action, action);
    assert.equal(payload.pluginID, pluginID, 'the plugin the action named');
    assert.equal(payload.actor, 'operator-1', 'the operator identity rides along (audit seam, 10.7)');
  };

  // install (path shape — the npm shape shares this branch after landing)
  let r = await call(harness, store, publishes, '/api/v1/plugins/install', { path: secondDir });
  assert.equal(r.response.statusCode, 201, 'precondition: installed');
  expectOne(r.published, 'install', 'second-one');

  // reload (repo-wide: pluginID is null, the action still announces itself)
  r = await call(harness, store, publishes, '/api/v1/plugins/reload', {});
  assert.equal(r.response.statusCode, 200, 'precondition: reloaded');
  expectOne(r.published, 'reload', null);

  // unload
  r = await call(harness, store, publishes, '/api/v1/plugins/unload', { name: 'second-one' });
  assert.equal(r.response.statusCode, 200, 'precondition: unloaded');
  expectOne(r.published, 'unload', 'second-one');

  // set-enabled: disable, then enable (both announce)
  r = await call(harness, store, publishes, '/api/v1/plugins/set-enabled', { name: 'base-one', enabled: false });
  assert.equal(r.response.statusCode, 200, 'precondition: disabled');
  expectOne(r.published, 'disable', 'base-one');

  r = await call(harness, store, publishes, '/api/v1/plugins/set-enabled', { name: 'base-one', enabled: true });
  assert.equal(r.response.statusCode, 200, 'precondition: enabled again');
  expectOne(r.published, 'enable', 'base-one');

  // uninstall
  r = await call(harness, store, publishes, '/api/v1/plugins/uninstall', { name: 'base-one' });
  assert.equal(r.response.statusCode, 200, 'precondition: uninstalled');
  expectOne(r.published, 'uninstall', 'base-one');

  assert.equal(publishes.length, 6, 'six actions, six events — nothing duplicated, nothing missed');
});

test('failure paths publish NOTHING — a refused action never tells clients to refresh', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-s5f-'));
  const pluginsRoot = path.join(cwd, 'plugins');
  fs.mkdirSync(pluginsRoot, { recursive: true });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const store = {
    [KIKX_CWD_PATH]: cwd,
    [KIKX_PLUGIN_PATHS_PATH]: pluginsRoot,
    [KIKX_PLUGIN_NPM_DIR_PATH]: path.join(cwd, 'npm-base'),
    [KIKX_PLUGIN_INSTALL_ENABLED_PATH]: true,
    [KIKX_PLUGIN_SIGNATURE_MODE_PATH]: 'unsafe',
  };
  const harness = {
    registry: new PluginRegistry({ logger: silent }),
    router: new PluginRouter({ logger: silent }),
    migrations: new PluginMigrations({ logger: silent }),
  };
  harness.registry.setPluginRouter(harness.router);
  harness.registry.setPluginMigrations(harness.migrations);
  const baseDir = writePlugin(pluginsRoot, 'f-base');
  await loadFixture(harness.registry, baseDir);

  const publishes = [];

  // 404 unload of a ghost
  let r = await call(harness, store, publishes, '/api/v1/plugins/unload', { name: 'ghost' });
  assert.equal(r.response.statusCode, 404);
  assert.equal(r.published.length, 0, '404 publishes nothing');

  // 400 malformed set-enabled
  r = await call(harness, store, publishes, '/api/v1/plugins/set-enabled', { name: 'f-base' });
  assert.equal(r.response.statusCode, 400);
  assert.equal(r.published.length, 0, '400 publishes nothing');

  // 403 config gate: off, then an uninstall attempt
  store[KIKX_PLUGIN_INSTALL_ENABLED_PATH] = false;
  r = await call(harness, store, publishes, '/api/v1/plugins/uninstall', { name: 'f-base' });
  assert.equal(r.response.statusCode, 403);
  assert.equal(r.published.length, 0, '403 publishes nothing — and the plugin is still loaded');
  assert.ok(harness.registry._pluginRegistrations?.has('f-base'), 'refused uninstall changed nothing');

  assert.equal(publishes.length, 0, 'across all three failures: zero events');
});
