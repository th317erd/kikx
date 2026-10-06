'use strict';

// PluginRegistry gains a plural-capable database-driver registry, mirroring
// agent providers: many drivers can be registered, one is selected by config
// later. Drivers must extend DatabaseConnectionBase.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { PluginRegistry } from '../../../src/core/plugins/index.mjs';

class FakeDriver extends DatabaseConnectionBase {
  static driverID = 'fake';
  static displayName = 'Fake Driver';
  static description = 'A fake driver used by the registry spec.';
  static capabilities = { ...DatabaseConnectionBase.capabilities };
  static configFields = [
    { name: 'hostname', required: true },
  ];
  static configKeys = [ '/org/aeor/kikx/database/config/hostname' ];
}

class OtherDriver extends DatabaseConnectionBase {
  static driverID = 'other';
  static displayName = 'Other Driver';
  static description = '';
  static capabilities = { ...DatabaseConnectionBase.capabilities };
}

test('PluginRegistry registers and retrieves database drivers by driverID', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registry.registerDatabaseDriver('fake', FakeDriver);

  assert.equal(registry.getDatabaseDriver('fake'), FakeDriver);
  assert.equal(registry.getDatabaseDriver('missing'), null);
  assert.equal(registry.getDatabaseDrivers().get('fake'), FakeDriver);
});

test('PluginRegistry rejects a database driver that does not extend DatabaseConnectionBase', () => {
  let registry = new PluginRegistry();

  assert.throws(
    () => registry.registerDatabaseDriver('bad', class BadDriver {}),
    /must extend DatabaseConnectionBase/,
  );
});

test('PluginRegistry rejects an empty database driver ID', () => {
  let registry = new PluginRegistry();

  assert.throws(() => registry.registerDatabaseDriver('', FakeDriver), TypeError);
  assert.throws(() => registry.registerDatabaseDriver(null, FakeDriver), TypeError);
});

test('PluginRegistry warns when a driver ID is overridden', () => {
  let warnings = [];
  let registry = new PluginRegistry({ logger: { warn(message) { warnings.push(message); } } });

  registry.registerDatabaseDriver('fake', FakeDriver);
  registry.registerDatabaseDriver('fake', OtherDriver);

  assert.equal(registry.getDatabaseDriver('fake'), OtherDriver);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fake/);
  assert.match(warnings[0], /overridden/i);
});

test('PluginRegistry lists database driver descriptors without instantiating', async () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerDatabaseDriver('fake', FakeDriver);
  registry.registerDatabaseDriver('other', OtherDriver);

  let descriptors = await registry.listDatabaseDriverDescriptors();

  assert.equal(descriptors.length, 2);
  assert.deepEqual(descriptors[0], {
    driverID: 'fake',
    displayName: 'Fake Driver',
    description: 'A fake driver used by the registry spec.',
    capabilities: FakeDriver.capabilities,
    configFields: [
      {
        name: 'hostname',
        label: 'hostname',
        type: 'text',
        required: true,
        secret: false,
        defaultValue: undefined,
        options: undefined,
        help: '',
      },
    ],
    configKeys: [ '/org/aeor/kikx/database/config/hostname' ],
  });
  assert.equal(descriptors[1].driverID, 'other');
});

test('PluginRegistry registers the DatabaseConnectionBase core class', async () => {
  let { registerCoreClasses } = await import('../../../src/core/plugins/core-classes.mjs');
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registerCoreClasses(registry);

  assert.equal(registry.getClass('DatabaseConnectionBase'), DatabaseConnectionBase);
});
