'use strict';

// PluginMigrations: the persistence contract says which driver it needs.
//
// Why this file exists
// --------------------
// The campaign's P0 asks for migration/database contracts to be "explicitly
// driver-qualified; keep Postgres working while reporting unsupported drivers". Before
// this, PluginMigrations executed PostgreSQL SQL unconditionally: pg_advisory_lock for
// the startup lock, TIMESTAMPTZ in the ledger table, and BEGIN/COMMIT around each file.
// A Kikx instance backed by AeorDB or SQLite would not have been told the migrations
// were unsupported, it would have been handed SQL its database cannot parse.
//
// The contract locked down here:
//   1. The driver is declared, not implied, and an unknown driver is refused up front.
//   2. A plugin may name the drivers its SQL targets.
//   3. A plugin that targets a different driver is skipped *by name* and reported, and
//      no statement is ever sent to the database on its behalf.
//   4. A plugin that names nothing keeps working: silence still means portable.
//
// Point 3 is the one that matters. Reporting an unsupported plugin while still opening a
// connection and running its SQL would satisfy a weaker reading of the requirement and
// still corrupt a database, so the assertions below check the recorded statement log.

import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginMigrations } from '../../../src/core/plugins/plugin-migrations.mjs';

// A stand-in for the pg pool. It records every statement so a test can prove not just
// the shape of the return value but that nothing was executed for a skipped plugin.
function createConnection() {
  let log = [];
  let ledgerRows = new Map();   // pluginId -> [{ version, name, checksum }]

  let connection = {
    log,
    ledgerRows,
    async query(sql, params = []) {
      log.push({ sql, params });

      // The advisory-lock calls bracket everything else; they are plumbing.
      if (/pg_advisory_(un)?lock/.test(sql)) return { rows: [] };
      // Ledger DDL is issued under the ledger lock.
      if (/CREATE TABLE IF NOT EXISTS plugin_migrations/i.test(sql)) return { rows: [] };

      // SELECT ... FROM plugin_migrations WHERE plugin_id = $1
      if (/^\s*SELECT version, name, checksum FROM plugin_migrations/i.test(sql))
        return { rows: ledgerRows.get(params[0]) || [] };

      // INSERT INTO plugin_migrations ... VALUES ($1, $2, $3, $4)
      if (/^\s*INSERT INTO plugin_migrations/i.test(sql)) {
        let [ pluginId, version, name, checksum ] = params;
        let rows = ledgerRows.get(pluginId) || [];
        rows.push({ version, name, checksum });
        ledgerRows.set(pluginId, rows);
        return { rows: [] };
      }

      // Transaction control and the migration body itself.
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };

  return connection;
}

function createMigrations({ driver = 'postgresql', logger = null } = {}) {
  let migrations = new PluginMigrations({
    url: 'postgres://unused/placeholder',
    driver,
    logger: logger || { warn() {}, info() {} },
  });
  // Hand the fake pool in directly so nothing tries to reach a real database.
  let connection = createConnection();
  migrations.pool = connection;
  return { migrations, connection };
}

// Records what the module told an operator. A silent skip would be as wrong as a crash:
// the plugin is not running, and the reason has to be discoverable.
function createLogger() {
  let warnings = [];
  return { warnings, warn: (message) => warnings.push(message), info() {} };
}

// --- 1. The driver is declared, and unknown drivers are refused ----------------------

test('the driver defaults to postgresql and is reported', () => {
  let migrations = new PluginMigrations({ url: 'postgres://unused' });
  assert.equal(migrations.driver, 'postgresql');
  assert.equal(migrations.describe().driverID, 'postgresql');
});

test('an unsupported driver is refused at construction, not at first query', () => {
  // Refusing early is the whole point: a constructor that accepted "sqlite" would fail
  // later, after the server had already registered plugins and started listening.
  assert.throws(
    () => new PluginMigrations({ url: 'postgres://unused', driver: 'sqlite' }),
    /do not support driver "sqlite"; supported drivers: postgresql/,
  );
});

test('capabilities are advertised in the same vocabulary as database drivers', () => {
  let migrations = new PluginMigrations({ url: 'postgres://unused' });
  let described = migrations.describe();

  // These are the driver-level facts that make the SQL valid.
  assert.equal(migrations.supports('migrations'), true);
  assert.equal(migrations.supports('transactions'), true);
  assert.equal(migrations.supports('advisoryLocks'), true);
  assert.equal(described.capabilities.migrations, true);

  // A capability it does not have must report false rather than undefined-ish truthiness.
  assert.equal(migrations.supports('replication'), false);
  assert.throws(() => migrations.requireCapability('replication'), /do not support capability: replication/);
});

// --- 2. Plugins may declare the drivers their SQL targets ---------------------------

test('a plugin may declare driver targets, and they are normalised', () => {
  let { migrations } = createMigrations();
  migrations.register('alpha', { directory: '/tmp/alpha', drivers: [ ' PostgreSQL ', 'aeordb' ] });
  assert.equal(migrations.supportsPlugin('alpha'), true);
  assert.deepEqual(migrations.getUnsupportedPlugins(), []);
});

test('a malformed driver declaration is rejected rather than guessed at', () => {
  let { migrations } = createMigrations();
  assert.throws(() => migrations.register('alpha', { directory: '/tmp/alpha', drivers: [] }), /non-empty array/);
  assert.throws(() => migrations.register('alpha', { directory: '/tmp/alpha', drivers: 'postgresql' }), /non-empty array/);
  assert.throws(() => migrations.register('alpha', { directory: '/tmp/alpha', drivers: [ '  ' ] }), /non-empty array/);
});

// --- 3. A plugin targeting another driver is skipped, reported, and never executed ---

test('a plugin targeting another driver is not run, and no statement touches it', async () => {
  let logger = createLogger();
  let { migrations, connection } = createMigrations({ logger });

  // No migration directory is registered for "beta", so loadFiles would return [] or
  // throw; either way any attempt to run it is visible in the statement log.
  migrations.register('alpha', { directory: '/tmp/alpha', drivers: [ 'postgresql' ] });
  migrations.register('beta', { directory: '/tmp/beta', drivers: [ 'aeordb' ] });

  let result = await migrations.run();

  // beta is reported, with the drivers it actually asked for.
  assert.deepEqual(result.unsupported, [ { pluginId: 'beta', drivers: [ 'aeordb' ] } ]);
  assert.equal(result.driver, 'postgresql');

  // The operator was told, by name.
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /beta declares drivers aeordb/);
  assert.match(logger.warnings[0], /skipping its migrations/);

  // The decisive assertion: no per-plugin lock or ledger read was issued for beta, so
  // its SQL could not have run. A skip that still queried would pass a weaker test.
  let betaParam = connection.log.some((entry) => (entry.params || []).includes('plugin_migrations:beta'));
  let betaLedger = connection.log.some(
    (entry) => /FROM plugin_migrations/i.test(entry.sql) && (entry.params || [])[0] === 'beta',
  );
  assert.equal(betaParam, false, 'beta must not be locked');
  assert.equal(betaLedger, false, 'beta must not have its ledger read');

  // alpha, by contrast, was locked: the runnable set is real, not empty.
  assert.equal(
    connection.log.some((entry) => (entry.params || []).includes('plugin_migrations:alpha')),
    true,
  );
});

