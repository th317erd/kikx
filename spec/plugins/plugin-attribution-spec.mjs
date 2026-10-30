'use strict';

// Contract test for plugin attribution in the setup context.
//
// _recordOwnership() keys unloadPlugin() on the plugin name. A registration that
// arrives without one is registered but never owned: unloadPlugin() cannot undo it,
// so it outlives the plugin and stays reachable, and a reload stacks a second copy.
//
// The registrations in this context do not share one argument shape. Most take
// options third (name, X, options); registerComponent takes them fourth
// (kind, key, descriptor, options). A helper that always writes slot 2 is correct
// for the first shape and wrong for the second, where slot 2 is the descriptor and
// slot 3 is the options object that carries the plugin name. On that shape the
// plugin name lands in the descriptor instead of the options, so nothing is owned.
//
// Measured before the fix: loading this plugin left listOwnedRegistrations() with
// only "plugin-path", while all three descriptors were registered. After the fix:
// frame-component, tool-component and frame-index are all owned.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlugins, unloadPlugin } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { PluginRouter } from '../../src/core/plugins/plugin-router.mjs';
import { PluginEventBus } from '../../src/core/plugins/plugin-events.mjs';

const silent = { warn() {}, info() {}, error() {} };

const PLUGIN = 'attribution-probe';
const MODULE_URL = '/plugins/attribution-probe/client.js';

// Written to disk and loaded through the real loader rather than stubbed, so the
// test exercises the same context construction the server uses.
async function writePlugin(root) {
  let dir = path.join(root, PLUGIN);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(PLUGIN)};
    export function setup(provide) {
      provide((ctx) => {
        // Fourth slot: registerComponent(kind, key, descriptor, options).
        ctx.registerComponent('frame', 'attribution-frame', {
          tagName: 'attribution-frame-el',
          moduleURL: ${JSON.stringify(MODULE_URL)},
          label: 'Attribution Frame',
        }, { origin: 'probe' });

        // Third slot: registerToolComponent(name, descriptor, options).
        ctx.registerToolComponent('attribution-tool', {
          tagName: 'attribution-tool-el',
          moduleURL: ${JSON.stringify(MODULE_URL)},
        }, { origin: 'probe' });

        // Third slot: registerFrameIndex(name, definition, options).
        ctx.registerFrameIndex('attribution-index', { type: 'probe', fields: [ 'id' ] }, { origin: 'probe' });
      });
    }
  `);
  return dir;
}

function makeRegistry() {
  let registry = new PluginRegistry({ logger: silent });
  registry.setPluginRouter(new PluginRouter({ logger: silent }));
  registry.setPluginEventBus(new PluginEventBus({ logger: silent }));
  return registry;
}

async function loaded() {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-attribution-'));
  let registry = makeRegistry();
  await writePlugin(root);
  await loadPlugins({ pluginPaths: path.join(root, PLUGIN), registry, logger: silent });
  return registry;
}

test('every registration the plugin makes is owned by it', async () => {
  let registry = await loaded();

  let owned = registry.listOwnedRegistrations(PLUGIN).map((e) => `${e.kind}:${e.key}`).sort();
  assert.deepEqual(owned, [
    'frame-component:attribution-frame',
    'frame-index:attribution-index',
    `plugin-path:${PLUGIN}`,
    'tool-component:attribution-tool',
  ], 'each registration must be attributed to the loading plugin, or unload cannot undo it');
});

test('registerComponent keeps its descriptor rather than overwriting it with options', async () => {
  let registry = await loaded();

  let entry = registry._frameComponents.get('attribution-frame');
  assert.ok(entry, 'the frame component must be registered');
  assert.equal(entry.tagName, 'attribution-frame-el', 'the descriptor must reach the normalizer intact');
  assert.equal(entry.moduleURL, MODULE_URL, 'descriptor fields must survive registration');
  assert.equal(entry.label, 'Attribution Frame', 'descriptor fields must survive registration');
});

test('registerToolComponent and registerFrameIndex keep their descriptors', async () => {
  let registry = await loaded();

  let tool = registry._toolComponents.get('attribution-tool');
  assert.ok(tool, 'the tool component must be registered');
  assert.equal(tool.tagName, 'attribution-tool-el', 'the descriptor must reach the normalizer intact');

  let index = registry._frameIndexes.get('attribution-index');
  assert.ok(index, 'the frame index must be registered');
  assert.equal(index.type, 'probe', 'the definition must survive registration');
  assert.deepEqual(index.fields, [ 'id' ], 'definition fields must survive registration');
});

test('unloadPlugin removes every component the plugin registered', async () => {
  let registry = await loaded();

  assert.ok(registry._frameComponents.has('attribution-frame'), 'present while loaded');
  assert.ok(registry._toolComponents.has('attribution-tool'), 'present while loaded');
  assert.ok(registry._frameIndexes.has('attribution-index'), 'present while loaded');

  await unloadPlugin(registry, PLUGIN, { logger: silent });

  assert.equal(registry._frameComponents.has('attribution-frame'), false,
    'an unattributed frame component survives unload and stays reachable');
  assert.equal(registry._toolComponents.has('attribution-tool'), false,
    'an unattributed tool component survives unload and stays reachable');
  assert.equal(registry._frameIndexes.has('attribution-index'), false,
    'an unattributed frame index survives unload and stays reachable');
});
