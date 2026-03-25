'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ClassRegistry } from '../../src/core/class-registry.mjs';

// =============================================================================
// ClassRegistry — Universal Stack-Based Class Registry
// =============================================================================

describe('ClassRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new ClassRegistry();
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe('registerClass() — Pattern 1: class directly', () => {
    it('registers a named class using its name as the key', () => {
      class MyTool {}
      registry.registerClass(MyTool);
      assert.equal(registry.getClass('MyTool'), MyTool);
    });
  });

  describe('registerClass() — Pattern 2: key + classRef', () => {
    it('registers a class under an explicit string key', () => {
      class EnhancedRouter {}
      registry.registerClass('FrameRouter', EnhancedRouter);
      assert.equal(registry.getClass('FrameRouter'), EnhancedRouter);
    });
  });

  describe('registerClass() — Pattern 3: class directly with options', () => {
    it('registers a named class with pluginName option', () => {
      class MyTool {}
      registry.registerClass(MyTool, { pluginName: 'my-plugin' });
      assert.equal(registry.getClass('MyTool'), MyTool);
    });
  });

  describe('registerClass() — Pattern 2 with options', () => {
    it('registers under explicit key with pluginName', () => {
      class Enhanced {}
      registry.registerClass('Router', Enhanced, { pluginName: 'analytics' });
      assert.equal(registry.getClass('Router'), Enhanced);
    });
  });

  describe('getClass()', () => {
    it('returns the top of the stack (latest registration)', () => {
      class Base {}
      class Override {}
      registry.registerClass('Thing', Base);
      registry.registerClass('Thing', Override);
      assert.equal(registry.getClass('Thing'), Override);
    });
  });

  describe('getClassAtIndex()', () => {
    it('returns the class at the specified stack position', () => {
      class Base {}
      class Mid {}
      class Top {}
      registry.registerClass('Thing', Base);
      registry.registerClass('Thing', Mid);
      registry.registerClass('Thing', Top);

      assert.equal(registry.getClassAtIndex('Thing', 0), Base);
      assert.equal(registry.getClassAtIndex('Thing', 1), Mid);
      assert.equal(registry.getClassAtIndex('Thing', 2), Top);
    });
  });

  describe('hasClass()', () => {
    it('returns true for a registered key', () => {
      class Foo {}
      registry.registerClass(Foo);
      assert.equal(registry.hasClass('Foo'), true);
    });

    it('returns false for an unregistered key', () => {
      assert.equal(registry.hasClass('Nope'), false);
    });
  });

  describe('getRegisteredKeys()', () => {
    it('lists all registered keys', () => {
      class Alpha {}
      class Beta {}
      registry.registerClass(Alpha);
      registry.registerClass(Beta);
      let keys = registry.getRegisteredKeys();
      assert.deepEqual(keys.sort(), ['Alpha', 'Beta']);
    });

    it('returns empty array when nothing is registered', () => {
      assert.deepEqual(registry.getRegisteredKeys(), []);
    });
  });

  describe('version tracking', () => {
    it('starts at 0', () => {
      assert.equal(registry.version, 0);
    });

    it('increments on registerClass', () => {
      class Foo {}
      registry.registerClass(Foo);
      assert.equal(registry.version, 1);
    });

    it('increments on each registration', () => {
      class Foo {}
      class Bar {}
      registry.registerClass(Foo);
      registry.registerClass(Bar);
      assert.equal(registry.version, 2);
    });

    it('increments on unregisterPlugin', () => {
      class Foo {}
      registry.registerClass(Foo, { pluginName: 'p1' });
      let v = registry.version;
      registry.unregisterPlugin('p1');
      assert.equal(registry.version, v + 1);
    });
  });

  describe('stack override behavior', () => {
    it('pushes second class on same key', () => {
      class Original {}
      class Override {}
      registry.registerClass('Thing', Original);
      registry.registerClass('Thing', Override);
      assert.equal(registry.getClass('Thing'), Override);
      assert.equal(registry.getClassAtIndex('Thing', 0), Original);
    });

    it('supports three levels of override', () => {
      class A {}
      class B {}
      class C {}
      registry.registerClass('X', A);
      registry.registerClass('X', B);
      registry.registerClass('X', C);
      assert.equal(registry.getClass('X'), C);
      assert.equal(registry.getClassAtIndex('X', 0), A);
      assert.equal(registry.getClassAtIndex('X', 1), B);
    });
  });

  // ---------------------------------------------------------------------------
  // Plugin tracking
  // ---------------------------------------------------------------------------

  describe('unregisterPlugin()', () => {
    it('removes all registrations from a specific plugin', () => {
      class Base {}
      class Enhanced {}
      registry.registerClass('Router', Base, { pluginName: 'core' });
      registry.registerClass('Router', Enhanced, { pluginName: 'analytics' });
      registry.unregisterPlugin('analytics');
      assert.equal(registry.getClass('Router'), Base);
    });

    it('rebuilds stack correctly after unregister', () => {
      class A {}
      class B {}
      class C {}
      registry.registerClass('X', A, { pluginName: 'core' });
      registry.registerClass('X', B, { pluginName: 'plugin-b' });
      registry.registerClass('X', C, { pluginName: 'core' });
      registry.unregisterPlugin('plugin-b');

      // Stack should be [A, C] — both from 'core'
      assert.equal(registry.getClassAtIndex('X', 0), A);
      assert.equal(registry.getClassAtIndex('X', 1), C);
      assert.equal(registry.getClass('X'), C);
    });

    it('handles chained overrides: remove middle of stack', () => {
      class Base {}
      class Mid {}
      class Top {}
      registry.registerClass('Thing', Base, { pluginName: 'core' });
      registry.registerClass('Thing', Mid, { pluginName: 'plugin-a' });
      registry.registerClass('Thing', Top, { pluginName: 'plugin-b' });

      registry.unregisterPlugin('plugin-a');

      // Stack: [Base, Top]
      assert.equal(registry.getClassAtIndex('Thing', 0), Base);
      assert.equal(registry.getClassAtIndex('Thing', 1), Top);
      assert.equal(registry.getClass('Thing'), Top);
    });

    it('removes key entirely when all registrations for that key are removed', () => {
      class Foo {}
      registry.registerClass(Foo, { pluginName: 'only-plugin' });
      registry.unregisterPlugin('only-plugin');
      assert.equal(registry.hasClass('Foo'), false);
      assert.equal(registry.getClass('Foo'), null);
    });

    it('removes registrations across multiple keys', () => {
      class A {}
      class B {}
      registry.registerClass('X', A, { pluginName: 'p1' });
      registry.registerClass('Y', B, { pluginName: 'p1' });
      registry.unregisterPlugin('p1');
      assert.equal(registry.hasClass('X'), false);
      assert.equal(registry.hasClass('Y'), false);
    });

    it('increments version after unregister', () => {
      class Foo {}
      registry.registerClass(Foo, { pluginName: 'p1' });
      let v = registry.version;
      registry.unregisterPlugin('p1');
      assert.ok(registry.version > v);
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('sad paths', () => {
    it('getClass for unregistered key returns null', () => {
      assert.equal(registry.getClass('DoesNotExist'), null);
    });

    it('registerClass with null throws', () => {
      assert.throws(() => registry.registerClass(null), {
        name: 'Error',
      });
    });

    it('registerClass with undefined throws', () => {
      assert.throws(() => registry.registerClass(undefined), {
        name: 'Error',
      });
    });

    it('registerClass with non-function value throws', () => {
      assert.throws(() => registry.registerClass('Key', 'not-a-function'), {
        name: 'Error',
      });
    });

    it('registerClass with number throws', () => {
      assert.throws(() => registry.registerClass(42), {
        name: 'Error',
      });
    });

    it('registerClass with object (not a class) throws', () => {
      assert.throws(() => registry.registerClass({}), {
        name: 'Error',
      });
    });

    it('registerClass with string key but no classRef throws', () => {
      assert.throws(() => registry.registerClass('Key'), {
        name: 'Error',
      });
    });

    it('registerClass with string key and null classRef throws', () => {
      assert.throws(() => registry.registerClass('Key', null), {
        name: 'Error',
      });
    });

    it('unregisterPlugin for unknown plugin is a no-op', () => {
      class Foo {}
      registry.registerClass(Foo);
      let v = registry.version;
      registry.unregisterPlugin('nonexistent');
      // Version still bumps (simplicity), but no registrations affected
      assert.equal(registry.getClass('Foo'), Foo);
    });

    it('getClassAtIndex out of bounds returns null', () => {
      class Foo {}
      registry.registerClass(Foo);
      assert.equal(registry.getClassAtIndex('Foo', 5), null);
      assert.equal(registry.getClassAtIndex('Foo', -1), null);
    });

    it('getClassAtIndex for unregistered key returns null', () => {
      assert.equal(registry.getClassAtIndex('Nope', 0), null);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('idempotent re-register: same class at top does not push again', () => {
      class Foo {}
      registry.registerClass(Foo);
      let v = registry.version;
      registry.registerClass(Foo);
      // Should not push a duplicate — version should not change
      assert.equal(registry.version, v);
      // Stack should have exactly 1 entry
      assert.equal(registry.getClassAtIndex('Foo', 0), Foo);
      assert.equal(registry.getClassAtIndex('Foo', 1), null);
    });

    it('idempotent re-register with string key: same class at top does not push', () => {
      class Bar {}
      registry.registerClass('Bar', Bar);
      let v = registry.version;
      registry.registerClass('Bar', Bar);
      assert.equal(registry.version, v);
      assert.equal(registry.getClassAtIndex('Bar', 1), null);
    });

    it('clear() resets everything', () => {
      class A {}
      class B {}
      registry.registerClass(A);
      registry.registerClass(B);
      registry.clear();
      assert.equal(registry.hasClass('A'), false);
      assert.equal(registry.hasClass('B'), false);
      assert.deepEqual(registry.getRegisteredKeys(), []);
    });

    it('clear() increments version', () => {
      class Foo {}
      registry.registerClass(Foo);
      let v = registry.version;
      registry.clear();
      assert.ok(registry.version > v);
    });

    it('bumpVersion() increments version manually', () => {
      let v = registry.version;
      registry.bumpVersion();
      assert.equal(registry.version, v + 1);
    });

    it('registrations preserve load order', () => {
      class A {}
      class B {}
      class C {}
      registry.registerClass('X', A, { pluginName: 'p1' });
      registry.registerClass('Y', B, { pluginName: 'p2' });
      registry.registerClass('X', C, { pluginName: 'p3' });

      // After removing p1, stack for X should only have C
      registry.unregisterPlugin('p1');
      assert.equal(registry.getClass('X'), C);
      assert.equal(registry.getClassAtIndex('X', 0), C);
      assert.equal(registry.getClassAtIndex('X', 1), null);
    });

    it('anonymous class passed directly throws (no name)', () => {
      assert.throws(() => registry.registerClass(function() {}), {
        name: 'Error',
      });
    });

    it('arrow function passed directly throws (no name)', () => {
      assert.throws(() => registry.registerClass(() => {}), {
        name: 'Error',
      });
    });
  });
});
