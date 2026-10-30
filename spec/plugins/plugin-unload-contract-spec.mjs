'use strict';

// The unload contract, from docs/plans/plugin-platform-campaign.md §8.1:
//
//   4. "Unload is now mostly reversible but split across two mechanisms. The ownership
//      ledger releases mounts, migrations, tools, selectors, tags, drivers, components,
//      indexes, DB handles and subscriptions; class-stack overrides are released
//      separately. The remaining test gap is proving both paths, plus live-instance
//      generation, in one unload contract."
//
//   5. "A class override is not a live behavior change. A reload that does not
//      reconstruct the affected instance must report `restart-required`; otherwise the
//      registry row looks changed while the running service is stale."
//
// plugin-unload-spec.mjs proves the ledger path one family at a time. plugin-attribution-
// spec.mjs proves attribution. Neither proves that a single unload() releases *both*
// mechanisms, and neither says anything about live instances. That is what this file is
// for.
//
// Why generation cannot be skipped: every overridable core class is resolved exactly once,
// at construction time, through resolveCoreClass(). create-server.mjs constructs
// frameRouter at line 242 but only awaits the plugin load at line 281 - so a plugin's
// FrameRouter override is registered after the router already exists and can never affect
// it. frameRuntime and compactionService, constructed at 473 and 519, are rebuilt from the
// registry and therefore do pick the override up. Two overrides, opposite outcomes, and
// before this file nothing distinguished them.

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
import { registerCoreClasses, resolveCoreClass } from '../../src/core/plugins/core-classes.mjs';

const silent = { warn() {}, info() {}, error() {} };

// A plugin that registers into the ledger AND pushes a class override, so one unload has
// to unwind both. Written to disk rather than stubbed: the test exercises the same
// import path the server uses.
//
// The override is registered as `registry.registerClass('ProbeService', Override)` with no
// pluginName - the shape both in-repo plugins use - so this also proves the ambient
// load scope still attributes it after the loader changes.
async function writePlugin(root, name) {
  let dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'sql'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  // Registered but never run: running it would execute DDL, and this contract is about
  // release, not migration semantics.
  await fs.writeFile(path.join(dir, 'sql', '001-probe.sql'), 'SELECT 1;');
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        const { registry } = ctx;
        const PluginInterface = registry.getClass('PluginInterface');

        class ProbeTool extends PluginInterface {
          static description = 'contract probe tool';
          async run() { return 'ok'; }
        }

        class ProbeServiceOverride {
          static marker = 'override';
        }

        registry.registerClass('ProbeService', ProbeServiceOverride);
        ctx.registerTool('contract-probe-tool', ProbeTool);
        ctx.registerTagDefinition('contract-probe-tag', { description: 'probe tag' });
        ctx.registerFrameIndex('contract-probe-index', { type: 'probe' });
        ctx.registerSelector('Type:contract-probeFrame', ProbeTool);
        ctx.mountHttp(async (_request, response) => { response.end('probe'); });
        ctx.registerMigrations({ directory: 'sql' });
        ctx.subscribe(() => {}, { sessions: [ 'contract-probe-session' ] });
        ctx.db();
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
  // Stand-in pool: this contract is about releasing references, not talking to PostgreSQL.
  let pool = { query: async () => ({ rows: [] }) };
  registry.setPluginDatabaseFactory((pluginId) => new PluginDatabase({ pluginId, pool, logger: silent }));
  registry.setPluginAuthorityFactory((pluginId) => ({
    pluginId,
    db: registry.getPluginDatabase(pluginId),
    authorize: async () => ({ allowed: false }),
  }));
  return { registry, router, bus, migrations };
}

