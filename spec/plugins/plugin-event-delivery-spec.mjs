'use strict';

// Scoped runtime event delivery to plugins — the contract docs/reference/plugins.md states
// in one sentence: "subscribe() receives scoped runtime events for the sessions named in
// the subscription; naming none receives nothing. These resources are closed and
// unsubscribed on unload."
//
// Why this file exists
// --------------------
// The campaign plan names "event delivery" as an unmet contract gap twice (§5 and the
// closing paragraph), but nothing in the suite drove PluginEventBus through the loader:
// the only coverage was incidental, inside the attribution and unload specs, which assert
// that subscriptions are *recorded* and *dropped*, never that an event is *delivered*.
//
// The defect this found is a reload, and it is the mirror image of the P6 retention bug:
// a documented promise that the code did the opposite of. loadPlugins() re-runs setup()
// for every plugin on the configured path with no already-loaded check, and the
// duplicate-name refusal happens *after* setup. So on POST /api/v1/plugins/reload the
// plugin subscribes again, and then rollbackPartialLoad() calls unsubscribe(pluginName),
// which deletes the whole per-plugin key — including the subscription the *live* plugin
// registered at boot. A reload therefore leaves a running plugin permanently deaf, while
// the inventory still reports it loaded. Nothing throws, nothing logs a warning, and the
// plugin's own teardown never runs on that path either.
//
// Measured against the pre-fix loader: the reload test gets 0 deliveries where it wants 1,
// and the unload-baseline test still passes, which is what proves the two paths differ.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlugins, unloadPlugin } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { PluginRouter } from '../../src/core/plugins/plugin-router.mjs';
import { PluginEventBus } from '../../src/core/plugins/plugin-events.mjs';
import { PluginMigrations } from '../../src/core/plugins/plugin-migrations.mjs';

const silent = { warn() {}, info() {}, error() {} };

// The bus attaches to a real EventEmitter because that is the shape FrameRuntime offers
// (on/emit). A hand-rolled stub would let a broken `#listen` pass: the assertion has to
// be that an emit on the runtime reaches the handler, not that the bus called a function
// the test itself supplied.
function makeHarness() {
  let registry = new PluginRegistry({ logger: silent });
  let router = new PluginRouter({ logger: silent });
  let bus = new PluginEventBus({ logger: silent });
  let migrations = new PluginMigrations({ logger: silent });
  registry.setPluginRouter(router);
  registry.setPluginEventBus(bus);
  registry.setPluginMigrations(migrations);
  return { registry, router, bus, migrations };
}

function resetProbe() {
  globalThis.__kikxEventProbe = [];
  globalThis.__kikxTeardownProbe = 0;
}

function teardowns() {
  return globalThis.__kikxTeardownProbe || 0;
}

function deliveries() {
  return globalThis.__kikxEventProbe || [];
}

// The plugin subscribes through ctx.subscribe, which is the documented surface — not
// registry._pluginEventBus directly, so this exercises the loader's keying by pluginName.
function subscriberSource(name, sessions) {
  return `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide((ctx) => {
        ctx.subscribe((event) => {
          (globalThis.__kikxEventProbe = globalThis.__kikxEventProbe || []).push(
            event.type + ':' + (event.sessionID || 'none'),
          );
        }, ${sessions === null ? '{}' : `{ sessions: ${JSON.stringify(sessions)} }`});
      });
      return () => { globalThis.__kikxTeardownProbe = (globalThis.__kikxTeardownProbe || 0) + 1; };
    }
  `;
}

async function writePlugin(root, { dir = 'probe', name, sessions = [ 'session-a' ] }) {
  let full = path.join(root, dir);
  await fs.mkdir(full, { recursive: true });
  await fs.writeFile(path.join(full, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(full, 'index.mjs'), subscriberSource(name, sessions));
  return full;
}

test('a scoped subscription receives events for a named session and nothing else', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-events-'));
  let harness = makeHarness();
  let runtime = new EventEmitter();
  harness.bus.attach(runtime);
  resetProbe();

  let dir = await writePlugin(root, { name: 'events-probe', sessions: [ 'session-a' ] });
  await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });

  runtime.emit('event', { type: 'commit', sessionID: 'session-a' });
  runtime.emit('event', { type: 'commit', sessionID: 'session-b' });

  // Exactly one: the second event names a session the plugin did not ask for. Scoping is
  // a confidentiality boundary, so a delivered 'session-b' is a failure, not a nuisance.
  assert.deepEqual(deliveries(), [ 'commit:session-a' ]);
});

test('an unscoped subscription receives nothing, even for its own session', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-events-'));
  let harness = makeHarness();
  let runtime = new EventEmitter();
  harness.bus.attach(runtime);
  resetProbe();

  let dir = await writePlugin(root, { dir: 'unscoped', name: 'unscoped-probe', sessions: null });
  await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });

  runtime.emit('event', { type: 'commit', sessionID: 'session-a' });

  // Deny by default, never granted by omission.
  assert.deepEqual(deliveries(), []);
});

