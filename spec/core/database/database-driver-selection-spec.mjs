'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { resolveDatabaseDriver } from '../../../src/core/database/database-driver-selection.mjs';
import { PluginRegistry } from '../../../src/core/plugins/index.mjs';

class AeorDriver extends DatabaseConnectionBase {
  static driverID = 'aeordb';
}

class PostgresDriver extends DatabaseConnectionBase {
  static driverID = 'postgresql';
}

function createRegistry() {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerDatabaseDriver('aeordb', AeorDriver);
  registry.registerDatabaseDriver('postgresql', PostgresDriver);
  return registry;
}

test('resolveDatabaseDriver resolves a bare driver id', () => {
  let resolved = resolveDatabaseDriver(createRegistry(), 'postgresql');
  assert.equal(resolved.driverID, 'postgresql');
  assert.equal(resolved.DriverClass, PostgresDriver);
});

test('resolveDatabaseDriver resolves a plugin property-path value to its driver id', () => {
  let resolved = resolveDatabaseDriver(
    createRegistry(),
    '/org/aeor/kikx/plugins/database/postgresql@0.4.5',
  );
  assert.equal(resolved.driverID, 'postgresql');
  assert.equal(resolved.DriverClass, PostgresDriver);
});

test('resolveDatabaseDriver defaults to aeordb when nothing is requested', () => {
  let resolved = resolveDatabaseDriver(createRegistry(), undefined);
  assert.equal(resolved.driverID, 'aeordb');
  assert.equal(resolved.DriverClass, AeorDriver);
});

test('resolveDatabaseDriver throws database_driver_unknown for an unregistered driver', () => {
  assert.throws(
    () => resolveDatabaseDriver(createRegistry(), 'mysql'),
    (error) => error.code === 'database_driver_unknown' && /Unknown database driver/.test(error.message),
  );
});
