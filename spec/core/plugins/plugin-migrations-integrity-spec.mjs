'use strict';

// P6: checksum, advisory-lock and rollback integrity for plugin migrations.
//
// Why this file exists
// --------------------
// The campaign's P6 "still open" list asks for "checksum/advisory-lock migration
// tests". The code existed but only the driver-qualification half was ever exercised
// by spec/core/plugins/plugin-migrations-driver-spec.mjs, which drives a fake pool that
// answers every statement generically. That fake cannot distinguish a statement that
// ran inside a transaction from one that ran outside it, and it never fails, so the
// failure path — the path where data integrity is actually at stake — was unproven.
//
// Four contracts are locked down here:
//   1. A migration that fails rolls back and its ledger row is never written.
//   2. A failed migration is not reported as applied.  <-- this one was BROKEN
//   3. An applied migration whose file later changed is refused, not re-run.
//   4. Every plugin runs under its own advisory lock, released on failure too.
//
// Contract 2 was a real defect, not a gap. `#runPlugin` pushed onto `this.applied`
// BEFORE the BEGIN/COMMIT, so `run()` returned a list naming a migration that had
// thrown and rolled back. An operator reading the startup log would see it as applied.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PluginMigrations } from '../../../src/core/plugins/plugin-migrations.mjs';

// A pool that records statements AND can be told to fail a specific one. The order of
// the log is what proves the rollback discipline: a COMMIT before a ROLLBACK, or a
// ledger INSERT after one, is visible here even though the return value looks fine.
function createConnection({ failOn = null } = {}) {
  let log = [];
  let ledgerRows = new Map();

  let connection = {
    log,
    ledgerRows,
    async query(sql, params = []) {
      log.push({ sql, params });

      if (/pg_advisory_(un)?lock/.test(sql)) return { rows: [] };
      if (/CREATE TABLE IF NOT EXISTS plugin_migrations/i.test(sql)) return { rows: [] };

      if (/^\s*SELECT version, name, checksum FROM plugin_migrations/i.test(sql))
        return { rows: ledgerRows.get(params[0]) || [] };

      if (/^\s*INSERT INTO plugin_migrations/i.test(sql)) {
        let [ pluginId, version, name, checksum ] = params;
        let rows = ledgerRows.get(pluginId) || [];
        rows.push({ version, name, checksum });
        ledgerRows.set(pluginId, rows);
        return { rows: [] };
      }

      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };

      // The migration body. `failOn` matches the SQL text of the file to fail.
      if (failOn && sql.includes(failOn))
        throw new Error('relation "probe_kaboom" does not exist');
      return { rows: [] };
    },
  };

  return connection;
}

async function makeMigrationsDir(files) {
  let dir = await mkdtemp(path.join(tmpdir(), 'kikx-mig-'));
  for (let [ name, sql ] of Object.entries(files))
    await writeFile(path.join(dir, name), sql, 'utf8');
  return dir;
}

function makeMigrations(connection) {
  let migrations = new PluginMigrations({
    url: 'postgres://unused/placeholder',
    driver: 'postgresql',
    logger: { warn() {}, info() {}, error() {} },
  });
  migrations.pool = connection;
  return migrations;
}

// Statements that indicate a transaction was opened and closed. Filtered so assertions
// about ordering do not have to wade through locks and DDL.
function transactionLog(connection) {
  return connection.log
    .map((entry) => entry.sql.trim().toUpperCase())
    .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK');
}

// --- 1 & 2. Failure rolls back, and is not reported as applied ----------------------