test('when nothing targets this driver the run is skipped with a reason naming it', async () => {
  let logger = createLogger();
  let { migrations, connection } = createMigrations({ logger });
  migrations.register('beta', { directory: '/tmp/beta', drivers: [ 'aeordb' ] });

  let result = await migrations.run();

  assert.equal(result.skipped, true);
  assert.match(result.reason, /no registered plugin targets driver "postgresql"/);
  assert.equal(result.driver, 'postgresql');
  assert.deepEqual(result.unsupported, [ { pluginId: 'beta', drivers: [ 'aeordb' ] } ]);

  // Not even the ledger table was created, because there was nothing to record.
  assert.equal(
    connection.log.some((entry) => /CREATE TABLE IF NOT EXISTS plugin_migrations/i.test(entry.sql)),
    false,
  );
});

// --- 4. Silence still means portable ------------------------------------------------

test('a plugin that declares no drivers is treated as portable and still runs', async () => {
  let logger = createLogger();
  let { migrations, connection } = createMigrations({ logger });
  migrations.register('alpha', { directory: '/tmp/alpha' });

  // loadFiles on a non-existent directory returns [] by design, so the run completes
  // without applying anything: that is the registration path being exercised.
  let result = await migrations.run();

  assert.equal(result.skipped, false);
  assert.deepEqual(result.unsupported, []);
  assert.equal(result.driver, 'postgresql');
  assert.equal(logger.warnings.length, 0, 'a portable plugin must not warn');
  assert.equal(connection.log.some((entry) => (entry.params || []).includes('plugin_migrations:alpha')), true);
});

test('the run result carries what was applied, so startup can log it', async () => {
  let { migrations } = createMigrations();
  migrations.register('alpha', { directory: '/tmp/alpha' });
  let result = await migrations.run();
  assert.deepEqual(result.applied, []);
  assert.equal(Array.isArray(result.applied), true);
});

// --- Interaction with the pre-existing skip paths -----------------------------------

test('no registered plugins still short-circuits before the driver is considered', async () => {
  let { migrations, connection } = createMigrations();
  let result = await migrations.run();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no plugins registered migrations');
  assert.equal(connection.log.length, 0, 'nothing to do means no statements at all');
});

test('a missing database url skips but still reports driver qualification', async () => {
  let logger = createLogger();
  let migrations = new PluginMigrations({ url: null, logger });
  migrations.register('beta', { directory: '/tmp/beta', drivers: [ 'aeordb' ] });

  let result = await migrations.run();

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no database url');
  // The unsupported set survives the url skip: an operator asking "why is beta not
  // migrated" should not have to change configuration to find out.
  assert.deepEqual(result.unsupported, [ { pluginId: 'beta', drivers: [ 'aeordb' ] } ]);
});
