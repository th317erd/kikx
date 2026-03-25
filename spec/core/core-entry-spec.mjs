'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createKikxCore,
  KikxCore,
  CascadingContext,
  createContext,
  DEFAULT_CONFIG,
  mergeConfig,
} from '../../src/core/index.mjs';

import { AgentInterface }  from '../../src/core/plugins/agent-interface.mjs';
import { PluginInterface } from '../../src/core/plugin-loader/plugin-interface.mjs';

// =============================================================================
// createKikxCore + KikxCore
// =============================================================================
describe('createKikxCore', () => {
  let core;

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();

    core = null;
  });

  it('should export createKikxCore function', () => {
    assert.equal(typeof createKikxCore, 'function');
  });

  it('should export KikxCore class', () => {
    assert.equal(typeof KikxCore, 'function');
  });

  it('should return a KikxCore instance', () => {
    core = createKikxCore();
    assert.ok(core instanceof KikxCore);
  });

  it('should accept empty config', () => {
    core = createKikxCore();
    assert.ok(core);
    assert.equal(core.isStarted(), false);
  });

  it('should accept config overrides', () => {
    core = createKikxCore({ name: 'custom-kikx' });
    let config = core.getConfig();
    assert.equal(config.name, 'custom-kikx');
  });

  it('should merge config with defaults', () => {
    core = createKikxCore({ name: 'custom' });
    let config = core.getConfig();
    assert.equal(config.name, 'custom');
    assert.equal(config.version, DEFAULT_CONFIG.version);
    assert.ok(config.database);
    assert.equal(config.database.dialect, 'sqlite');
  });

  it('should deep merge nested config', () => {
    core = createKikxCore({
      database: { filename: '/tmp/test.db' },
    });

    let config = core.getConfig();
    assert.equal(config.database.filename, '/tmp/test.db');
    assert.equal(config.database.dialect, 'sqlite');
    assert.equal(config.database.emulateBigIntAutoIncrement, true);
  });
});

// =============================================================================
// KikxCore lifecycle
// =============================================================================
describe('KikxCore lifecycle', () => {
  let core;

  beforeEach(() => {
    core = createKikxCore();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should start and stop cleanly', async () => {
    assert.equal(core.isStarted(), false);

    await core.start();
    assert.equal(core.isStarted(), true);

    await core.stop();
    assert.equal(core.isStarted(), false);
  });

  it('should throw if started twice', async () => {
    await core.start();
    await assert.rejects(
      () => core.start(),
      { message: 'KikxCore is already started' },
    );
  });

  it('should allow stop when not started (no-op)', async () => {
    await core.stop(); // Should not throw
    assert.equal(core.isStarted(), false);
  });

  it('should allow start after stop', async () => {
    await core.start();
    await core.stop();
    await core.start();
    assert.equal(core.isStarted(), true);
  });

  it('should initialize database on start', async () => {
    await core.start();
    assert.ok(core.getConnection());
  });

  it('should close database on stop', async () => {
    await core.start();
    assert.ok(core.getConnection());
    await core.stop();
    assert.equal(core.getConnection(), null);
  });

  it('should have models object after start', async () => {
    await core.start();
    let models = core.getModels();
    assert.ok(models);
    assert.equal(typeof models, 'object');
  });
});

