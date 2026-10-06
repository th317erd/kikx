'use strict';

// createServer database wiring: the built-in AeorDB driver is resolved after
// plugins load, `db` is the canonical service, and `aeordb` remains the alias
// existing stores read. Host embeddings that inject a ready client are aliased
// rather than replaced.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { AeorDBConnection } from '../../src/core/aeordb/aeordb-connection.mjs';
import { DatabaseConnectionBase } from '../../src/core/database/database-connection-base.mjs';
import { resolveDatabaseDriver } from '../../src/core/database/index.mjs';
import { registerCoreClasses } from '../../src/core/plugins/core-classes.mjs';
import { loadPlugins } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import { createServer } from '../../src/server/create-server.mjs';

delete process.env.KIKX_PLUGIN_PATHS;

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => error ? reject(error) : resolve());
  });
}

function stubFetch() {
  return {
    ok: true,
    status: 200,
    async text() {
      return '{}';
    },
  };
}

test('createServer aliases an injected legacy aeordb to db', async () => {
  let legacy = { eventsURL: () => 'unused' };
  let server = await createServer({
    context: new AppContext({
      aeordb: legacy,
      pluginLoadPromise: Promise.resolve(),
    }),
  });

  try {
    let context = server.kikxContext;
    assert.equal(context.get('aeordb'), legacy);
    assert.equal(context.get('db'), legacy);
    assert.equal(context.has('databaseDriverID'), false);
  } finally {
    await close(server);
  }
});

test('createServer selects the built-in aeordb driver by default', async () => {
  let context = new AppContext({
    pluginLoadPromise: Promise.resolve(),
  });
  let server = await createServer({ context, fetchImpl: stubFetch });

  try {
    let db = context.get('db');
    assert.ok(db instanceof AeorDBConnection, 'db must be the built-in AeorDB driver');
    assert.equal(context.get('aeordb'), db);
    assert.equal(context.get('databaseDriverID'), 'aeordb');

    // The frame store built by createServer is wired to the canonical driver.
    let frameRuntime = context.require('frameRuntime');
    assert.equal(frameRuntime.frameStore.aeordb, db);
    assert.equal(frameRuntime.frameStore.db, db);
  } finally {
    await close(server);
  }
});

test('registerCoreClasses + resolveDatabaseDriver selects the built-in aeordb driver', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(registry);

  let resolved = resolveDatabaseDriver(registry, undefined);
  assert.equal(resolved.driverID, 'aeordb');
  assert.equal(resolved.DriverClass, AeorDBConnection);
});

test('loadPlugins exposes registerDatabaseDriver to plugin setup', async () => {
  let tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-db-plugin-'));
  let moduleURL = new URL('../../src/core/database/database-connection-base.mjs', import.meta.url).href;
  let pluginPath = path.join(tmp, 'fake-database-plugin.mjs');

  await fs.writeFile(pluginPath, [
    `import { DatabaseConnectionBase } from '${moduleURL}';`,
    'export async function setup(provide) {',
    '  provide(({ registerDatabaseDriver }) => {',
    '    class FakeDriver extends DatabaseConnectionBase {',
    "      static driverID = 'fake';",
    '    }',
    "    registerDatabaseDriver('fake', FakeDriver);",
    '  });',
    '}',
    '',
  ].join('\n'));

  try {
    let registry = new PluginRegistry({ logger: { warn() {} } });
    await loadPlugins({ pluginPaths: pluginPath, registry });

    let driver = registry.getDatabaseDriver('fake');
    assert.equal(typeof driver, 'function');
    assert.ok(driver.prototype instanceof DatabaseConnectionBase);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
