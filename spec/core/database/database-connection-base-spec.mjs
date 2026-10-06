'use strict';

// Runs the shared driver contract against the reference in-memory driver, then
// asserts base-class behavior every driver inherits: capability flags,
// capability-gated optional methods, the descriptor shape, and that required
// methods are declared abstract (throw until a driver implements them).

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';
import { PluginInterface } from '../../../src/core/plugins/plugin-interface.mjs';
import { InMemoryDatabaseConnection } from './reference-driver.mjs';
import { runDatabaseContractSuite, REQUIRED_METHODS, REQUIRED_CAPABILITIES } from './driver-contract-harness.mjs';

runDatabaseContractSuite('in-memory', async () => {
  let db = new InMemoryDatabaseConnection();
  await db.connect();
  return db;
}, { driverClass: InMemoryDatabaseConnection });

test('DatabaseConnectionBase extends PluginInterface', () => {
  assert.equal(Object.getPrototypeOf(DatabaseConnectionBase), PluginInterface);
});

test('DatabaseConnectionBase declares the full capability surface with safe defaults', () => {
  for (let capability of REQUIRED_CAPABILITIES)
    assert.equal(typeof DatabaseConnectionBase.capabilities[capability], 'boolean');

  // Optional-by-default capabilities are off on the base; required document
  // operations are on.
  assert.equal(DatabaseConnectionBase.capabilities.search, false);
  assert.equal(DatabaseConnectionBase.capabilities.query, false);
  assert.equal(DatabaseConnectionBase.capabilities.events, false);
  assert.equal(DatabaseConnectionBase.capabilities.auth, false);
  assert.equal(DatabaseConnectionBase.capabilities.ranges, false);
  assert.equal(DatabaseConnectionBase.capabilities.read, true);
  assert.equal(DatabaseConnectionBase.capabilities.write, true);

  assert.equal(DatabaseConnectionBase.batchAtomicity, 'atomic');

  // `withToken` is the opt-in auth surface; AccountStore gates no-auth drivers
  // on its absence, so the base must not define a no-op.
  assert.equal(typeof DatabaseConnectionBase.prototype.withToken, 'undefined');
});

test('DatabaseConnectionBase requires connect() to be implemented by a driver', async () => {
  class Bare extends DatabaseConnectionBase {}
  let db = new Bare();

  await assert.rejects(() => db.connect(), (error) => error instanceof Error && /connect/.test(error.message));
});

test('DatabaseConnectionBase document methods throw until a driver implements them', async () => {
  class Bare extends DatabaseConnectionBase {}
  let db = new Bare();

  for (let method of REQUIRED_METHODS.filter((name) => ![ 'connect', 'close' ].includes(name))) {
    await assert.rejects(() => db[method]('/x', {}), (error) => error instanceof Error, `${method} should be unimplemented`);
  }
});

test('DatabaseConnectionBase.getDatabaseDriverDescriptor reflects static metadata', async () => {
  let descriptor = await InMemoryDatabaseConnection.getDatabaseDriverDescriptor();

  assert.deepEqual(descriptor, {
    driverID: 'in-memory',
    displayName: 'In-Memory (reference)',
    description: 'Reference document store used to exercise the shared contract harness.',
    capabilities: InMemoryDatabaseConnection.capabilities,
    configFields: [],
    configKeys: [],
  });
});

test('DatabaseConnectionBase descriptor returns defensive copies of static metadata', async () => {
  let descriptor = await InMemoryDatabaseConnection.getDatabaseDriverDescriptor();

  assert.notEqual(descriptor.capabilities, InMemoryDatabaseConnection.capabilities);
  assert.notEqual(descriptor.configKeys, InMemoryDatabaseConnection.configKeys);

  descriptor.capabilities.read = false;
  assert.equal(InMemoryDatabaseConnection.capabilities.read, true, 'mutating a descriptor must not mutate the driver class');
});

test('DatabaseConnectionBase optional methods are gated on capabilities', async () => {
  // A driver that does not advertise `search` must not be asked to search.
  let db = new InMemoryDatabaseConnection();
  await db.connect();
  try {
    assert.equal(db.supports('search'), false);
    assert.equal(db.supports('read'), true);
    await assert.rejects(
      () => db.search({ path: '/kikx' }),
      (error) => error instanceof DatabaseError && error.code === 'capability_unsupported',
    );
  } finally {
    await db.close();
  }
});