// =============================================================================
// KikxCore with custom models
// =============================================================================
describe('KikxCore with models', () => {
  let core;

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should register models from config array', async () => {
    let MythixORM = await import('mythix-orm');
    let { Model, Types } = MythixORM.default;

    class TestEntity extends Model {
      static fields = {
        id: {
          type:         Types.XID({ prefix: 'te_' }),
          defaultValue: Types.XID.Default.XID,
          allowNull:    false,
          primaryKey:   true,
        },
        name: {
          type:      Types.STRING(128),
          allowNull: false,
        },
      };
    }

    core = createKikxCore({ models: [ TestEntity ] });
    await core.start();

    let models = core.getModels();
    assert.ok(models.TestEntity);
  });

  it('should register models from config object', async () => {
    let MythixORM = await import('mythix-orm');
    let { Model, Types } = MythixORM.default;

    class Widget extends Model {
      static fields = {
        id: {
          type:         Types.XID({ prefix: 'wgt_' }),
          defaultValue: Types.XID.Default.XID,
          allowNull:    false,
          primaryKey:   true,
        },
        label: {
          type:      Types.STRING(64),
          allowNull: false,
        },
      };
    }

    core = createKikxCore({ models: { Widget } });
    await core.start();

    let models = core.getModels();
    assert.ok(models.Widget);
  });

  it('should create tables for registered models', async () => {
    let MythixORM = await import('mythix-orm');
    let { Model, Types } = MythixORM.default;

    class Item extends Model {
      static fields = {
        id: {
          type:         Types.XID({ prefix: 'itm_' }),
          defaultValue: Types.XID.Default.XID,
          allowNull:    false,
          primaryKey:   true,
        },
        title: {
          type:      Types.STRING(256),
          allowNull: false,
        },
      };
    }

    core = createKikxCore({ models: [ Item ] });
    await core.start();

    let { Item: BoundItem } = core.getModels();

    // Should be able to create and query
    let item = await BoundItem.create({ title: 'Test Item' });
    assert.ok(item.id);
    assert.equal(item.title, 'Test Item');

    let found = await BoundItem.where.title.EQ('Test Item').first();
    assert.ok(found);
    assert.equal(found.id, item.id);
  });

  it('should return model by name via getModel()', async () => {
    let MythixORM = await import('mythix-orm');
    let { Model, Types } = MythixORM.default;

    class Gadget extends Model {
      static fields = {
        id: {
          type:         Types.XID({ prefix: 'gdt_' }),
          defaultValue: Types.XID.Default.XID,
          allowNull:    false,
          primaryKey:   true,
        },
        value: {
          type:      Types.STRING(64),
          allowNull: true,
        },
      };
    }

    core = createKikxCore({ models: [ Gadget ] });
    await core.start();

    assert.ok(core.getModel('Gadget'));
    assert.equal(core.getModel('NonExistent'), null);
  });
});

// =============================================================================
// KikxCore context
// =============================================================================
describe('KikxCore context', () => {
  let core;

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should provide a CascadingContext', () => {
    core = createKikxCore();
    let context = core.getContext();
    assert.ok(context instanceof CascadingContext);
  });

  it('should store config values on context', () => {
    core = createKikxCore({ name: 'test-kikx' });
    let context = core.getContext();
    assert.equal(context.getProperty('name'), 'test-kikx');
  });

  it('should store core reference on context', () => {
    core = createKikxCore();
    let context = core.getContext();
    assert.equal(context.getProperty('core'), core);
  });

  it('should store models on context after start', async () => {
    core = createKikxCore();
    await core.start();
    let context = core.getContext();
    assert.ok(context.getProperty('models'));
  });

  it('should store connection on context after start', async () => {
    core = createKikxCore();
    await core.start();
    let context = core.getContext();
    assert.ok(context.getProperty('connection'));
  });
});