test('a failed migration rolls back and writes no ledger row', async () => {
  let dir = await makeMigrationsDir({
    '001-good.sql': 'CREATE TABLE probe_widget (id INT)',
    '002-bad.sql': 'CREATE TABLE probe_kaboom (id INT)',
  });
  try {
    let connection = createConnection({ failOn: 'kaboom' });
    let migrations = makeMigrations(connection);
    migrations.register('probe', { directory: dir });

    await assert.rejects(() => migrations.run(), /migration 002-bad\.sql failed/);

    assert.deepEqual(transactionLog(connection), [ 'BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK' ],
      'the failed file must be rolled back, and the good one committed first');

    // The failed migration must never have reached the ledger.
    let inserts = connection.log.filter((e) => /^\s*INSERT INTO plugin_migrations/i.test(e.sql));
    assert.equal(inserts.length, 1, 'only the successful migration is recorded');
    assert.equal(inserts[0].params[1], 1, 'recorded version 1, not 2');

    let ledger = connection.ledgerRows.get('probe');
    assert.deepEqual(ledger.map((r) => r.version), [ 1 ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed migration is not reported as applied by run()', async () => {
  // THE DEFECT: `this.applied.push(...)` ran before BEGIN, so a rollback left the
  // name in the returned list. Nothing downstream could tell it apart from a real
  // apply, and the startup log said the schema was up to date.
  let dir = await makeMigrationsDir({ '001-bad.sql': 'CREATE TABLE probe_kaboom (id INT)' });
  try {
    let connection = createConnection({ failOn: 'kaboom' });
    let migrations = makeMigrations(connection);
    migrations.register('probe', { directory: dir });

    await assert.rejects(() => migrations.run(), /failed/);

    // run() throws, so the returned list is unreachable; the property is what a
    // retry or a log line reads, and it must not claim the migration landed.
    assert.deepEqual(migrations.applied, [], 'a rolled-back migration must not be listed as applied');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a successful run reports exactly the migrations it applied, in order', async () => {
  let dir = await makeMigrationsDir({
    '001-first.sql': 'CREATE TABLE probe_a (id INT)',
    '002-second.sql': 'CREATE TABLE probe_b (id INT)',
  });
  try {
    let connection = createConnection();
    let migrations = makeMigrations(connection);
    migrations.register('probe', { directory: dir });

    let result = await migrations.run();

    assert.equal(result.skipped, false);
    assert.deepEqual(result.applied, [ 'probe:001-first.sql', 'probe:002-second.sql' ]);
    assert.deepEqual(transactionLog(connection), [ 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT' ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 3. Checksums make applied migrations immutable ---------------------------------

test('an applied migration whose file changed is refused, not re-run', async () => {
  let dir = await makeMigrationsDir({ '001-first.sql': 'CREATE TABLE probe_a (id INT)' });
  try {
    let connection = createConnection();
    let migrations = makeMigrations(connection);
    migrations.register('probe', { directory: dir });

    await migrations.run();
    let originalChecksum = connection.ledgerRows.get('probe')[0].checksum;

    // Someone edits a migration that has already run. This is the case checksums exist
    // to catch: re-running it would apply a change no one reviewed against the schema
    // that is actually deployed.
    await writeFile(path.join(dir, '001-first.sql'), 'CREATE TABLE probe_a (id INT, extra TEXT)', 'utf8');

    let second = makeMigrations(connection);
    second.register('probe', { directory: dir });

    await assert.rejects(
      () => second.run(),
      /changed after it was applied/,
      'an edited migration must be refused',
    );

    // And the refusal must name both checksums, or an operator cannot tell which side
    // is stale.
    await assert.rejects(
      () => second.run(),
      (error) => {
        assert.match(error.message, new RegExp(originalChecksum.slice(0, 12)));
        assert.match(error.message, /write a new migration instead/i);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unchanged applied migration is skipped rather than re-applied', async () => {
  let dir = await makeMigrationsDir({ '001-first.sql': 'CREATE TABLE probe_a (id INT)' });
  try {
    let connection = createConnection();
    let first = makeMigrations(connection);
    first.register('probe', { directory: dir });
    await first.run();
    let transactionCount = transactionLog(connection).length;

    let second = makeMigrations(connection);
    second.register('probe', { directory: dir });
    let result = await second.run();

    assert.deepEqual(result.applied, [], 'nothing new to apply');
    assert.equal(transactionLog(connection).length, transactionCount, 'no new transaction was opened');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a ledger row whose file is gone is an error, not a silent skip', async () => {
  let dir = await makeMigrationsDir({ '001-first.sql': 'CREATE TABLE probe_a (id INT)' });
  try {
    let connection = createConnection();
    let migrations = makeMigrations(connection);
    migrations.register('probe', { directory: dir });
    await migrations.run();

    await rm(path.join(dir, '001-first.sql'));

    let second = makeMigrations(connection);
    second.register('probe', { directory: dir });

    // Deleting an applied migration destroys the only record of how to rebuild the
    // schema. Silently skipping it would let a fresh clone produce a different database.
    await assert.rejects(() => second.run(), /but the file is missing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 4. Advisory locks bracket each plugin, and are released on failure -------------

test('every plugin runs under its own advisory lock, taken and released', async () => {
  let dir = await makeMigrationsDir({ '001-first.sql': 'CREATE TABLE probe_a (id INT)' });
  try {
    let connection = createConnection();
    let migrations = makeMigrations(connection);
    migrations.register('probe', { directory: dir });

    await migrations.run();

    let locks = connection.log.filter((e) => /pg_advisory_lock/.test(e.sql));
    let unlocks = connection.log.filter((e) => /pg_advisory_unlock/.test(e.sql));

    // The ledger table DDL takes one lock, each plugin takes another.
    assert.ok(locks.some((e) => e.params[0] === 'plugin_migrations:ledger'), 'ledger lock was not taken');
    assert.ok(unlocks.some((e) => e.params[0] === 'plugin_migrations:ledger'), 'ledger lock was not released');
    assert.ok(locks.some((e) => e.params[0] === 'plugin_migrations:probe'), 'per-plugin lock was not taken');
    assert.ok(unlocks.some((e) => e.params[0] === 'plugin_migrations:probe'), 'per-plugin lock was not released');

    // The CREATE TABLE for the ledger must be INSIDE the ledger lock, or two processes
    // starting together race on pg_type instead of queueing.
    let lockAt = connection.log.findIndex((e) => /pg_advisory_lock/.test(e.sql) && e.params[0] === 'plugin_migrations:ledger');
    let createAt = connection.log.findIndex((e) => /CREATE TABLE IF NOT EXISTS plugin_migrations/i.test(e.sql));
    let unlockAt = connection.log.findIndex((e) => /pg_advisory_unlock/.test(e.sql) && e.params[0] === 'plugin_migrations:ledger');
    assert.ok(lockAt < createAt && createAt < unlockAt, 'ledger DDL ran outside its lock');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the per-plugin lock is released even when the migration throws', async () => {
  // Without the finally, one bad migration leaves the lock held for the life of the
  // connection, and every later startup blocks on it.
  let dir = await makeMigrationsDir({ '001-bad.sql': 'CREATE TABLE probe_kaboom (id INT)' });
  try {
    let connection = createConnection({ failOn: 'kaboom' });
    let migrations = makeMigrations(connection);
    migrations.register('probe', { directory: dir });

    await assert.rejects(() => migrations.run(), /failed/);

    assert.ok(
      connection.log.some((e) => /pg_advisory_unlock/.test(e.sql) && e.params[0] === 'plugin_migrations:probe'),
      'the plugin lock leaked after a failure',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 5. Table-prefix guard (the namespace boundary) ---------------------------------

test('a migration creating a table outside the plugin prefix is refused before it runs', async () => {
  let dir = await makeMigrationsDir({ '001-wrong.sql': 'CREATE TABLE someone_elses_table (id INT)' });
  try {
    let connection = createConnection();
    let migrations = makeMigrations(connection);
    migrations.register('probe', { directory: dir });

    await assert.rejects(() => migrations.run(), /does not carry the "probe_" prefix/);

    // Refused BEFORE any transaction: a plugin must not get as far as executing DDL
    // that touches another plugin's namespace.
    assert.deepEqual(transactionLog(connection), [], 'no transaction should have been opened');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
