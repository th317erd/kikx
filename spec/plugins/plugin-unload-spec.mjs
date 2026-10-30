'use strict';

// Contract test for unloadPlugin().
//
// The campaign plan (docs/plans/plugin-platform-campaign.md) records this defect:
//   "unloadPlugin() does not remove HTTP mounts, migrations, scoped DB handles,
//    authority instances, or event subscriptions. dropPluginSubscriptions() exists
//    but is unused."
//
// Each test loads a real plugin from a temp directory, asserts the asset is present
// while loaded, unloads it, and asserts the asset is gone. A plugin that leaves
// anything behind is still reachable after being unloaded: a mount still serves its
// handler, a subscription still receives other sessions' traffic, a migration still
// claims its directory, and a surviving db handle still runs SQL.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlugins, unloadPlugin } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { PluginRouter } from '../../src/core/plugins/plugin-router.mjs';
import { PluginEventBus } from '../../src/core/plugins/plugin-events.mjs';
import { PluginMigrations } from '../../src/core/plugins/plugin-migrations.mjs';
import { PluginDatabase } from '../../src/core/plugins/plugin-database.mjs';

const silent = { warn() {}, info() {}, error() {} };

// A plugin that touches every collection the loader offers, written to disk rather
// than stubbed so the test exercises the same import path the server uses.
async function writePlugin(root, name) {
  let table = name.replace(/-/g, '_') + '_widget';
  let dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'sql'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(
    path.join(dir, 'sql', '001-probe.sql'),
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY);`,
  );
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        const { registry } = ctx;
        const AgentInterface = registry.getClass('AgentInterface');
        const PluginInterface = registry.getClass('PluginInterface');

        class ProbeAgent extends AgentInterface {
          static pluginId = ${JSON.stringify(name + '-agent')};
          static displayName = 'Probe Agent';
          static configFields = [];
        }
        class ProbeTool extends PluginInterface {
          static description = 'probe tool';
          async run() { return 'ok'; }
        }

        registry.registerAgentType(${JSON.stringify(name + '-agent')}, ProbeAgent);
        registry.registerTool(${JSON.stringify(name + '-tool')}, ProbeTool);
        ctx.registerFrameIndex(${JSON.stringify(name + '-index')}, { type: 'probe' });
        ctx.registerTagDefinition(${JSON.stringify(name + '-tag')}, { description: 'probe tag' });
        ctx.registerSelector(${JSON.stringify('Type:' + name + 'Frame')}, ProbeTool);
        ctx.mountHttp(async (_req, res) => { res.end('probe'); });
        ctx.registerMigrations({ directory: 'sql' });
        ctx.subscribe(() => {}, { sessions: [ 'probe-session' ] });
        // Touch the scoped database and the authority so both caches are populated.
        ctx.db();
        ctx.authorize({ action: 'probe' });
      });
    }
  `);
  return dir;
}

function makeRegistry() {
  let registry = new PluginRegistry({ logger: silent });
  let router = new PluginRouter({ logger: silent });
  let bus = new PluginEventBus({ logger: silent });
  let migrations = new PluginMigrations({ logger: silent });
  registry.setPluginRouter(router);
  registry.setPluginEventBus(bus);
  registry.setPluginMigrations(migrations);
  // A stand-in pool: this contract is about releasing references, not about talking
  // to PostgreSQL, so no connection is opened here.
  let pool = { query: async () => ({ rows: [] }) };
  registry.setPluginDatabaseFactory((pluginId) => new PluginDatabase({ pluginId, pool, logger: silent }));
  registry.setPluginAuthorityFactory((pluginId) => ({
    pluginId,
    db: registry.getPluginDatabase(pluginId),
    authorize: async () => ({ allowed: false }),
  }));
  return { registry, router, bus, migrations };
}

test('unloadPlugin removes the HTTP mount', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-'));
  let { registry, router } = makeRegistry();
  await writePlugin(root, 'unload-probe');
  await loadPlugins({ pluginPaths: path.join(root, 'unload-probe'), registry, logger: silent });

  assert.deepEqual(router.listMounts().map((m) => m.pluginId), [ 'unload-probe' ], 'mount present while loaded');
  await unloadPlugin(registry, 'unload-probe', { logger: silent });
  assert.deepEqual(router.listMounts(), [], 'mount must be gone after unload');
});

test('unloadPlugin removes the event subscription', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-'));
  let { registry, bus } = makeRegistry();
  await writePlugin(root, 'unload-probe');
  await loadPlugins({ pluginPaths: path.join(root, 'unload-probe'), registry, logger: silent });

  assert.deepEqual(bus.list().map((s) => s.pluginId), [ 'unload-probe' ], 'subscription present while loaded');
  await unloadPlugin(registry, 'unload-probe', { logger: silent });
  assert.deepEqual(bus.list(), [], 'subscription must be gone after unload');
});

test('unloadPlugin removes the migration registration', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-'));
  let { registry, migrations } = makeRegistry();
  await writePlugin(root, 'unload-probe');
  await loadPlugins({ pluginPaths: path.join(root, 'unload-probe'), registry, logger: silent });

  assert.equal(migrations.plugins.has('unload-probe'), true, 'migration registered while loaded');
  await unloadPlugin(registry, 'unload-probe', { logger: silent });
  assert.equal(migrations.plugins.has('unload-probe'), false, 'migration must be deregistered after unload');
});

