'use strict';

// The first plugin-owned service.
//
// P2's exit proof requires "Plugin unload removes service and subscriptions" and the
// campaign's remaining-work list requires "migrating Questions or Todo into the first
// plugin-owned service". `todo-focus-index` is that service.
//
// These tests drive the REAL lifecycle - loadPlugins() -> initializePluginServices() ->
// unloadPlugin() - against the real PluginRegistry, because the point of the migration is
// that the registry owns the index's lifetime. A fake registry would prove nothing about
// that ownership.
//
// The two failing-first cases pin the bug the migration actually fixes: the index promise
// used to live in module scope, so it outlived every reload and cached the first load's
// failure forever behind `.catch(() => {})`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlugins, unloadPlugin } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/plugin-registry.mjs';

// The loader names a plugin after its directory; the plugin's own static pluginID is
// 'internal:todo-focus-index'. Registrations made through the loader's setup context are
// owned by the LOADER name, which is what releasePlugin/unloadPlugin take.
const PLUGIN_ID = 'internal:todo-focus-index';
const PLUGIN_NAME = 'todo-focus-index';
const SERVICE_NAME = 'todoFocusIndex';
const INDEX_NAME = 'focus_todo_id';

function quietLogger() {
  let lines = [];
  let record = (level) => (...args) => lines.push({ level, text: args.join(' ') });
  return { lines, log: record('log'), info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
}

// A database stand-in that counts index creation attempts, so "a reload indexes again"
// is observable rather than assumed.
function countingDatabase({ failTimes = 0 } = {}) {
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    async ensureScalarIndex(name) {
      attempts += 1;
      assert.equal(name, INDEX_NAME);
      if (attempts <= failTimes)
        throw new Error(`transient index failure #${attempts}`);
      return { name, created: true };
    },
  };
}

async function boot({ db } = {}) {
  let logger = quietLogger();
  let registry = new PluginRegistry({ logger });
  let context = new Map();
  if (db)
    context.set('aeordb', db);

  let loaded = await loadPlugins({
    pluginPaths: 'plugins/todo-focus-index',
    registry,
    logger,
    context,
  });
  assert.deepEqual(registry._pluginLoadErrors || [], [], 'the plugin must load without failures');
  assert.deepEqual(loaded.map((entry) => entry.pluginName), [ PLUGIN_NAME ],
    `expected one loaded plugin named ${PLUGIN_NAME}, got ${JSON.stringify(loaded)}`);

  // create-server.mjs runs this after loadPlugins() returns; service factories must not
  // run earlier, because they may depend on core services built in between.
  await registry.initializePluginServices(context);

  return { registry, context, logger };
}

test('the focus index is a plugin-owned service the registry can enumerate', async () => {
  let { registry } = await boot({ db: countingDatabase() });

  let services = registry.listPluginServices();
  let entry = services.find((service) => service.name === SERVICE_NAME);
  assert.ok(entry, `expected a "${SERVICE_NAME}" service, got ${JSON.stringify(services)}`);
  assert.equal(entry.pluginName, PLUGIN_NAME, 'the service must be attributed to the plugin, or unload cannot release it');

  // It must NOT declare the database as a hard dependency: a missing database was always
  // tolerated (the index is advisory), and dependsOn would turn that into a fatal
  // initializePluginServices() error at boot.
  assert.deepEqual(entry.dependsOn, []);
});

test('a reload re-creates the index instead of inheriting a stale promise', async () => {
  let db = countingDatabase();
  let { registry, context } = await boot({ db });

  let service = context.get(SERVICE_NAME);
  assert.ok(service, 'the factory must put the service in the context');
  assert.equal(typeof service.ensure, 'function');

  await service.ensure();
  assert.equal(db.attempts, 1);
  await service.ensure();
  assert.equal(db.attempts, 1, 'one load indexes once - the promise is memoized per instance');

  // Unload, then load again. A fresh service must exist, and it must index again.
  let unloaded = await unloadPlugin(registry, PLUGIN_NAME);
  assert.equal(unloaded, true);

  let second = await loadPlugins({
    pluginPaths: 'plugins/todo-focus-index',
    registry,
    logger: quietLogger(),
    context,
  });
  assert.deepEqual(registry._pluginLoadErrors || [], []);
  assert.equal(second.length, 1);
  await registry.initializePluginServices(context);

  let reloaded = context.get(SERVICE_NAME);
  assert.ok(reloaded, 'a reload must provide a service instance');
  assert.notEqual(reloaded, service, 'the reload must build a fresh instance, not reuse the old one');
  assert.equal(reloaded.promise, null, 'the fresh instance starts with no memoized promise');

  await reloaded.ensure();
  assert.equal(db.attempts, 2, 'the reload indexes again; a module-scope promise would swallow this');
});

test('a failed index creation stays retryable and visible, and never blocks stamping', async () => {
  let db = countingDatabase({ failTimes: 1 });
  let { registry, context } = await boot({ db });

  let service = context.get(SERVICE_NAME);
  await service.ensure();

  assert.equal(db.attempts, 1);
  assert.equal(typeof service.error, 'string', 'a failure must be reported on .error, not silently swallowed');
  assert.match(service.error, /transient index failure/);
  assert.equal(service.promise, null, 'a failed attempt must not be cached as the result');

  // Second attempt succeeds: one bad moment at startup must not disable the index for the
  // whole process, which is what `.catch(() => {})` used to do.
  await service.ensure();
  assert.equal(db.attempts, 2, 'a failed attempt must not poison the service');
  assert.equal(service.error, null, 'a later success clears the reported error');

  // The registry still owns it after the failure.
  assert.equal(registry.listPluginServices().some((s) => s.name === SERVICE_NAME), true);
});

test('unload releases the service and removes the index registration', async () => {
  let { registry, context } = await boot({ db: countingDatabase() });
  assert.ok(context.get(SERVICE_NAME));

  let removed = await unloadPlugin(registry, PLUGIN_NAME);
  assert.equal(removed, true);

  assert.equal(registry.listPluginServices().some((s) => s.name === SERVICE_NAME), false,
    'the service registration must be gone');
  assert.equal(context.has(SERVICE_NAME), false,
    'the service instance must be removed from the context, not left behind');
  assert.equal(registry.getFrameIndexes().some((index) => index.name === INDEX_NAME), false,
    'the focus index registration must be removed');
});