// Everything the ledger path owns, as a single snapshot. Asking one question of many
// families means a family that silently stops being released fails here rather than
// passing because nobody looked.
function ledgerState(registry, router, bus) {
  return {
    tool: Boolean(registry.getTool('contract-probe-tool')),
    tag: Boolean(registry.getTagDefinition('contract-probe-tag')),
    index: registry.getFrameIndexes().some((i) => i.name === 'contract-probe-index'),
    selector: registry.getSelectors().some((s) => s.selector === 'Type:contract-probeFrame'),
    mount: router.listMounts().map((m) => m.pluginId),
    subscription: bus.list().map((s) => s.pluginId),
  };
}

test('one unload releases the ownership ledger and the class stack together', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-contract-'));
  let { registry, router, bus } = makeRegistry();

  // A core-owned class below the plugin's, so the pop must restore it rather than delete
  // the key. unregisterPlugin() filters by owner; if it deleted the stack the fallback
  // would be gone and the override would be irreversible in the wrong direction.
  class BaseService { static marker = 'base'; }
  registry.registerClass('ProbeService', BaseService, { pluginName: 'core' });

  await writePlugin(root, 'contract-probe');
  await loadPlugins({ pluginPaths: path.join(root, 'contract-probe'), registry, logger: silent });

  let loaded = ledgerState(registry, router, bus);
  assert.equal(loaded.tool, true, 'tool present while loaded');
  assert.equal(loaded.tag, true, 'tag present while loaded');
  assert.equal(loaded.index, true, 'frame index present while loaded');
  assert.equal(loaded.selector, true, 'selector present while loaded');
  assert.deepEqual(loaded.mount, [ 'contract-probe' ], 'mount present while loaded');
  assert.deepEqual(loaded.subscription, [ 'contract-probe' ], 'subscription present while loaded');
  assert.equal(registry.getClass('ProbeService').marker, 'override', 'class override wins while loaded');

  await unloadPlugin(registry, 'contract-probe', { logger: silent });

  let released = ledgerState(registry, router, bus);
  assert.equal(released.tool, false, 'tool must be gone');
  assert.equal(released.tag, false, 'tag must be gone');
  assert.equal(released.index, false, 'frame index must be gone');
  assert.equal(released.selector, false, 'selector must be gone');
  assert.deepEqual(released.mount, [], 'mount must be gone');
  assert.deepEqual(released.subscription, [], 'subscription must be gone');

  // The second mechanism. Popping must expose the class underneath, not an empty stack.
  assert.equal(registry.hasClass('ProbeService'), true, 'the core registration must survive the pop');
  assert.equal(registry.getClass('ProbeService').marker, 'base', 'the stack must fall back to core');
});

test('a partially failed load releases both mechanisms for what it did register', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-contract-'));
  let { registry, router, bus } = makeRegistry();

  class BaseService { static marker = 'base'; }
  registry.registerClass('ProbeService', BaseService, { pluginName: 'core' });

  // Throws after registering into both mechanisms, which is the only way to reach the
  // rollback path with something to roll back.
  let dir = path.join(root, 'contract-broken');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = 'contract-broken';
    export function setup(provide) {
      provide((ctx) => {
        const { registry } = ctx;
        const PluginInterface = registry.getClass('PluginInterface');
        class BrokenTool extends PluginInterface {
          static description = 'broken';
          async run() { return 'nope'; }
        }
        registry.registerClass('ProbeService', class { static marker = 'override'; });
        ctx.registerTool('contract-broken-tool', BrokenTool);
        ctx.mountHttp(async (_request, response) => { response.end('broken'); });
        ctx.subscribe(() => {}, { sessions: [ 'contract-broken-session' ] });
        throw new Error('setup blew up after registering');
      });
    }
  `);

  await loadPlugins({ pluginPaths: dir, registry, logger: silent });

  assert.equal(registry.getTool('contract-broken-tool'), null, 'a failed load must not leave a tool behind');
  assert.deepEqual(router.listMounts(), [], 'a failed load must not leave a mount serving');
  assert.deepEqual(bus.list(), [], 'a failed load must not leave a subscription live');
  assert.equal(
    registry.getClass('ProbeService').marker,
    'base',
    'a failed load must not leave its class override on the stack',
  );
});

test('a class override registered after construction reports restart-required', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-contract-'));
  let { registry } = makeRegistry();
  registerCoreClasses(registry);

  // This is create-server.mjs's real order: construct first, load plugins second.
  resolveCoreClass(registry, 'FrameRouter', class Fallback {});

  assert.deepEqual(registry.listRestartRequired(), [], 'a freshly resolved core class is not stale');

  await writePlugin(root, 'contract-probe');
  let dir = path.join(root, 'contract-probe');
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = 'contract-probe';
    export function setup(provide) {
      provide((ctx) => {
        ctx.registry.registerClass('FrameRouter', class PluginRouterOverride {});
      });
    }
  `);
  await loadPlugins({ pluginPaths: dir, registry, logger: silent });

  // The registry row now says FrameRouter is the plugin's class ...
  assert.equal(registry.getClass('FrameRouter').name, 'PluginRouterOverride', 'the stack top changed');
  // ... but the router the server already built came from core, and core instances are
  // never swapped in place.
  assert.deepEqual(
    registry.listRestartRequired(),
    [ 'FrameRouter' ],
    'the platform must say the running instance is stale rather than imply the override took effect',
  );
});

