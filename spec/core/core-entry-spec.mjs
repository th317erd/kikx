'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createHeroCore,
  HeroCore,
  CascadingContext,
  createContext,
  DEFAULT_CONFIG,
  mergeConfig,
} from '../../src/core/index.mjs';

// =============================================================================
// createHeroCore + HeroCore
// =============================================================================
describe('createHeroCore', () => {
  let core;

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();

    core = null;
  });

  it('should export createHeroCore function', () => {
    assert.equal(typeof createHeroCore, 'function');
  });

  it('should export HeroCore class', () => {
    assert.equal(typeof HeroCore, 'function');
  });

  it('should return a HeroCore instance', () => {
    core = createHeroCore();
    assert.ok(core instanceof HeroCore);
  });

  it('should accept empty config', () => {
    core = createHeroCore();
    assert.ok(core);
    assert.equal(core.isStarted(), false);
  });

  it('should accept config overrides', () => {
    core = createHeroCore({ name: 'custom-hero' });
    let config = core.getConfig();
    assert.equal(config.name, 'custom-hero');
  });

  it('should merge config with defaults', () => {
    core = createHeroCore({ name: 'custom' });
    let config = core.getConfig();
    assert.equal(config.name, 'custom');
    assert.equal(config.version, DEFAULT_CONFIG.version);
    assert.ok(config.database);
    assert.equal(config.database.dialect, 'sqlite');
  });

  it('should deep merge nested config', () => {
    core = createHeroCore({
      database: { filename: '/tmp/test.db' },
    });

    let config = core.getConfig();
    assert.equal(config.database.filename, '/tmp/test.db');
    assert.equal(config.database.dialect, 'sqlite');
    assert.equal(config.database.emulateBigIntAutoIncrement, true);
  });
});

// =============================================================================
// HeroCore lifecycle
// =============================================================================
describe('HeroCore lifecycle', () => {
  let core;

  beforeEach(() => {
    core = createHeroCore();
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
      { message: 'HeroCore is already started' },
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
// HeroCore with custom models
// =============================================================================
describe('HeroCore with models', () => {
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

    core = createHeroCore({ models: [ TestEntity ] });
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

    core = createHeroCore({ models: { Widget } });
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

    core = createHeroCore({ models: [ Item ] });
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

    core = createHeroCore({ models: [ Gadget ] });
    await core.start();

    assert.ok(core.getModel('Gadget'));
    assert.equal(core.getModel('NonExistent'), null);
  });
});

// =============================================================================
// HeroCore context
// =============================================================================
describe('HeroCore context', () => {
  let core;

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should provide a CascadingContext', () => {
    core = createHeroCore();
    let context = core.getContext();
    assert.ok(context instanceof CascadingContext);
  });

  it('should store config values on context', () => {
    core = createHeroCore({ name: 'test-hero' });
    let context = core.getContext();
    assert.equal(context.getProperty('name'), 'test-hero');
  });

  it('should store core reference on context', () => {
    core = createHeroCore();
    let context = core.getContext();
    assert.equal(context.getProperty('core'), core);
  });

  it('should store models on context after start', async () => {
    core = createHeroCore();
    await core.start();
    let context = core.getContext();
    assert.ok(context.getProperty('models'));
  });

  it('should store connection on context after start', async () => {
    core = createHeroCore();
    await core.start();
    let context = core.getContext();
    assert.ok(context.getProperty('connection'));
  });
});

// =============================================================================
// HeroCore plugin management (skeleton)
// =============================================================================
describe('HeroCore plugin management', () => {
  let core;

  beforeEach(() => {
    core = createHeroCore();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should register a plugin', () => {
    let teardown = () => {};
    core.registerPlugin('test-plugin', { teardown });
    assert.ok(core.getPlugin('test-plugin'));
    assert.equal(core.getPlugin('test-plugin').teardown, teardown);
  });

  it('should return null for unknown plugin', () => {
    assert.equal(core.getPlugin('nonexistent'), null);
  });

  it('should override plugin with warning', () => {
    let warnings = [];
    let originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      core.registerPlugin('dupe', { teardown: () => {} });
      core.registerPlugin('dupe', { teardown: () => {} });
      assert.ok(warnings.some((w) => w.includes('overridden')));
    } finally {
      console.warn = originalWarn;
    }
  });

  it('should call teardown on stop', async () => {
    let tornDown = false;

    await core.start();
    core.registerPlugin('lifecycle-test', {
      teardown: () => { tornDown = true; },
    });

    await core.stop();
    assert.equal(tornDown, true);
  });

  it('should teardown plugins in reverse registration order', async () => {
    let order = [];

    await core.start();
    core.registerPlugin('first', { teardown: () => order.push('first') });
    core.registerPlugin('second', { teardown: () => order.push('second') });
    core.registerPlugin('third', { teardown: () => order.push('third') });

    await core.stop();
    assert.deepEqual(order, [ 'third', 'second', 'first' ]);
  });

  it('should return all plugins via getPlugins()', () => {
    core.registerPlugin('a', { teardown: () => {} });
    core.registerPlugin('b', { teardown: () => {} });

    let plugins = core.getPlugins();
    assert.equal(plugins.size, 2);
    assert.ok(plugins.has('a'));
    assert.ok(plugins.has('b'));
  });
});

// =============================================================================
// CascadingContext
// =============================================================================
describe('CascadingContext', () => {
  it('should set and get simple properties', () => {
    let context = new CascadingContext();
    context.setProperty('name', 'hero');
    assert.equal(context.getProperty('name'), 'hero');
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
    let context = new CascadingContext({ name: 'hero', version: '2.0' });
    assert.equal(context.getProperty('name'), 'hero');
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
    assert.equal(DEFAULT_CONFIG.name, 'hero');
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
