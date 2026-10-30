'use strict';

// P6 exit proof: one plugin index declaration works on both drivers that
// advertise support, and an unsupported driver reports a scan fallback.
//
// The plugin is `plugins/todo-focus-index` and the index is `focus_todo_id`. This
// spec drives the REAL plugin service against the REAL drivers, so the claim is
// about the shipped path, not a mock:
//
//  - SQLite  — builds a real JSON1 expression index (`scalarIndex`).
//  - PostgreSQL — builds a real expression index (`scalarIndex`); this block
//    skips cleanly when no test cluster answers.
//  - AeorDB  — persists index *documents*, but has no scalar-index mechanism, so
//    the plugin's scalar index must report a scan fallback rather than pretend.
//  - in-memory — has neither mechanism and must report a scan fallback.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AeorDBConnection } from '../../../src/core/aeordb/aeordb-connection.mjs';
import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';
import { writeIndexConfigs } from '../../../src/core/database/index-configs.mjs';
import { PostgreSQLConnection } from '../../../src/core/database/postgresql-connection.mjs';
import { SQLiteConnection } from '../../../src/core/database/sqlite-connection.mjs';
import { TodoFocusIndexService } from '../../../plugins/todo-focus-index/index.mjs';
import { InMemoryDatabaseConnection } from './reference-driver.mjs';
import { FakeAeorDBClient } from './fake-aeordb-client.mjs';

const INDEX_NAME = 'focus_todo_id';
const SCALAR_INDEX_DRIVERS = [ 'sqlite', 'postgresql' ];

// The two mechanisms are separate declarations, and each driver must state its
// own answer. This is the sentence that makes "a driver advertises support"
// checkable instead of assumed.
test('every driver declares both index mechanisms explicitly', () => {
  for (let driverClass of [ InMemoryDatabaseConnection, AeorDBConnection, PostgreSQLConnection, SQLiteConnection ]) {
    assert.equal(
      typeof driverClass.capabilities?.indexDocuments,
      'boolean',
      `${driverClass.driverID}: capabilities.indexDocuments must be a boolean`,
    );
    assert.equal(
      typeof driverClass.capabilities?.scalarIndex,
      'boolean',
      `${driverClass.driverID}: capabilities.scalarIndex must be a boolean`,
    );
  }

  // The declarations are not cosmetic: they must separate the drivers, not make
  // every driver claim the same thing.
  let scalarDrivers = [ InMemoryDatabaseConnection, AeorDBConnection, PostgreSQLConnection, SQLiteConnection ]
    .filter((driverClass) => driverClass.capabilities.scalarIndex)
    .map((driverClass) => driverClass.driverID);
  assert.deepEqual(scalarDrivers.sort(), [ ...SCALAR_INDEX_DRIVERS ].sort(), 'exactly the drivers with a real scalar-index mechanism claim one');

  assert.equal(AeorDBConnection.capabilities.indexDocuments, true, 'AeorDB persists index configuration documents');
  assert.equal(PostgreSQLConnection.capabilities.indexDocuments, false);
  assert.equal(SQLiteConnection.capabilities.indexDocuments, false);
  assert.equal(InMemoryDatabaseConnection.capabilities.indexDocuments, false);
  assert.equal(InMemoryDatabaseConnection.capabilities.scalarIndex, false);
});

// ---------------------------------------------------------------------------
// SQLite: the real index, on the real driver, through the real plugin service.
// ---------------------------------------------------------------------------

test('the focus index is built on SQLite, through the plugin service', async () => {
  let db = new SQLiteConnection({});
  await db.connect();

  try {
    let service = new TodoFocusIndexService({ db });
    let result = await service.ensure();

    assert.equal(service.status, 'built');
    assert.equal(service.applied, true);
    assert.equal(service.scanFallback, false);
    assert.equal(result.applied, true);
    assert.equal(result.driver, 'sqlite');
    assert.equal(result.indexName, `documents_${INDEX_NAME}_idx`);

    // The index must exist in the catalog, not merely be reported as created.
    let indexes = db.sqlite.prepare("PRAGMA index_list('documents')").all();
    assert.ok(
      indexes.some((index) => index.name === `documents_${INDEX_NAME}_idx`),
      'a real index row must exist in SQLite',
    );

    // Creating it twice is idempotent (a reload re-runs this).
    let again = await new TodoFocusIndexService({ db }).ensure();
    assert.equal(again.applied, true);
    let after = db.sqlite.prepare("PRAGMA index_list('documents')").all();
    assert.equal(after.filter((index) => index.name === `documents_${INDEX_NAME}_idx`).length, 1);
  } finally {
    await db.close();
  }
});