test('a reload of the same directory delivers each event exactly once', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-events-'));
  let harness = makeHarness();
  let runtime = new EventEmitter();
  harness.bus.attach(runtime);
  resetProbe();

  let dir = await writePlugin(root, { name: 'reload-probe', sessions: [ 'session-a' ] });
  await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });
  runtime.emit('event', { type: 'commit', sessionID: 'session-a' });
  assert.equal(deliveries().length, 1, 'the boot load delivers exactly one event');
  assert.equal(teardowns(), 0, 'no teardown has run yet: nothing was reloaded or unloaded');

  // POST /api/v1/plugins/reload: the same paths are scanned again. registerPluginRecord
  // only refuses a name when a DIFFERENT directory claims it, so reloading the same
  // directory is not a refusal - setup() runs a second time and the record is replaced.
  let again = await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });
  assert.deepEqual(again.map((l) => l.pluginName), [ 'reload-probe' ]);

  runtime.emit('event', { type: 'commit', sessionID: 'session-a' });

  // The decisive assertion. One reload, one delivery. A plugin that fires twice after one
  // reload - and N times after N reloads - is the bug this file exists to prevent, and it
  // is invisible without counting: the handler runs, so nothing looks broken.
  assert.equal(deliveries().length, 2, 'one reload must not duplicate delivery');

  // The replaced registration's teardown must actually run. Replacing the record used to
  // discard the only reference to it, so the resources the first load acquired were never
  // released - a leak with no unload path, because the record is keyed by name. Counting
  // the invocation is the assertion that matters; checking that a function still exists on
  // the new record would pass even while the old one leaked.
  assert.equal(teardowns(), 1, 'a reload runs the superseded registration teardown exactly once');
});

test('unload stops delivery', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-events-'));
  let harness = makeHarness();
  let runtime = new EventEmitter();
  harness.bus.attach(runtime);
  resetProbe();

  let dir = await writePlugin(root, { dir: 'unload', name: 'unload-probe', sessions: [ 'session-a' ] });
  await loadPlugins({ pluginPaths: dir, registry: harness.registry, logger: silent });
  runtime.emit('event', { type: 'commit', sessionID: 'session-a' });
  assert.equal(deliveries().length, 1);

  assert.equal(await unloadPlugin(harness.registry, 'unload-probe', { logger: silent }), true);
  runtime.emit('event', { type: 'commit', sessionID: 'session-a' });

  // "These resources are closed and unsubscribed on unload."
  assert.equal(deliveries().length, 1, 'an unloaded plugin receives nothing further');
  assert.deepEqual(harness.bus.list(), [], 'the bus holds no subscription for a gone plugin');
});

test('one plugin cannot hear another plugin\'s session', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-events-'));
  let harness = makeHarness();
  let runtime = new EventEmitter();
  harness.bus.attach(runtime);
  resetProbe();

  let first = await writePlugin(root, { dir: 'one', name: 'probe-one', sessions: [ 'session-a' ] });
  let second = await writePlugin(root, { dir: 'two', name: 'probe-two', sessions: [ 'session-b' ] });
  await loadPlugins({
    pluginPaths: [ first, second ].join(path.delimiter),
    registry: harness.registry,
    logger: silent,
  });

  runtime.emit('event', { type: 'commit', sessionID: 'session-a' });
  runtime.emit('event', { type: 'commit', sessionID: 'session-b' });

  // Two deliveries total, one each — never two to the same handler.
  assert.deepEqual(deliveries(), [ 'commit:session-a', 'commit:session-b' ]);
  let listed = harness.bus.list().map((s) => s.pluginId).sort();
  assert.deepEqual(listed, [ 'probe-one', 'probe-two' ]);
});

test('a throwing handler is isolated and does not stop other plugins', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-events-'));
  let harness = makeHarness();
  let runtime = new EventEmitter();
  harness.bus.attach(runtime);
  resetProbe();

  // One plugin throws synchronously, one rejects, and one behaves. Every handler is on the
  // same session so all three are candidates for the same event.
  let bad = path.join(root, 'bad');
  await fs.mkdir(bad, { recursive: true });
  await fs.writeFile(path.join(bad, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(bad, 'index.mjs'), `
    export const pluginName = 'throws-probe';
    export function setup(provide) {
      provide((ctx) => {
        ctx.subscribe(() => { throw new Error('synchronous boom'); }, { sessions: [ 'session-a' ] });
      });
    }
  `);

  let rejecting = path.join(root, 'rejecting');
  await fs.mkdir(rejecting, { recursive: true });
  await fs.writeFile(path.join(rejecting, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(rejecting, 'index.mjs'), `
    export const pluginName = 'rejects-probe';
    export function setup(provide) {
      provide((ctx) => {
        ctx.subscribe(async () => { throw new Error('async boom'); }, { sessions: [ 'session-a' ] });
      });
    }
  `);

  let good = await writePlugin(root, { dir: 'good', name: 'good-probe', sessions: [ 'session-a' ] });
  await loadPlugins({
    pluginPaths: [ bad, rejecting, good ].join(path.delimiter),
    registry: harness.registry,
    logger: silent,
  });

  runtime.emit('event', { type: 'commit', sessionID: 'session-a' });

  // The well-behaved plugin is still served. A plugin's failure is its own; it must not
  // become another plugin's outage.
  assert.deepEqual(deliveries(), [ 'commit:session-a' ]);
});
