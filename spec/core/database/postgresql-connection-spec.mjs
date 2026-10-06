'use strict';

// PostgreSQL driver: runs the shared driver-contract harness against
// PostgreSQLConnection, then asserts the declared metadata, capability gating,
// config resolution, and raw-document semantics. The suite probes a private
// local cluster first and skips cleanly when it is unavailable, so `npm test`
// stays green without PostgreSQL running.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';
import {
  PostgreSQLConnection,
  resolvePostgresConfig,
} from '../../../src/core/database/postgresql-connection.mjs';
import { runDatabaseContractSuite } from './driver-contract-harness.mjs';

// `[::1]` avoids the owner's SSH tunnel that occupies 127.0.0.1:55432.
const TEST_URL = process.env.KIKX_TEST_PG_URL || 'postgres://postgres@[::1]:55432/postgres';
const SKIP_REASON = 'PostgreSQL test cluster unavailable';

async function probe() {
  try {
    let { Client } = await import('pg');
    let client = new Client({ connectionString: TEST_URL, connectionTimeoutMillis: 2000 });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch (_error) {
    return false;
  }
}

let available = await probe();

// Ensure the documents table exists before the suite's beforeEach truncation.
// connect() is the only place that runs the DDL, so borrow the driver once.
if (available) {
  let bootstrap = new PostgreSQLConnection({ url: TEST_URL });
  await bootstrap.connect();
  await bootstrap.close();
}

let truncatePool = null;
async function truncateDocuments() {
  if (!available)
    return;

  if (!truncatePool) {
    let { Pool } = await import('pg');
    truncatePool = new Pool({ connectionString: TEST_URL });
  }

  await truncatePool.query('TRUNCATE documents');
}

after(async () => {
  await truncatePool?.end();
  truncatePool = null;
});

function describe(name, fn) {
  if (available) {
    test(`PostgreSQLConnection: ${name}`, async () => {
      await truncateDocuments();
      await fn();
    });
  } else {
    test(`PostgreSQLConnection: ${name}`, { skip: SKIP_REASON }, fn);
  }
}

runDatabaseContractSuite('PostgreSQLConnection', async () => {
  let db = new PostgreSQLConnection({ url: TEST_URL });
  await db.connect();
  return db;
}, { driverClass: PostgreSQLConnection, describe });

test('PostgreSQLConnection extends DatabaseConnectionBase and declares its driverID', () => {
  assert.equal(Object.getPrototypeOf(PostgreSQLConnection), DatabaseConnectionBase);
  assert.equal(PostgreSQLConnection.driverID, 'postgresql');
  assert.equal(PostgreSQLConnection.displayName, 'PostgreSQL');
  assert.equal(typeof PostgreSQLConnection.description, 'string');
  assert.equal(PostgreSQLConnection.batchAtomicity, 'atomic');
});

test('PostgreSQLConnection capabilities match the declared document surface', () => {
  assert.deepEqual(PostgreSQLConnection.capabilities, {
    read: true,
    write: true,
    mergePatch: true,
    list: true,
    getMany: true,
    search: false,
    query: false,
    events: false,
    auth: false,
    ranges: false,
  });
});

test('PostgreSQLConnection exposes connection config fields and the database url key', () => {
  assert.deepEqual(
    PostgreSQLConnection.configFields.map((field) => field.name),
    [ 'host', 'port', 'database', 'user', 'password', 'ssl' ],
  );
  assert.deepEqual(PostgreSQLConnection.configKeys, [ '/org/aeor/kikx/database/url' ]);

  let password = PostgreSQLConnection.configFields.find((field) => field.name === 'password');
  assert.equal(password.secret, true, 'password must be marked secret');
});

test('PostgreSQLConnection hides the unsupported search surface behind a typed capability error', async () => {
  let db = new PostgreSQLConnection({ url: TEST_URL });

  try {
    assert.equal(typeof db.searchFiles, 'undefined');
    assert.equal(typeof db.queryFiles, 'undefined');
    assert.equal(typeof db.fetchFileRanges, 'undefined');

    await assert.rejects(
      () => db.search({ path: '/kikx' }),
      (error) => error instanceof DatabaseError && error.code === 'capability_unsupported',
    );
  } finally {
    await db.close();
  }
});

test('resolvePostgresConfig applies defaults and parses postgres URLs', () => {
  assert.deepEqual(resolvePostgresConfig({}), {
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
  });

  assert.deepEqual(resolvePostgresConfig({ url: 'postgresql://alice:secret@db.example.com:5433/kikx' }), {
    host: 'db.example.com',
    port: 5433,
    database: 'kikx',
    user: 'alice',
    password: 'secret',
  });

  let ipv6 = resolvePostgresConfig({ url: 'postgres://postgres@[::1]:55432/postgres' });
  assert.equal(ipv6.host, '::1');
  assert.equal(ipv6.port, 55432);

  // Explicit fields win over URL components.
  let overridden = resolvePostgresConfig({ url: 'postgres://a@b.example.com:5432/c', host: 'other', user: 'bob' });
  assert.equal(overridden.host, 'other');
  assert.equal(overridden.user, 'bob');

  // A non-postgres URL (the generic AeorDB url) is ignored, not misparsed.
  assert.equal(resolvePostgresConfig({ url: 'http://127.0.0.1:6830' }).host, '127.0.0.1');

  // ssl mode is normalized from the URL and explicit options.
  assert.equal(resolvePostgresConfig({ url: 'postgres://h/db?sslmode=disable' }).ssl, false);
  assert.deepEqual(resolvePostgresConfig({ url: 'postgres://h/db?sslmode=require' }).ssl, { rejectUnauthorized: false });
});

test('PostgreSQLConnection stores and returns raw text when options.raw is set', { skip: !available && SKIP_REASON }, async () => {
  let db = new PostgreSQLConnection({ url: TEST_URL });
  await db.connect();

  try {
    await db.put('/kikx/raw/note.txt', 'hello world', { raw: true });
    assert.equal(await db.get('/kikx/raw/note.txt', { raw: true }), 'hello world');
  } finally {
    await db.close();
  }
});

test('PostgreSQLConnection returns raw text when expectJSON is false', { skip: !available && SKIP_REASON }, async () => {
  let db = new PostgreSQLConnection({ url: TEST_URL });
  await db.connect();

  try {
    await db.put('/kikx/raw/json.txt', { id: 'json' });
    assert.equal(await db.get('/kikx/raw/json.txt', { expectJSON: false }), '{"id":"json"}');
  } finally {
    await db.close();
  }
});
