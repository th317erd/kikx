'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                       from 'node:assert/strict';
import { PluginRegistry }           from '../../../src/core/plugin-loader/registry.mjs';

// =============================================================================
// Selector Registry
// =============================================================================

describe('PluginRegistry — Selectors', () => {
  let registry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  // ---- registerSelector adds entry ----

  it('should add an entry to the selectors list', () => {
    class FakePlugin {}
    registry.registerSelector('commit:*', FakePlugin, 'my-plugin');

    let selectors = registry.getSelectors();
    assert.equal(selectors.length, 1);
    assert.equal(selectors[0].selector, 'commit:*');
    assert.equal(selectors[0].PluginClass, FakePlugin);
    assert.equal(selectors[0].pluginName, 'my-plugin');
  });

  // ---- getSelectors returns a copy ----

  it('should return a copy from getSelectors (not the internal array)', () => {
    class FakePlugin {}
    registry.registerSelector('commit:*', FakePlugin, 'my-plugin');

    let selectors = registry.getSelectors();
    selectors.push({ selector: 'rogue', PluginClass: class {}, pluginName: null });

    // Internal array should still have only 1 entry
    assert.equal(registry.getSelectors().length, 1);
  });

  // ---- Multiple selectors ----

  it('should support registering multiple selectors', () => {
    class PluginA {}
    class PluginB {}
    class PluginC {}

    registry.registerSelector('commit:*', PluginA, 'plugin-a');
    registry.registerSelector('message:created', PluginB, 'plugin-b');
    registry.registerSelector('frame:updated', PluginC, 'plugin-c');

    let selectors = registry.getSelectors();
    assert.equal(selectors.length, 3);
    assert.equal(selectors[0].selector, 'commit:*');
    assert.equal(selectors[1].selector, 'message:created');
    assert.equal(selectors[2].selector, 'frame:updated');
  });

  // ---- String selector ----

  it('should work with a string selector', () => {
    class FakePlugin {}
    registry.registerSelector('commit:created', FakePlugin, 'str-plugin');

    let selectors = registry.getSelectors();
    assert.equal(typeof selectors[0].selector, 'string');
    assert.equal(selectors[0].selector, 'commit:created');
  });

  // ---- Function selector ----

  it('should work with a function selector', () => {
    class FakePlugin {}
    let matchFn = (event) => event.type === 'commit';
    registry.registerSelector(matchFn, FakePlugin, 'fn-plugin');

    let selectors = registry.getSelectors();
    assert.equal(typeof selectors[0].selector, 'function');
    assert.equal(selectors[0].selector, matchFn);
  });

  // ---- Throws on null/undefined selector ----

  it('should throw on null selector', () => {
    class FakePlugin {}
    assert.throws(
      () => registry.registerSelector(null, FakePlugin, 'bad'),
      { message: 'Selector must be a non-empty string or function' },
    );
  });

  it('should throw on undefined selector', () => {
    class FakePlugin {}
    assert.throws(
      () => registry.registerSelector(undefined, FakePlugin, 'bad'),
      { message: 'Selector must be a non-empty string or function' },
    );
  });

  it('should throw on empty string selector', () => {
    class FakePlugin {}
    assert.throws(
      () => registry.registerSelector('', FakePlugin, 'bad'),
      { message: 'Selector must be a non-empty string or function' },
    );
  });

  // ---- Throws on non-function PluginClass ----

  it('should throw when PluginClass is null', () => {
    assert.throws(
      () => registry.registerSelector('commit:*', null, 'bad'),
      { message: 'PluginClass must be a constructor function' },
    );
  });

  it('should throw when PluginClass is undefined', () => {
    assert.throws(
      () => registry.registerSelector('commit:*', undefined, 'bad'),
      { message: 'PluginClass must be a constructor function' },
    );
  });

  it('should throw when PluginClass is a string', () => {
    assert.throws(
      () => registry.registerSelector('commit:*', 'NotAClass', 'bad'),
      { message: 'PluginClass must be a constructor function' },
    );
  });

  it('should throw when PluginClass is a number', () => {
    assert.throws(
      () => registry.registerSelector('commit:*', 42, 'bad'),
      { message: 'PluginClass must be a constructor function' },
    );
  });

  it('should throw when PluginClass is a plain object', () => {
    assert.throws(
      () => registry.registerSelector('commit:*', {}, 'bad'),
      { message: 'PluginClass must be a constructor function' },
    );
  });

  // ---- pluginName stored when provided ----

  it('should store pluginName when provided', () => {
    class FakePlugin {}
    registry.registerSelector('commit:*', FakePlugin, 'my-plugin');

    let selectors = registry.getSelectors();
    assert.equal(selectors[0].pluginName, 'my-plugin');
  });

  // ---- pluginName defaults to null ----

  it('should default pluginName to null when not provided', () => {
    class FakePlugin {}
    registry.registerSelector('commit:*', FakePlugin);

    let selectors = registry.getSelectors();
    assert.equal(selectors[0].pluginName, null);
  });

  it('should default pluginName to null when explicitly passed undefined', () => {
    class FakePlugin {}
    registry.registerSelector('commit:*', FakePlugin, undefined);

    let selectors = registry.getSelectors();
    assert.equal(selectors[0].pluginName, null);
  });
});