// =============================================================================
// KikxCore plugin loading (via PluginLoader)
// =============================================================================
describe('KikxCore plugin loading', () => {
  let core;

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should load plugins from config.plugins.modules on start', async () => {
    class TestAgent extends AgentInterface {
      static pluginID = 'test-agent';
    }

    core = createKikxCore({
      plugins: {
        modules: {
          'test-agent-plugin': {
            setup: (provide) => {
              provide(({ registry }) => {
                registry.registerAgentType('test-agent', TestAgent);
              });
            },
          },
        },
      },
    });

    await core.start();
    assert.equal(core.getAgentType('test-agent'), TestAgent);
  });

  it('should return null for unregistered agent type', async () => {
    core = createKikxCore();
    await core.start();
    assert.equal(core.getAgentType('nonexistent'), null);
  });

  it('should return null for getAgentType before start', () => {
    core = createKikxCore();
    assert.equal(core.getAgentType('anything'), null);
  });

  it('should call teardown on stop', async () => {
    let tornDown = false;

    core = createKikxCore({
      plugins: {
        modules: {
          'teardown-plugin': {
            setup: () => () => { tornDown = true; },
          },
        },
      },
    });

    await core.start();
    await core.stop();
    assert.equal(tornDown, true);
  });

  it('should skip disabled plugins', async () => {
    class TestAgent extends AgentInterface {
      static pluginID = 'disabled-agent';
    }

    core = createKikxCore({
      plugins: {
        disabled: ['skip-plugin'],
        modules: {
          'skip-plugin': {
            setup: (ctx) => {
              ctx.registerAgentType('skip-agent', TestAgent);
            },
          },
          'keep-plugin': {
            setup: () => {},
          },
        },
      },
    });

    await core.start();
    assert.equal(core.getAgentType('skip-agent'), null);
    assert.ok(core.getPluginLoader().isLoaded('keep-plugin'));
    assert.ok(!core.getPluginLoader().isLoaded('skip-plugin'));
  });

  it('should expose plugin registry via getPluginRegistry()', async () => {
    core = createKikxCore();
    await core.start();
    let registry = core.getPluginRegistry();
    assert.ok(registry);
    assert.equal(typeof registry.getAgentType, 'function');
  });

  it('should return null for getPluginRegistry before start', () => {
    core = createKikxCore();
    assert.equal(core.getPluginRegistry(), null);
  });

  it('should expose plugin loader via getPluginLoader()', async () => {
    core = createKikxCore();
    await core.start();
    assert.ok(core.getPluginLoader());
    assert.equal(typeof core.getPluginLoader().isLoaded, 'function');
  });

  it('should not have old skeleton methods (registerPlugin, getPlugin, getPlugins)', () => {
    core = createKikxCore();
    assert.equal(typeof core.registerPlugin, 'undefined');
    assert.equal(typeof core.getPlugin, 'undefined');
    assert.equal(typeof core.getPlugins, 'undefined');
  });

  it('should set pluginLoader and pluginRegistry on context', async () => {
    core = createKikxCore();
    await core.start();
    let context = core.getContext();
    assert.ok(context.getProperty('pluginLoader'));
    assert.ok(context.getProperty('pluginRegistry'));
  });

  it('should set permissionEngine on context after start', async () => {
    core = createKikxCore();
    await core.start();
    let context = core.getContext();
    assert.ok(context.getProperty('permissionEngine'));
  });

  it('should expose permissionEngine via getPermissionEngine()', async () => {
    core = createKikxCore();
    await core.start();
    assert.ok(core.getPermissionEngine());
    assert.equal(typeof core.getPermissionEngine().checkPermission, 'function');
  });

  it('should set hookRunner on context after start', async () => {
    core = createKikxCore();
    await core.start();
    let context = core.getContext();
    let hookRunner = context.getProperty('hookRunner');
    assert.ok(hookRunner);
    assert.equal(typeof hookRunner.run, 'function');
  });

  it('should add plugin directories from KIKX_PLUGIN_PATHS env var', async () => {
    let originalEnv = process.env.KIKX_PLUGIN_PATHS;

    try {
      process.env.KIKX_PLUGIN_PATHS = '/tmp/nonexistent-plugins-a:/tmp/nonexistent-plugins-b';

      core = createKikxCore();
      await core.start();

      // Should not throw even though paths don't exist
      assert.ok(core.isStarted());
    } finally {
      if (originalEnv === undefined)
        delete process.env.KIKX_PLUGIN_PATHS;
      else
        process.env.KIKX_PLUGIN_PATHS = originalEnv;
    }
  });

  it('should combine config paths and env var paths', async () => {
    let originalEnv = process.env.KIKX_PLUGIN_PATHS;

    try {
      process.env.KIKX_PLUGIN_PATHS = '/tmp/env-plugin-path';

      core = createKikxCore({
        plugins: {
          paths: ['/tmp/config-plugin-path'],
        },
      });

      await core.start();
      assert.ok(core.isStarted());
    } finally {
      if (originalEnv === undefined)
        delete process.env.KIKX_PLUGIN_PATHS;
      else
        process.env.KIKX_PLUGIN_PATHS = originalEnv;
    }
  });

  it('should handle empty KIKX_PLUGIN_PATHS gracefully', async () => {
    let originalEnv = process.env.KIKX_PLUGIN_PATHS;

    try {
      process.env.KIKX_PLUGIN_PATHS = '';

      core = createKikxCore();
      await core.start();
      assert.ok(core.isStarted());
    } finally {
      if (originalEnv === undefined)
        delete process.env.KIKX_PLUGIN_PATHS;
      else
        process.env.KIKX_PLUGIN_PATHS = originalEnv;
    }
  });
});

