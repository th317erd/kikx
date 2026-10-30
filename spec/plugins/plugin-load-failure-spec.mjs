'use strict';

// A plugin load that fails part-way through must not leave anything behind.
//
// Why this file exists
// --------------------
// The campaign plan (§4.7 lifecycle contract) requires that "a setup timeout marks the
// plugin failed and rolls back partial registrations", and §6 lists "failed setup" and
// "failed migration" among the tests P0's exit proof needs.
//
// Before this, loadPlugins() caught the throw, unwound the ambient load scope, and
// recorded a load error. It never released what the plugin had already registered, and
// it could not: the record is only stored in _pluginRegistrations *after* setup
// succeeds, so a failed plugin is invisible to unloadPlugin() forever. Measured on the
// old code, a plugin that registered a tool and then threw in setup() left that tool
// live, owned by nobody, with no teardown path. A mount would still have served
// requests and a migration would still have claimed its directory.
//
// The assertions deliberately check the registry's collection state rather than whether
// a warning was logged. A rollback that logs "rolled back" and leaves the tool live
// would pass a weaker test.
//
// Two bugs in this file's own first draft, recorded so the shape is not repeated:
//   - it overrode 'FrameRouter', which a bare PluginRegistry has not registered (only
//     registerCoreClasses does), so the plugin threw on that line and the test proved
//     nothing about rollback breadth. It now uses 'PluginInterface', which the loader
//     registers unconditionally.
//   - it asserted the duplicate-name message matched /already registered as/, while the
//     loader used to overwrite that non-disclosing message with its own. The product was
//     wrong there and is fixed; the assertion stays because "locations only, no absolute
//     paths" is the contract that message exists to satisfy.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlugins } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { PluginRouter } from '../../src/core/plugins/plugin-router.mjs';
import { PluginEventBus } from '../../src/core/plugins/plugin-events.mjs';
import { PluginMigrations } from '../../src/core/plugins/plugin-migrations.mjs';

const silent = { warn() {}, info() {}, error() {} };

function makeRegistry() {
  let registry = new PluginRegistry({ logger: silent });
  let router = new PluginRouter({ logger: silent });
  let bus = new PluginEventBus({ logger: silent });
  let migrations = new PluginMigrations({ logger: silent });
  registry.setPluginRouter(router);
  registry.setPluginEventBus(bus);
  registry.setPluginMigrations(migrations);
  return { registry, router, bus, migrations };
}

// Registers one thing in every collection the loader can attribute, then throws. The
// point is breadth: a rollback that handles tools but not mounts would still pass a
// tool-only test. Every registration here is one the loader genuinely supports on a bare
// PluginRegistry.
function failingRegistrations(name) {
  return `
        const { registry } = ctx;
        const AgentInterface = registry.getClass('AgentInterface');
        const PluginInterface = registry.getClass('PluginInterface');

        // The class override goes through the ambient load scope on purpose: the plugin
        // calls registry.registerClass() directly, not ctx.registerClass(), which is what
        // the in-repo plugins do. That path has to be attributed too or the override
        // survives the unload.
        class ProbeOverride extends PluginInterface {}
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
        registry.registerClass('PluginInterface', ProbeOverride);
        ctx.registerFrameIndex(${JSON.stringify(name + '-index')}, { type: 'probe' });
        ctx.registerTagDefinition(${JSON.stringify(name + '-tag')}, { description: 'probe tag' });
        ctx.mountHttp(async (_req, res) => { res.end('probe'); });
        ctx.registerMigrations({ directory: 'sql' });
        ctx.subscribe(() => {}, { sessions: [ 'probe-session' ] });`;
}

async function writeFailingPlugin(root, { name = 'failing-probe', throwIn = 'setup' } = {}) {
  let dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'sql'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(
    path.join(dir, 'sql', '001-probe.sql'),
    `CREATE TABLE IF NOT EXISTS ${name.replace(/-/g, '_')}_widget (id TEXT PRIMARY KEY);`,
  );

  let body = throwIn === 'setup'
    ? `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {${failingRegistrations(name)}
      });
      throw new Error('setup exploded after registering');
    }`
    : `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {${failingRegistrations(name)}
      });
      return { onInit() { throw new Error('onInit exploded after registering'); } };
    }`;

  await fs.writeFile(path.join(dir, 'index.mjs'), body);
  return dir;
}