test('an instance built from a plugin override reports restart-required once that plugin unloads', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-contract-'));
  let { registry } = makeRegistry();
  registerCoreClasses(registry);

  await writePlugin(root, 'contract-probe');
  let dir = path.join(root, 'contract-probe');
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = 'contract-probe';
    export function setup(provide) {
      provide((ctx) => {
        ctx.registry.registerClass('FrameRuntime', class PluginRuntimeOverride {});
      });
    }
  `);
  await loadPlugins({ pluginPaths: dir, registry, logger: silent });

  // Constructed *after* the load, so this instance really is the plugin's class - the
  // opposite ordering to the previous test, and the reason both directions are needed.
  let RuntimeClass = resolveCoreClass(registry, 'FrameRuntime', class Fallback {});
  assert.equal(RuntimeClass.name, 'PluginRuntimeOverride', 'the resolved class is the override');
  assert.equal(registry.getClass('FrameRuntime').name, 'PluginRuntimeOverride', 'override is on top');
  assert.deepEqual(registry.listRestartRequired(), [], 'instance and stack agree, so nothing is stale');

  await unloadPlugin(registry, 'contract-probe', { logger: silent });

  // The class stack is back to core. The instance is not: it is still running the
  // unloaded plugin's code, and nothing can rebuild it in place.
  assert.equal(registry.getClass('FrameRuntime').name, 'FrameRuntime', 'the stack popped back to core');
  assert.deepEqual(
    registry.listRestartRequired(),
    [ 'FrameRuntime' ],
    'a live instance outliving its override must be reported, not silently mislabelled as core',
  );
});

test('restart-required clears when the stack is restored to what the instance was built from', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-unload-contract-'));
  let { registry } = makeRegistry();
  registerCoreClasses(registry);

  resolveCoreClass(registry, 'FrameRuntime', class Fallback {});
  assert.deepEqual(registry.listRestartRequired(), [], 'not stale to begin with');

  await writePlugin(root, 'contract-probe');
  let dir = path.join(root, 'contract-probe');
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = 'contract-probe';
    export function setup(provide) {
      provide((ctx) => {
        ctx.registry.registerClass('FrameRuntime', class PluginRuntimeOverride {});
      });
    }
  `);
  await loadPlugins({ pluginPaths: dir, registry, logger: silent });
  assert.deepEqual(registry.listRestartRequired(), [ 'FrameRuntime' ], 'stale while the override is on top');

  await unloadPlugin(registry, 'contract-probe', { logger: silent });

  // The instance was built from core's FrameRuntime and the stack is back to core's
  // FrameRuntime, so the staleness was only ever the override window and it has healed.
  // Without this the flag would latch and become noise operators learn to ignore.
  assert.deepEqual(registry.listRestartRequired(), [], 'matching the instance again must clear the report');
});