// =============================================================================
// KikxCore V2 model fields (Phase 3 additions)
// =============================================================================
describe('KikxCore V2 model fields', () => {
  let core;

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should have dmSummary field on Agent model', async () => {
    core = createKikxCore();
    await core.start();

    let { Organization, Agent } = core.getModels();
    let org   = await Organization.create({ name: 'Test Org' });
    let agent = await Agent.create({
      organizationID: org.id,
      name:           'test-dm-agent',
      pluginID:       'test-agent',
      dmSummary:      'Always respond in JSON',
    });

    let found = await Agent.where.id.EQ(agent.id).first();
    assert.equal(found.dmSummary, 'Always respond in JSON');
  });

  it('should have type field on Session model with default value', async () => {
    core = createKikxCore();
    await core.start();

    let { Organization, Session } = core.getModels();
    let org     = await Organization.create({ name: 'Test Org' });
    let session = await Session.create({ organizationID: org.id, name: 'Test Session' });

    assert.equal(session.type, 'chat');
  });

  it('should support dm type on Session model', async () => {
    core = createKikxCore();
    await core.start();

    let { Organization, Agent, Session } = core.getModels();
    let org   = await Organization.create({ name: 'Test Org' });
    let agent = await Agent.create({ organizationID: org.id, name: 'test-agent', pluginID: 'test' });

    let session = await Session.create({
      organizationID: org.id,
      name:           'DM: test-agent',
      type:           'dm',
      dmAgentID:      agent.id,
    });

    let found = await Session.where.id.EQ(session.id).first();
    assert.equal(found.type, 'dm');
    assert.equal(found.dmAgentID, agent.id);
  });

  it('should allow null dmAgentID on Session model', async () => {
    core = createKikxCore();
    await core.start();

    let { Organization, Session } = core.getModels();
    let org     = await Organization.create({ name: 'Test Org' });
    let session = await Session.create({ organizationID: org.id, name: 'Regular' });

    // Nullable fields not explicitly set may be undefined in Mythix ORM
    assert.equal(session.dmAgentID == null, true);
  });
});

// =============================================================================
// CascadingContext
// =============================================================================
describe('CascadingContext', () => {
  it('should set and get simple properties', () => {
    let context = new CascadingContext();
    context.setProperty('name', 'kikx');
    assert.equal(context.getProperty('name'), 'kikx');
  });

  it('should support dot-notation for nested properties', () => {
    let context = new CascadingContext();
    context.setProperty('database.dialect', 'sqlite');
    assert.equal(context.getProperty('database.dialect'), 'sqlite');
  });

  it('should support array index notation', () => {
    let context = new CascadingContext();
    context.setProperty('items', [ 'a', 'b', 'c' ]);
    assert.equal(context.getProperty('items[1]'), 'b');
  });

  it('should return undefined for missing properties', () => {
    let context = new CascadingContext();
    assert.equal(context.getProperty('missing'), undefined);
  });

  it('should accept initial data', () => {
    let context = new CascadingContext({ name: 'kikx', version: '2.0' });
    assert.equal(context.getProperty('name'), 'kikx');
    assert.equal(context.getProperty('version'), '2.0');
  });

  it('should inherit properties from parent via prototype chain', () => {
    let parent = new CascadingContext({ name: 'parent-value' });
    let child  = parent.createChild();
    assert.equal(child.getProperty('name'), 'parent-value');
  });

  it('should allow child to override parent properties', () => {
    let parent = new CascadingContext({ name: 'parent' });
    let child  = parent.createChild({ name: 'child' });
    assert.equal(child.getProperty('name'), 'child');
    assert.equal(parent.getProperty('name'), 'parent');
  });

  it('should not mutate parent when child sets a property', () => {
    let parent = new CascadingContext({ shared: 'original' });
    let child  = parent.createChild();
    child.setProperty('shared', 'modified');
    assert.equal(parent.getProperty('shared'), 'original');
    assert.equal(child.getProperty('shared'), 'modified');
  });

  it('should support multi-level inheritance', () => {
    let root    = new CascadingContext({ level: 'root' });
    let middle  = root.createChild({ level: 'middle' });
    let leaf    = middle.createChild();

    // Leaf inherits middle's override
    assert.equal(leaf.getProperty('level'), 'middle');
  });

  it('should distinguish own vs inherited properties', () => {
    let parent = new CascadingContext({ fromParent: true });
    let child  = parent.createChild({ fromChild: true });

    assert.equal(child.hasProperty('fromParent'), true);
    assert.equal(child.hasProperty('fromChild'), true);
    assert.equal(child.hasOwnProperty('fromParent'), false);
    assert.equal(child.hasOwnProperty('fromChild'), true);
  });

  it('should delete own properties without affecting parent', () => {
    let parent = new CascadingContext({ key: 'parent-value' });
    let child  = parent.createChild({ key: 'child-value' });

    child.deleteProperty('key');
    // After deleting own property, inherited value shows through
    assert.equal(child.getProperty('key'), 'parent-value');
    assert.equal(parent.getProperty('key'), 'parent-value');
  });

  it('should return own keys only via getOwnKeys()', () => {
    let parent = new CascadingContext({ parentKey: 1 });
    let child  = parent.createChild({ childKey: 2 });

    let ownKeys = child.getOwnKeys();
    assert.ok(ownKeys.includes('childKey'));
    assert.ok(!ownKeys.includes('parentKey'));
  });

  it('should return all keys including inherited via getAllKeys()', () => {
    let parent = new CascadingContext({ parentKey: 1 });
    let child  = parent.createChild({ childKey: 2 });

    let allKeys = child.getAllKeys();
    assert.ok(allKeys.includes('childKey'));
    assert.ok(allKeys.includes('parentKey'));
  });

  it('should track parent-child relationships', () => {
    let parent = new CascadingContext();
    let child  = parent.createChild();

    assert.equal(child.getParent(), parent);
    assert.ok(parent.getChildren().includes(child));
  });

  it('should detach child from parent', () => {
    let parent = new CascadingContext();
    let child  = parent.createChild();

    child.detach();
    assert.equal(child.getParent(), null);
    assert.equal(parent.getChildren().length, 0);
  });

  it('should serialize own properties to JSON', () => {
    let parent = new CascadingContext({ inherited: true });
    let child  = parent.createChild({ own: true });

    let json = child.toJSON();
    assert.deepEqual(json, { own: true });
  });

  it('should not mutate parent when setting nested properties', () => {
    let parent = new CascadingContext({ config: { name: 'parent', port: 8080 } });
    let child  = parent.createChild();

    child.setProperty('config.name', 'child');
    assert.equal(parent.getProperty('config.name'), 'parent');
    assert.equal(child.getProperty('config.name'), 'child');
  });
});

