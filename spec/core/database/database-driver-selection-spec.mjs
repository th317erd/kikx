'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import {
  isAeorDBDriver,
  resolveConfiguredDriverID,
  resolveDatabaseDriver,
} from '../../../src/core/database/database-driver-selection.mjs';
import { PluginRegistry } from '../../../src/core/plugins/index.mjs';
import {
  DATABASE_DRIVER_PATH,
  KIKX_DATABASE_DRIVER_PATH,
} from '../../../src/core/config/config-paths.mjs';

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

function createFakeConfig(map = {}) {
  return { get: async (propertyPath) => map[propertyPath] };
}

test('resolveConfiguredDriverID prefers the canonical driver path', async () => {
  let config = createFakeConfig({
    [DATABASE_DRIVER_PATH]: 'postgresql',
    [KIKX_DATABASE_DRIVER_PATH]: 'sqlite',
  });
  assert.equal(await resolveConfiguredDriverID(config, 'aeordb'), 'postgresql');
});

test('resolveConfiguredDriverID falls back to the alias when the canonical path is absent', async () => {
  let config = createFakeConfig({ [KIKX_DATABASE_DRIVER_PATH]: 'sqlite' });
  assert.equal(await resolveConfiguredDriverID(config, 'aeordb'), 'sqlite');
});

test('resolveConfiguredDriverID returns the fallback when both paths are absent', async () => {
  assert.equal(await resolveConfiguredDriverID(createFakeConfig(), 'postgresql'), 'postgresql');
});

test('resolveConfiguredDriverID defaults the fallback to aeordb', async () => {
  assert.equal(await resolveConfiguredDriverID(createFakeConfig()), 'aeordb');
});

test('resolveConfiguredDriverID treats an empty canonical value as absent', async () => {
  let config = createFakeConfig({
    [DATABASE_DRIVER_PATH]: '',
    [KIKX_DATABASE_DRIVER_PATH]: 'sqlite',
  });
  assert.equal(await resolveConfiguredDriverID(config, 'aeordb'), 'sqlite');
});

test('resolveConfiguredDriverID returns a plugin property-path unchanged', async () => {
  let config = createFakeConfig({
    [DATABASE_DRIVER_PATH]: '/org/aeor/kikx/plugins/database/postgresql@0.4.5',
  });
  assert.equal(
    await resolveConfiguredDriverID(config, 'aeordb'),
    '/org/aeor/kikx/plugins/database/postgresql@0.4.5',
  );
});

test('resolveConfiguredDriverID returns the fallback when config is null', async () => {
  assert.equal(await resolveConfiguredDriverID(null, 'sqlite'), 'sqlite');
});

test('resolveConfiguredDriverID returns the fallback when config is undefined', async () => {
  assert.equal(await resolveConfiguredDriverID(undefined, 'sqlite'), 'sqlite');
});

test('isAeorDBDriver accepts aeordb in any case and with surrounding whitespace', () => {
  assert.equal(isAeorDBDriver('aeordb'), true);
  assert.equal(isAeorDBDriver('AeorDB'), true);
  assert.equal(isAeorDBDriver('  aeordb  '), true);
});

test('isAeorDBDriver rejects other drivers, plugin property-paths and empty values', () => {
  assert.equal(isAeorDBDriver('postgresql'), false);
  assert.equal(isAeorDBDriver('sqlite'), false);
  assert.equal(isAeorDBDriver('/org/aeor/kikx/plugins/database/postgresql@0.4.5'), false);
  assert.equal(isAeorDBDriver(''), false);
  assert.equal(isAeorDBDriver(null), false);
  assert.equal(isAeorDBDriver(undefined), false);
});

test('isAeorDBDriver matches an AeorDB plugin property-path, mirroring resolveDatabaseDriver', () => {
  assert.equal(isAeorDBDriver('/org/aeor/kikx/plugins/database/aeordb@0.9.5'), true);
  assert.equal(isAeorDBDriver('aeordb@0.9.5'), true);
});