test('the SQLite focus index actually serves the query it indexes', async () => {
  let db = new SQLiteConnection({});
  await db.connect();

  try {
    await db.put('/kikx/sessions/ses_1/interactions/frames/0001.json', { focus_todo_id: 'todo-a' });
    await db.put('/kikx/sessions/ses_1/interactions/frames/0002.json', { focus_todo_id: 'todo-b' });
    await db.put('/kikx/sessions/ses_1/interactions/frames/0003.json', { other: true });

    await new TodoFocusIndexService({ db }).ensure();

    // Reading through the indexed expression must return exactly the matching
    // frame, so the index is consistent with the rows the driver wrote.
    let rows = db.sqlite.prepare(
      "SELECT path FROM documents WHERE json_extract(body, '$.focus_todo_id') = ? AND raw = 0 ORDER BY path",
    ).all('todo-a');
    assert.deepEqual(rows.map((row) => row.path), [ '/kikx/sessions/ses_1/interactions/frames/0001.json' ]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// PostgreSQL: the same plugin service, the same index name, a real cluster.
// ---------------------------------------------------------------------------

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

test('the same focus index is built on PostgreSQL, through the same plugin service', { skip: !available && SKIP_REASON }, async () => {
  let db = new PostgreSQLConnection({ url: TEST_URL });
  await db.connect();

  try {
    let service = new TodoFocusIndexService({ db });
    let result = await service.ensure();

    assert.equal(service.status, 'built');
    assert.equal(service.applied, true);
    assert.equal(result.applied, true);
    assert.equal(result.driver, 'postgresql');
    assert.equal(result.indexName, `documents_${INDEX_NAME}_idx`);

    // Assert against the catalog rather than the return value: the index must
    // exist as a real expression index over this field.
    let { rows } = await db.pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'documents' AND indexname = $1`,
      [ `documents_${INDEX_NAME}_idx` ],
    );
    assert.equal(rows.length, 1, 'the expression index must exist in pg_indexes');
    assert.match(rows[0].indexdef, /body/);
    assert.match(rows[0].indexdef, new RegExp(INDEX_NAME));
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Unsupported drivers: report a scan fallback, never a silent success.
// ---------------------------------------------------------------------------

test('AeorDB reports a scan fallback for a scalar index, and really writes index documents', async () => {
  let client = new FakeAeorDBClient();
  let db = new AeorDBConnection({ client });
  await db.connect();

  try {
    let service = new TodoFocusIndexService({ db });
    let result = await service.ensure();

    assert.equal(service.status, 'absent', 'AeorDB cannot build a scalar index, so the outcome is a scan fallback');
    assert.equal(service.applied, false);
    assert.equal(service.scanFallback, true);
    assert.equal(service.error, null, 'a scan fallback is not an error');
    assert.equal(result, null);

    // The failure mode this replaces: a silent no-op resolved `undefined`, which is
    // what the plugin used to record as success.
    await assert.rejects(
      () => db.ensureScalarIndex(INDEX_NAME),
      (error) => error instanceof DatabaseError && error.code === 'capability_unsupported',
    );

    // AeorDB's actual mechanism still works and is reported as applied.
    let written = await writeIndexConfigs(db, [
      { path: '/kikx/sessions/.aeordb-config/indexes.json', body: { glob: '*/session.json', indexes: [ { name: 'id', type: 'string' } ] } },
    ]);
    assert.equal(written.applied, true);
    assert.equal(written.driver, 'aeordb');
    assert.equal(written.count, 1);
  } finally {
    await db.close();
  }
});

test('a driver with neither mechanism reports a scan fallback through writeIndexConfigs', async () => {
  let db = new InMemoryDatabaseConnection();
  await db.connect();

  try {
    let service = new TodoFocusIndexService({ db });
    await service.ensure();
    assert.equal(service.status, 'absent');
    assert.equal(service.scanFallback, true);

    let written = await writeIndexConfigs(db, [
      { path: '/kikx/.aeordb-config/indexes.json', body: { indexes: [] } },
    ]);
    assert.equal(written.applied, false);
    assert.equal(written.scanFallback, true);
    assert.equal(written.reason, 'capability_unsupported');
  } finally {
    await db.close();
  }
});

// The `typeof` probe this replaces answered true for every driver, because the
// base class defined the hook as a no-op. Guard the new gate explicitly.
test('writeIndexConfigs gates on the capability, not on the method existing', async () => {
  let db = new InMemoryDatabaseConnection();
  assert.equal(typeof db.configureIndexes, 'function', 'the hook exists on every driver — which is why typeof could never gate it');

  let result = await writeIndexConfigs(db, []);
  assert.equal(result.applied, false);
  assert.equal(result.scanFallback, true);
});

test('a raw putFile client is not reported as a scan fallback', async () => {
  // The historical fake clients used by the frame-store specs expose only
  // putFile. Those documents are genuinely persisted, so this is real work, not
  // a fallback.
  let written = [];
  let client = { async putFile(path, body) { written.push({ path, body }); } };

  let result = await writeIndexConfigs(client, [
    { path: '/kikx/sessions/.aeordb-config/indexes.json', body: { indexes: [] } },
  ]);

  assert.equal(result.applied, true);
  assert.equal(result.via, 'putFile');
  assert.equal(written.length, 1);
});

test('a driver that refuses to build the index reports a failure, retryably', async () => {
  class FailingDriver extends DatabaseConnectionBase {
    static driverID = 'failing';
    static capabilities = { ...DatabaseConnectionBase.capabilities, scalarIndex: true };

    async ensureScalarIndex() {
      throw new Error('permission denied for schema public');
    }
  }

  let service = new TodoFocusIndexService({ db: new FailingDriver() });
  let first = await service.ensure();

  assert.equal(first, undefined);
  assert.equal(service.status, 'failed');
  assert.equal(service.applied, false);
  assert.match(service.error, /permission denied/);
  assert.equal(service.attempts, 1);

  // Not cached: a retry is allowed, which is the defect the service exists to fix.
  await service.ensure();
  assert.equal(service.attempts, 2);
});