async function writeHealthyPlugin(root, name = 'healthy-probe') {
  let dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        const PluginInterface = ctx.registry.getClass('PluginInterface');
        class HealthyTool extends PluginInterface { async run() { return 'ok'; } }
        ctx.registry.registerTool('healthy-tool', HealthyTool);
        ctx.mountHttp(async (_req, res) => { res.end('healthy'); });
      });
    }
  `);
  return dir;
}

// Everything the failing plugin touched, in one place so a partial rollback cannot hide
// behind a passing subset.
function assertNothingLeft({ registry, router, bus, migrations }, name) {
  assert.equal(
    registry.getClass('PluginInterface').name,
    'PluginInterface',
    'the class override must be popped back to the class below it',
  );
  assert.equal(registry.getTool(`${name}-tool`), null, 'a registered tool must be gone');
  assert.equal(registry.getAgentProvider(`${name}-agent`), null, 'a registered agent type must be gone');
  assert.equal(registry.getTagDefinition(`${name}-tag`), null, 'a registered tag must be gone');
  assert.equal(
    registry.getFrameIndexes().some((i) => i.name === `${name}-index`),
    false,
    'a registered frame index must be gone',
  );
  assert.deepEqual(router.listMounts().map((m) => m.pluginId), [], 'a registered mount must be gone');
  assert.deepEqual(bus.list().map((s) => s.pluginId), [], 'a registered subscription must be gone');
  assert.equal(migrations.plugins.has(name), false, 'a registered migration directory must be released');
  assert.deepEqual(registry.listOwnedRegistrations(name), [], 'the ownership ledger must not retain a failed load');
}

test('a setup that throws after registering leaves nothing behind', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-fail-'));
  let harness = makeRegistry();
  let dir = await writeFailingPlugin(root, { name: 'failing-probe' });

  let loaded = await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });

  assert.deepEqual(loaded, [], 'a failed plugin is not reported as loaded');
  assertNothingLeft(harness, 'failing-probe');

  // The failure is still reported. Rolling a plugin back must not make it look absent:
  // "not installed" and "installed and broken" have to stay distinguishable.
  assert.equal(harness.registry._pluginLoadErrors.length, 1);
  assert.match(harness.registry._pluginLoadErrors[0].message, /setup exploded after registering/);
  assert.equal(harness.registry._pluginRegistrations?.has('failing-probe') ?? false, false);
});

test('an onInit that throws after registering rolls back the same way', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-fail-'));
  let harness = makeRegistry();
  let dir = await writeFailingPlugin(root, { name: 'failing-init', throwIn: 'onInit' });

  let loaded = await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });

  assert.deepEqual(loaded, []);
  assertNothingLeft(harness, 'failing-init');
  assert.equal(harness.registry._pluginLoadErrors.length, 1);
  assert.match(harness.registry._pluginLoadErrors[0].message, /onInit exploded after registering/);
});

test('a failed load does not disturb a healthy plugin loaded before it', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-fail-'));
  let goodDir = await writeHealthyPlugin(root, 'healthy-probe');
  let badDir = await writeFailingPlugin(root, { name: 'failing-probe' });

  let harness = makeRegistry();
  let loaded = await loadPlugins({
    pluginPaths: [ goodDir, badDir ].join(path.delimiter),
    registry: harness.registry,
    logger: silent,
  });

  assert.deepEqual(loaded.map((l) => l.pluginName), [ 'healthy-probe' ], 'only the healthy plugin loads');

  // The healthy plugin keeps everything it registered.
  assert.ok(harness.registry.getTool('healthy-tool'), 'the healthy plugin keeps its tool');
  assert.deepEqual(harness.router.listMounts().map((m) => m.pluginId), [ 'healthy-probe' ]);
  assert.ok(harness.registry.getPluginPath('healthy-probe'), 'the healthy plugin keeps its path');
  assert.equal(harness.registry.getClass('PluginInterface').name, 'PluginInterface');
});

test('the failed plugin is absent, never half-present', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-fail-'));
  let harness = makeRegistry();
  let dir = await writeFailingPlugin(root, { name: 'failing-probe' });

  await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });

  // unloadPlugin() keys off _pluginRegistrations. A failed load must not appear there,
  // because an entry whose registrations were already released would be a second,
  // confusing teardown of resources that no longer exist.
  assert.equal(harness.registry._pluginRegistrations?.has('failing-probe') ?? false, false);
  assert.equal(harness.registry.getPluginPath('failing-probe'), null);

  // Retrying a plugin that is still broken reports one failure, not one per attempt.
  let retry = await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });
  assert.deepEqual(retry, [], 'still broken, still refused');
  assert.equal(harness.registry._pluginLoadErrors.length, 1, 'one failure entry per location, not one per attempt');
});

test('two plugins declaring the same name: the second is refused and the first survives intact', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-fail-'));

  // Two distinct directories, both claiming pluginName "duplicate-probe".
  for (let [ dir, tool ] of [ [ 'first-site', 'first-tool' ], [ 'second-site', 'second-tool' ] ]) {
    let full = path.join(root, dir);
    await fs.mkdir(full, { recursive: true });
    await fs.writeFile(path.join(full, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await fs.writeFile(path.join(full, 'index.mjs'), `
      export const pluginName = 'duplicate-probe';
      export function setup(provide) {
        provide((ctx) => {
          const PluginInterface = ctx.registry.getClass('PluginInterface');
          class DupTool extends PluginInterface { async run() { return 'ok'; } }
          ctx.registry.registerTool('${tool}', DupTool);
        });
      }
    `);
  }

  let harness = makeRegistry();
  let loaded = await loadPlugins({
    pluginPaths: [ path.join(root, 'first-site'), path.join(root, 'second-site') ].join(path.delimiter),
    registry: harness.registry,
    logger: silent,
  });

  assert.deepEqual(loaded.map((l) => l.pluginName), [ 'duplicate-probe' ], 'only the first load counts');

  // The decisive assertion: the refused load did not take the accepted one's tool with
  // it. A name collision must not be resolved by the newcomer cleaning up the ledger
  // entry the earlier load owns.
  assert.ok(harness.registry.getTool('first-tool'), 'the accepted plugin keeps its tool');
  assert.equal(harness.registry.getTool('second-tool'), null, 'the refused plugin registers nothing');

  let errors = harness.registry._pluginLoadErrors || [];
  assert.equal(errors.length, 1, 'the refusal is reported');
  assert.match(errors[0].message, /already registered as/, 'the refusal names the conflict');
  // Locations only: this message is served to a caller, so it must not leak an absolute
  // path from the operator's filesystem.
  assert.equal(errors[0].message.includes(root), false, 'the refusal must not disclose absolute paths');
});