test('unloadPlugin releases the scoped database handle and closes it', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-'));
  let { registry } = makeRegistry();
  await writePlugin(root, 'unload-probe');
  await loadPlugins({ pluginPaths: path.join(root, 'unload-probe'), registry, logger: silent });

  let handle = registry.getPluginDatabase('unload-probe');
  assert.equal(handle.closed, false, 'handle is open while loaded');
  await unloadPlugin(registry, 'unload-probe', { logger: silent });

  assert.equal(registry._pluginDatabases?.has('unload-probe') ?? false, false, 'handle must be dropped from the registry');
  assert.equal(handle.closed, true, 'a surviving reference must see the handle closed');
  await assert.rejects(() => handle.query('SELECT * FROM unload_probe_widget'), /closed/i);
});

test('unloadPlugin releases the authority instance', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-'));
  let { registry } = makeRegistry();
  await writePlugin(root, 'unload-probe');
  await loadPlugins({ pluginPaths: path.join(root, 'unload-probe'), registry, logger: silent });

  registry.getPluginAuthority('unload-probe');
  assert.equal(registry._pluginAuthorities?.has('unload-probe'), true, 'authority present while loaded');
  await unloadPlugin(registry, 'unload-probe', { logger: silent });
  assert.equal(registry._pluginAuthorities?.has('unload-probe') ?? false, false, 'authority must be dropped');
});

test('unloadPlugin removes tools, agent types, selectors, tags, frame indexes and plugin path', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-'));
  let { registry } = makeRegistry();
  await writePlugin(root, 'unload-probe');
  await loadPlugins({ pluginPaths: path.join(root, 'unload-probe'), registry, logger: silent });

  assert.ok(registry.getTool('unload-probe-tool'), 'tool present while loaded');
  assert.ok(registry.getAgentProvider('unload-probe-agent'), 'agent type present while loaded');
  assert.equal(registry.getSelectors().some((s) => s.selector === 'Type:unload-probeFrame'), true, 'selector present while loaded');
  assert.ok(registry.getTagDefinition('unload-probe-tag'), 'tag present while loaded');
  assert.equal(registry.getFrameIndexes().some((i) => i.name === 'unload-probe-index'), true, 'frame index present while loaded');
  assert.ok(registry.getPluginPath('unload-probe'), 'plugin path present while loaded');

  await unloadPlugin(registry, 'unload-probe', { logger: silent });

  assert.equal(registry.getTool('unload-probe-tool'), null, 'tool must be gone');
  assert.equal(registry.getAgentProvider('unload-probe-agent'), null, 'agent type must be gone');
  assert.equal(registry.getSelectors().some((s) => s.selector === 'Type:unload-probeFrame'), false, 'selector must be gone');
  assert.equal(registry.getTagDefinition('unload-probe-tag'), null, 'tag must be gone');
  assert.equal(registry.getFrameIndexes().some((i) => i.name === 'unload-probe-index'), false, 'frame index must be gone');
  assert.equal(registry.getPluginPath('unload-probe'), null, 'plugin path must be gone');
});

test('unloading one plugin leaves another plugin and core registrations intact', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-'));
  let { registry, router, bus } = makeRegistry();

  await writePlugin(root, 'unload-keep');
  await writePlugin(root, 'unload-drop');
  let loaded = await loadPlugins({
    pluginPaths: [ path.join(root, 'unload-keep'), path.join(root, 'unload-drop') ].join(path.delimiter),
    registry,
    logger: silent,
  });
  assert.deepEqual(loaded.map((l) => l.pluginName).sort(), [ 'unload-drop', 'unload-keep' ]);

  // A core registration made outside any plugin scope must survive everything.
  let PluginInterface = registry.getClass('PluginInterface');
  class BuiltinTool extends PluginInterface { async run() { return 'builtin'; } }
  registry.registerTool('shared-tool', BuiltinTool);

  await unloadPlugin(registry, 'unload-keep', { logger: silent });

  assert.deepEqual(router.listMounts().map((m) => m.pluginId), [ 'unload-drop' ], 'the other plugin keeps its mount');
  assert.deepEqual(bus.list().map((s) => s.pluginId), [ 'unload-drop' ], 'the other plugin keeps its subscription');
  assert.ok(registry.getTool('unload-drop-tool'), 'the other plugin keeps its tool');
  assert.equal(registry.getTool('shared-tool'), BuiltinTool, 'core tool survives an unrelated unload');

  await unloadPlugin(registry, 'unload-drop', { logger: silent });
  assert.deepEqual(router.listMounts(), []);
  assert.deepEqual(bus.list(), []);
  assert.equal(registry.getTool('shared-tool'), BuiltinTool, 'core tool survives every unload');
});

test('unloadPlugin reports false for a plugin that was never loaded', async () => {
  let { registry } = makeRegistry();
  assert.equal(await unloadPlugin(registry, 'no-such-plugin', { logger: silent }), false);
});

test('unloadPlugin is not fatal for a plugin with no teardown and no resources', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-'));
  let dir = path.join(root, 'unload-bare');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = 'unload-bare';
    export function setup() {}
  `);

  let { registry, router, bus } = makeRegistry();
  let loaded = await loadPlugins({ pluginPaths: dir, registry, logger: silent });
  assert.equal(loaded.length, 1);
  assert.equal(await unloadPlugin(registry, 'unload-bare', { logger: silent }), true);
  assert.deepEqual(router.listMounts(), []);
  assert.deepEqual(bus.list(), []);
});