// =============================================================================
// mergeConfig
// =============================================================================
describe('mergeConfig', () => {
  it('should return defaults when no overrides', () => {
    let result = mergeConfig({ a: 1, b: 2 }, null);
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  it('should override simple values', () => {
    let result = mergeConfig({ a: 1 }, { a: 2 });
    assert.equal(result.a, 2);
  });

  it('should keep defaults for unspecified keys', () => {
    let result = mergeConfig({ a: 1, b: 2 }, { a: 10 });
    assert.equal(result.a, 10);
    assert.equal(result.b, 2);
  });

  it('should deep merge plain objects', () => {
    let result = mergeConfig(
      { db: { dialect: 'sqlite', filename: ':memory:' } },
      { db: { filename: '/tmp/test.db' } },
    );
    assert.equal(result.db.dialect, 'sqlite');
    assert.equal(result.db.filename, '/tmp/test.db');
  });

  it('should not deep merge arrays', () => {
    let result = mergeConfig(
      { items: [ 1, 2, 3 ] },
      { items: [ 4, 5 ] },
    );
    assert.deepEqual(result.items, [ 4, 5 ]);
  });

  it('should add new keys from overrides', () => {
    let result = mergeConfig({ a: 1 }, { b: 2 });
    assert.equal(result.a, 1);
    assert.equal(result.b, 2);
  });

  it('should handle undefined overrides as absent', () => {
    let result = mergeConfig({ a: 1 }, { a: undefined });
    assert.equal(result.a, 1);
  });
});

// =============================================================================
// DEFAULT_CONFIG
// =============================================================================
describe('DEFAULT_CONFIG', () => {
  it('should have name and version', () => {
    assert.equal(DEFAULT_CONFIG.name, 'kikx');
    assert.ok(DEFAULT_CONFIG.version);
  });

  it('should default to sqlite in-memory', () => {
    assert.equal(DEFAULT_CONFIG.database.dialect, 'sqlite');
    assert.equal(DEFAULT_CONFIG.database.filename, ':memory:');
  });

  it('should have plugins config', () => {
    assert.ok(Array.isArray(DEFAULT_CONFIG.plugins.paths));
    assert.ok(Array.isArray(DEFAULT_CONFIG.plugins.disabled));
  });

  it('should detect dev mode from NODE_ENV', () => {
    assert.equal(typeof DEFAULT_CONFIG.devMode, 'boolean');
  });
});
