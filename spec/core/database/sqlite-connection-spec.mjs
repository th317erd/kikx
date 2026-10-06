'use strict';

// SQLite driver: runs the shared driver-contract harness against
// SQLiteConnection (Node's bundled `node:sqlite`), then asserts the declared
// metadata, capability gating, and file-backed lifecycle.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';
import { SQLiteConnection, resolveSQLiteFilename } from '../../../src/core/database/sqlite-connection.mjs';
import { runDatabaseContractSuite } from './driver-contract-harness.mjs';

runDatabaseContractSuite('SQLiteConnection', async () => {
  let db = new SQLiteConnection({ filename: ':memory:' });
  await db.connect();
  return db;
}, { driverClass: SQLiteConnection });

test('SQLiteConnection extends DatabaseConnectionBase and declares its driverID', () => {
  assert.equal(Object.getPrototypeOf(SQLiteConnection), DatabaseConnectionBase);
  assert.equal(SQLiteConnection.driverID, 'sqlite');
  assert.equal(SQLiteConnection.displayName, 'SQLite');
  assert.equal(typeof SQLiteConnection.description, 'string');
  assert.equal(SQLiteConnection.batchAtomicity, 'atomic');
});

test('SQLiteConnection capabilities match the declared document surface', () => {
  assert.deepEqual(SQLiteConnection.capabilities, {
    read: true,
    write: true,
    mergePatch: true,
    list: true,
    getMany: true,
    search: true,
    query: true,
    events: false,
    auth: false,
    ranges: true,
  });
});

test('SQLiteConnection exposes a filename config field and the database path key', () => {
  assert.deepEqual(SQLiteConnection.configFields.map((field) => field.name), [ 'filename' ]);
  assert.deepEqual(SQLiteConnection.configKeys, [ '/org/aeor/kikx/database/path' ]);
});

test('SQLiteConnection exposes the scan-backed search/query/ranges surface', async () => {
  let db = new SQLiteConnection({ filename: ':memory:' });
  await db.connect();

  try {
    assert.equal(db.supports('search'), true);
    assert.equal(db.supports('query'), true);
    assert.equal(db.supports('ranges'), true);
    assert.equal(typeof db.searchFiles, 'function');
    assert.equal(typeof db.queryFiles, 'function');
    assert.equal(typeof db.fetchFileRanges, 'function');
    assert.equal(typeof db.search, 'function');
    assert.equal(typeof db.query, 'function');
    assert.equal(typeof db.getRanges, 'function');

    // events/auth remain unsupported and still fail with a typed error.
    await assert.rejects(
      async () => db.eventsURL(),
      (error) => error instanceof DatabaseError && error.code === 'capability_unsupported',
    );
  } finally {
    await db.close();
  }
});

test('SQLiteConnection opens a file-backed database and cleans up on close', async () => {
  let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-sqlite-'));
  let filename = path.join(directory, 'kikx.sqlite');
  let db = new SQLiteConnection({ filename });

  try {
    assert.equal(db.filename, filename);
    await db.connect();
    await db.put('/kikx/test/file.json', { id: 'file' });
    assert.deepEqual(await db.get('/kikx/test/file.json'), { id: 'file' });

    await db.close();
    // close() is idempotent.
    await db.close();

    let stat = await fs.stat(filename);
    assert.ok(stat.isFile(), 'a file-backed database must create the file');
  } finally {
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('SQLiteConnection resolves plain paths and sqlite: URLs', () => {
  assert.equal(resolveSQLiteFilename({}), ':memory:');
  assert.equal(resolveSQLiteFilename({ filename: ':memory:' }), ':memory:');
  assert.equal(resolveSQLiteFilename({ filename: 'sqlite::memory:' }), ':memory:');
  assert.equal(resolveSQLiteFilename({ filename: 'sqlite:///abs/path.sqlite' }), '/abs/path.sqlite');
  assert.equal(resolveSQLiteFilename({ filename: 'sqlite:rel/path.sqlite' }), 'rel/path.sqlite');
  assert.equal(resolveSQLiteFilename({ filename: 'data/kikx.sqlite' }), 'data/kikx.sqlite');
  assert.equal(resolveSQLiteFilename({ url: 'http://127.0.0.1:6830' }), ':memory:');
  assert.equal(resolveSQLiteFilename({ secrets: { filename: '/var/kikx.sqlite' } }), '/var/kikx.sqlite');
});

test('SQLiteConnection stores and returns raw text when options.raw is set', async () => {
  let db = new SQLiteConnection({ filename: ':memory:' });
  await db.connect();

  try {
    await db.put('/kikx/raw/note.txt', 'hello world', { raw: true });
    assert.equal(await db.get('/kikx/raw/note.txt', { raw: true }), 'hello world');
  } finally {
    await db.close();
  }
});