test('DatabaseConnectionBase.requireCapability throws a typed error for a missing capability', () => {
  let db = new InMemoryDatabaseConnection();
  assert.throws(
    () => db.requireCapability('query'),
    (error) => error instanceof DatabaseError && error.code === 'capability_unsupported' && /query/.test(error.message),
  );
  assert.doesNotThrow(() => db.requireCapability('read'));
});

test('DatabaseConnectionBase hides the file-verb adapters a driver does not advertise', () => {
  let db = new InMemoryDatabaseConnection();

  assert.equal(db.supports('search'), false);
  assert.equal(db.supports('query'), false);
  assert.equal(db.supports('ranges'), false);
  assert.equal(typeof db.searchFiles, 'undefined');
  assert.equal(typeof db.queryFiles, 'undefined');
  assert.equal(typeof db.fetchFileRanges, 'undefined');

  // Only the legacy file-verb adapters are shadowed; the modern methods survive
  // so callers still get the typed capability error rather than a TypeError.
  assert.equal(typeof db.search, 'function');
  assert.equal(typeof db.query, 'function');
  assert.equal(typeof db.getRanges, 'function');
});

test('DatabaseConnectionBase exposes the file-verb adapters for advertised capabilities', () => {
  class CapableDriver extends DatabaseConnectionBase {
    static driverID = 'capable';
    static capabilities = {
      ...DatabaseConnectionBase.capabilities,
      search: true,
      query: true,
      ranges: true,
    };
  }

  let db = new CapableDriver();

  assert.equal(typeof db.searchFiles, 'function');
  assert.equal(typeof db.queryFiles, 'function');
  assert.equal(typeof db.fetchFileRanges, 'function');
});

test('DatabaseConnectionBase.configureIndexes is a no-op for drivers without an index', async () => {
  let db = new InMemoryDatabaseConnection();

  assert.equal(typeof db.configureIndexes, 'function');
  await assert.doesNotReject(() => db.configureIndexes([
    { path: '/kikx/.aeordb-config/indexes.json', body: { indexes: [] } },
  ]));
});

test('InMemoryDatabaseConnection stores raw text when options.raw is set', async () => {
  let db = new InMemoryDatabaseConnection();
  await db.connect();
  try {
    await db.put('/kikx/raw/note.txt', 'hello world', { raw: true });
    assert.equal(await db.get('/kikx/raw/note.txt', { raw: true }), 'hello world');
  } finally {
    await db.close();
  }
});

test('driver-contract harness gates capability-limited blocks on the driver class', () => {
  class LimitedDriver extends InMemoryDatabaseConnection {
    static driverID = 'limited';
    static capabilities = {
      ...InMemoryDatabaseConnection.capabilities,
      write: false,
      mergePatch: false,
      list: false,
      getMany: false,
    };
  }

  // Record block names without running bodies: a recording describe must not
  // execute the suite, so the factory is never invoked and no teardown needed.
  let names = [];
  runDatabaseContractSuite('limited', async () => new LimitedDriver(), {
    driverClass: LimitedDriver,
    describe: (name) => names.push(name),
  });

  for (let gated of [ 'put/get round-trips', 'delete() removes', 'merge() is RFC-7386', 'list() is recursive-glob', 'getMany() returns' ])
    assert.equal(names.some((name) => name.includes(gated)), false, `gated block must be absent: ${gated}`);

  for (let present of [ 'extends DatabaseConnectionBase', 'entries() streams', 'batch() applies operations' ])
    assert.equal(names.some((name) => name.includes(present)), true, `unconditional block must be present: ${present}`);
});

test('driver-contract harness refuses to run without a driver class', () => {
  assert.throws(
    () => runDatabaseContractSuite('missing-driving-class', async () => new InMemoryDatabaseConnection(), { describe: () => {} }),
    /driverClass/,
  );
});

// Positive control only: proves we do not over-gate. The limited-driver test is the real regression guard.
test('driver-contract harness registers gated blocks for a fully capable driver', () => {
  let names = [];
  runDatabaseContractSuite('in-memory-recording', async () => {
    let db = new InMemoryDatabaseConnection();
    await db.connect();
    return db;
  }, {
    driverClass: InMemoryDatabaseConnection,
    describe: (name) => names.push(name),
  });

  for (let present of [ 'put/get round-trips', 'list() is recursive-glob' ])
    assert.equal(names.some((name) => name.includes(present)), true, `capable block must be present: ${present}`);
});
