'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { ClassRegistry } from '../../../src/core/plugins/class-registry.mjs';
import { PluginRegistry } from '../../../src/core/plugins/plugin-registry.mjs';

test('ClassRegistry registers a named class under its own name', () => {
  let registry = new ClassRegistry();
  class MyTool {}
  registry.registerClass(MyTool);
  assert.equal(registry.getClass('MyTool'), MyTool);
});

test('ClassRegistry registers under an explicit string key', () => {
  let registry = new ClassRegistry();
  class EnhancedRouter {}
  registry.registerClass('FrameRouter', EnhancedRouter);
  assert.equal(registry.getClass('FrameRouter'), EnhancedRouter);
});

test('ClassRegistry getClass returns the top of the stack (latest wins)', () => {
  let registry = new ClassRegistry();
  class Base {}
  class Override {}
  registry.registerClass('Thing', Base);
  registry.registerClass('Thing', Override);
  assert.equal(registry.getClass('Thing'), Override);
});

test('ClassRegistry getClassAtIndex exposes the whole override chain', () => {
  let registry = new ClassRegistry();
  class Base {}
  class Mid {}
  class Top {}
  registry.registerClass('Thing', Base);
  registry.registerClass('Thing', Mid);
  registry.registerClass('Thing', Top);

  assert.equal(registry.getClassAtIndex('Thing', 0), Base);
  assert.equal(registry.getClassAtIndex('Thing', 1), Mid);
  assert.equal(registry.getClassAtIndex('Thing', 2), Top);
  assert.equal(registry.getClassAtIndex('Thing', 3), null);
});

test('ClassRegistry hasClass and getRegisteredKeys report registrations', () => {
  let registry = new ClassRegistry();
  class Alpha {}
  class Beta {}
  registry.registerClass(Alpha);
  registry.registerClass(Beta);

  assert.equal(registry.hasClass('Alpha'), true);
  assert.equal(registry.hasClass('Missing'), false);
  assert.deepEqual(registry.getRegisteredKeys().sort(), [ 'Alpha', 'Beta' ]);
});

test('ClassRegistry ignores a duplicate registration of the top class', () => {
  let registry = new ClassRegistry();
  class Only {}
  registry.registerClass('Thing', Only);
  let version = registry.version;
  registry.registerClass('Thing', Only);
  assert.equal(registry.version, version);
  assert.equal(registry.getClass('Thing'), Only);
});

test('ClassRegistry unregisterPlugin pops that plugin and reveals the layer below', () => {
  let registry = new ClassRegistry();
  class Core {}
  class PluginOverride {}
  registry.registerClass('Router', Core, { pluginName: 'core' });
  registry.registerClass('Router', PluginOverride, { pluginName: 'analytics' });
  assert.equal(registry.getClass('Router'), PluginOverride);

  registry.unregisterPlugin('analytics');
  assert.equal(registry.getClass('Router'), Core);
  assert.equal(registry.hasClass('Router'), true);

  registry.unregisterPlugin('core');
  assert.equal(registry.getClass('Router'), null);
  assert.equal(registry.hasClass('Router'), false);
});

test('ClassRegistry version changes on registration and unregister', () => {
  let registry = new ClassRegistry();
  assert.equal(registry.version, 0);
  class Foo {}
  registry.registerClass('Foo', Foo, { pluginName: 'p' });
  assert.equal(registry.version, 1);
  registry.unregisterPlugin('p');
  assert.equal(registry.version, 2);
});

test('ClassRegistry validates its inputs', () => {
  let registry = new ClassRegistry();
  assert.throws(() => registry.registerClass(null), /first argument/);
  assert.throws(() => registry.registerClass('Key', 42), /must be a function/);
  assert.throws(() => registry.registerClass(() => {}), /must have a name/);
});

test('PluginRegistry inherits the universal class registry', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  class Base {}
  class Override {}
  registry.registerClass('FrameRouter', Base, { pluginName: 'core' });
  registry.registerClass('FrameRouter', Override, { pluginName: 'plugin-x' });
  assert.equal(registry.getClass('FrameRouter'), Override);

  registry.unregisterPlugin('plugin-x');
  assert.equal(registry.getClass('FrameRouter'), Base);
});
