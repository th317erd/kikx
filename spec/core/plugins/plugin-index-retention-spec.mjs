'use strict';

// =============================================================================
// P6 exit proof: "Unload follows the declared retention policy."
// =============================================================================
// `docs/plans/plugin-platform-campaign.md` §4.5 says a plugin index and its
// migrations are "removed or tombstoned on unload according to an explicit
// retention policy; data is not silently deleted", and names the knob:
//
//     removeOnUnload: 'definition-only' | 'retain-data'   (default: definition-only)
//
// Owner ruling D8.4 ratifies the behaviour: "remove definitions, routes, indexes
// and migration registrations by default; retain durable plugin data unless an
// explicit purge is requested."
//
// Measured before this change: `removeOnUnload` appeared in the campaign document
// and NOWHERE in `src/`. There was no policy, no default, and the field was never
// read - so a plugin that declared `removeOnUnload: 'retain-data'` was silently
// given the opposite behaviour. Unload removed EVERY frame-index declaration
// unconditionally: 'definition-only' for all plugins, with the policy ignored.
// Both directions were therefore broken at once - the documented default was
// neither reported nor enforced, and the documented override did not exist.
//
// Revert-measured: with the registry reverted to the parent commit, 4 of these 7
// fail - the two 'retain-data' assertions (the override was ignored) plus the
// resolved-default and fail-closed assertions (no policy existed). The 3 that pass
// are the unconditional-removal cases and the no-data-deletion case, and they pass
// for the right reason: the old code happened to remove everything and to delete
// nothing.
//
// The plugin is loaded from a temp directory through the real `loadPlugins`, and
// declares its index through the same `ctx.registerFrameIndex` the loader injects
// into a real plugin, so this exercises the production path.
//
// What is pinned here:
//   1. an undeclared policy resolves to 'definition-only', reported on the
//      descriptor rather than assumed;
//   2. a mistyped policy fails closed at registration - a typo must never be read
//      as "delete my data";
//   3. unload under 'definition-only' removes the declaration from the live set AND
//      from the config that is written to the driver;
//   4. unload under 'retain-data' keeps the declaration live, so a reinstall finds
//      its index still declared;
//   5. NEITHER policy deletes durable plugin data.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AeorDBConnection } from '../../../src/core/aeordb/aeordb-connection.mjs';
import { buildSessionIndexConfigs } from '../../../src/core/aeordb/frame-store-indexes.mjs';
import { loadPlugins, unloadPlugin } from '../../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../../src/core/plugins/plugin-registry.mjs';
import { FakeAeorDBClient } from '../database/fake-aeordb-client.mjs';

const PLUGIN = 'probe-retention';
const INDEX = 'focus_todo_id';
const ROOT = '/aeordb';

function quietLogger() {
  return { log() {}, warn() {}, error() {}, info() {}, debug() {} };
}

// A connection whose `delete` is counted, so "data is not silently deleted" is an
// assertion about calls that were attempted, not an inference from what survived.
function trackedConnection(client) {
  let connection = new AeorDBConnection({ client, logger: quietLogger() });
  let deletes = [];
  let realDelete = connection.delete.bind(connection);
  connection.delete = async (...args) => {
    deletes.push(args[0]);
    return realDelete(...args);
  };
  return { connection, deletes };
}

// A plugin on disk that declares the index through the loader-injected context.
async function writePlugin(root, policy) {
  let dir = path.join(root, PLUGIN);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  let policyField = policy === undefined ? '' : `removeOnUnload: ${JSON.stringify(policy)},`;
  let source = [
    "'use strict';",
    `export const pluginName = ${JSON.stringify(PLUGIN)};`,
    'export function setup(provide) {',
    '  provide((ctx) => {',
    `    ctx.registerFrameIndex(${JSON.stringify(INDEX)}, {`,
    "      type: 'string',",
    "      source: [ 'content', 'focus_todo_id' ],",
    "      drivers: [ 'aeordb', 'postgresql', 'sqlite' ],",
    `      ${policyField}`,
    '    });',
    '  });',
    '}',
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'index.mjs'), source);
  return dir;
}

