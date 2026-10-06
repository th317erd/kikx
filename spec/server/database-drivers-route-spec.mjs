'use strict';

// P6 route spec: GET /api/v1/database-drivers lists every registered driver's
// static descriptor and the driver this server selected. The descriptors are
// static, so observing all three built-ins must not require a live connection;
// the default AeorDB-backed boot (whose connect() does not ping) is enough. The
// PostgreSQL-specific assertion only runs when the private test cluster is up.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppContext } from '../../src/core/app/app-context.mjs';
import { createServer } from '../../src/server/create-server.mjs';
import { handleDatabaseRoutes } from '../../src/server/routes/database-routes.mjs';

// Isolate from ambient discovery/config so the assertions are deterministic.
delete process.env.KIKX_PLUGIN_PATHS;
delete process.env.ORG_AEOR_KIKX_DATABASE_DRIVER;
delete process.env.KIKX_DATABASE_DRIVER;
delete process.env.ORG_AEOR_KIKX_DATABASE_PATH;
delete process.env.KIKX_DATABASE_PATH;
delete process.env.ORG_AEOR_KIKX_DATABASE_URL;
delete process.env.KIKX_DATABASE_URL;

// `[::1]` avoids the owner's SSH tunnel that occupies 127.0.0.1:55432.
const PG_TEST_URL = process.env.KIKX_TEST_PG_URL || 'postgres://postgres@[::1]:55432/postgres';
const BUILT_IN_DRIVER_IDS = [ 'aeordb', 'postgresql', 'sqlite' ];

async function probePostgres() {
  try {
    let { Client } = await import('pg');
    let client = new Client({ connectionString: PG_TEST_URL, connectionTimeoutMillis: 2000 });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch (_error) {
    return false;
  }
}

let postgresAvailable = await probePostgres();

function stubFetch() {
  return {
    ok: true,
    status: 200,
    async text() {
      return '{}';
    },
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => error ? reject(error) : resolve());
  });
}

// Let startup recovery/worker promises settle before closing the driver so
// background work does not race the close.
async function settleAndClose(server, context) {
  try {
    await context.require?.('scheduledFrameWorkerPromise');
  } catch (_error) {
    // Recovery failures are already logged and non-fatal.
  }

  if (server)
    await close(server);

  await context.require('db')?.close?.();
}

function restoreEnv(key, value) {
  if (value === undefined)
    delete process.env[key];
  else
    process.env[key] = value;
}

test('GET /api/v1/database-drivers lists the three built-in drivers', async () => {
  let context = new AppContext({
    pluginLoadPromise: Promise.resolve(),
  });
  let server = await createServer({ context, fetchImpl: stubFetch });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/database-drivers`);
    let body = await response.json();

    assert.equal(response.status, 200);
    let drivers = body.data.drivers;
    assert.deepEqual(drivers.map((driver) => driver.driverID).sort(), BUILT_IN_DRIVER_IDS);

    for (let driver of drivers) {
      assert.equal(typeof driver.driverID, 'string');
      assert.equal(typeof driver.displayName, 'string');
      assert.equal(typeof driver.description, 'string');
      assert.equal(typeof driver.capabilities, 'object');
      assert.ok(Array.isArray(driver.configFields));
      assert.ok(Array.isArray(driver.configKeys));
      assert.equal(driver.capabilities.read, true);
    }

    // The default boot selects AeorDB without needing a live AeorDB server.
    assert.equal(body.data.active, 'aeordb');
  } finally {
    await settleAndClose(server, context);
  }
});

test('GET /api/v1/database-drivers is read-only (POST is not handled)', async () => {
  let context = new AppContext({
    pluginLoadPromise: Promise.resolve(),
  });
  let server = await createServer({ context, fetchImpl: stubFetch });
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/database-drivers`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally {
    await settleAndClose(server, context);
  }
});

test('database-drivers route reports the active postgresql driver when selected', { skip: !postgresAvailable && 'PostgreSQL test cluster unavailable' }, async () => {
  let previousDriver = process.env.ORG_AEOR_KIKX_DATABASE_DRIVER;
  let previousURL = process.env.ORG_AEOR_KIKX_DATABASE_URL;
  process.env.ORG_AEOR_KIKX_DATABASE_DRIVER = 'postgresql';
  process.env.ORG_AEOR_KIKX_DATABASE_URL = PG_TEST_URL;

  let context = new AppContext({
    pluginLoadPromise: Promise.resolve(),
  });
  let server;
  try {
    server = await createServer({ context });
    let baseURL = await listen(server);

    let response = await fetch(`${baseURL}/api/v1/database-drivers`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.active, 'postgresql');
    assert.deepEqual(body.data.drivers.map((driver) => driver.driverID).sort(), BUILT_IN_DRIVER_IDS);
  } finally {
    await settleAndClose(server, context);
    restoreEnv('ORG_AEOR_KIKX_DATABASE_DRIVER', previousDriver);
    restoreEnv('ORG_AEOR_KIKX_DATABASE_URL', previousURL);
  }
});

test('database-drivers route falls back to the connection driverID when unrecorded', async () => {
  class FakeDriver {
    static driverID = 'fakedb';
  }

  let context = new AppContext({
    pluginRegistry: {
      async listDatabaseDriverDescriptors() {
        return [ { driverID: 'fakedb' } ];
      },
    },
    db: new FakeDriver(),
  });
  let response = {
    statusCode: null,
    body: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(payload) {
      this.body = JSON.parse(payload);
    },
  };

  let handled = await handleDatabaseRoutes({
    request: { method: 'GET' },
    response,
    url: new URL('http://localhost/api/v1/database-drivers'),
    context,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.active, 'fakedb');
});