async function withLoadedPlugin(policy, run) {
  let client = new FakeAeorDBClient({
    documents: {
      // Durable plugin data that must outlive unload.
      [`${ROOT}/sessions/s1/interactions/frames/f1.json`]: { id: 'f1', focus_todo_id: 'todo-1' },
    },
  });
  let { connection, deletes } = trackedConnection(client);
  let registry = new PluginRegistry({ logger: quietLogger() });

  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-retention-'));
  let dir = await writePlugin(root, policy);
  await loadPlugins({ pluginPaths: dir, registry, logger: quietLogger() });

  try {
    let descriptor = registry.getFrameIndexes().find((index) => index.name === INDEX);
    assert.ok(descriptor, 'precondition: the plugin declared its index through ctx.registerFrameIndex');
    return await run({ registry, connection, deletes, descriptor, client });
  } finally {
    await connection.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// The config builder returns [{ path, body: { indexes } }]; flatten for assertions.
function indexesOf(configs) {
  return (configs || []).flatMap((config) => config?.body?.indexes || []);
}

test('an undeclared retention policy resolves to definition-only', async () => {
  await withLoadedPlugin(undefined, async ({ descriptor }) => {
    assert.equal(
      descriptor.removeOnUnload,
      'definition-only',
      'the documented default must be attached to the descriptor, not left undefined',
    );
  });
});

test('a mistyped retention policy fails closed at registration', () => {
  let registry = new PluginRegistry({ logger: quietLogger() });
  assert.throws(
    () => registry.registerFrameIndex(INDEX, { type: 'string', removeOnUnload: 'retain' }),
    /removeOnUnload/i,
    'an unrecognised policy must be refused, never treated as a permissive default',
  );
  assert.throws(
    () => registry.registerFrameIndex(INDEX, { type: 'string', removeOnUnload: 'delete-everything' }),
    /removeOnUnload/i,
  );
});

test('definition-only unload removes the declaration from the live set', async () => {
  await withLoadedPlugin('definition-only', async ({ registry }) => {
    assert.equal(registry.getFrameIndexes().length, 1, 'precondition: the index is declared');

    await unloadPlugin(registry, PLUGIN, { logger: quietLogger() });

    assert.deepEqual(
      registry.getFrameIndexes(),
      [],
      'the default policy removes the definition, so nothing may be left declared',
    );
  });
});

test('definition-only unload removes the index from the config written to the driver', async () => {
  await withLoadedPlugin('definition-only', async ({ registry }) => {
    let before = buildSessionIndexConfigs(ROOT, 's1', registry.getFrameIndexes());
    assert.ok(
      indexesOf(before).some((index) => index.name === INDEX),
      'precondition: the plugin index is in the persisted session config',
    );

    await unloadPlugin(registry, PLUGIN, { logger: quietLogger() });

    let after = buildSessionIndexConfigs(ROOT, 's1', registry.getFrameIndexes());
    assert.ok(
      !indexesOf(after).some((index) => index.name === INDEX),
      'after unload the config the driver receives must no longer declare the index',
    );
  });
});

test('retain-data unload keeps the declaration so a reinstall finds it', async () => {
  await withLoadedPlugin('retain-data', async ({ registry }) => {
    await unloadPlugin(registry, PLUGIN, { logger: quietLogger() });

    assert.deepEqual(
      registry.getFrameIndexes().map((index) => index.name),
      [ INDEX ],
      'retain-data means the declaration outlives the unload',
    );
  });
});

test('retain-data unload keeps the index in the config written to the driver', async () => {
  await withLoadedPlugin('retain-data', async ({ registry }) => {
    await unloadPlugin(registry, PLUGIN, { logger: quietLogger() });

    let after = buildSessionIndexConfigs(ROOT, 's1', registry.getFrameIndexes());
    assert.ok(
      indexesOf(after).some((index) => index.name === INDEX),
      'a retained declaration must still reach the driver config',
    );
  });
});

test('neither policy deletes durable plugin data on unload', async () => {
  for (let policy of [ 'definition-only', 'retain-data' ]) {
    await withLoadedPlugin(policy, async ({ registry, connection, deletes, client }) => {
      assert.ok(connection, 'precondition: a live connection is under test');

      await unloadPlugin(registry, PLUGIN, { logger: quietLogger() });

      assert.deepEqual(
        deletes,
        [],
        `"${policy}" unload must not delete anything; data removal needs an explicit purge`,
      );
      assert.deepEqual(
        await client.getFile(`${ROOT}/sessions/s1/interactions/frames/f1.json`),
        { id: 'f1', focus_todo_id: 'todo-1' },
        `"${policy}" unload must leave the plugin's durable documents intact`,
      );
    });
  }
});
