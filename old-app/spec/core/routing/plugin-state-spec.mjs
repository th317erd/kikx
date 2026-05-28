'use strict';

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

// =============================================================================
// Plugin State Proxy — unit tests for the state Proxy mechanics
// =============================================================================
// These tests verify the Proxy behavior in isolation (no FrameRouter needed).
// The Proxy is the same one FrameRouter creates before dispatching to a plugin.
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: creates a state Proxy + dirty tracker (same logic as FrameRouter)
// ---------------------------------------------------------------------------

function createStateProxy(rawState) {
  let dirty = false;

  let proxy = new Proxy(rawState, {
    set(target, prop, value) {
      target[prop] = value;
      dirty = true;
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      dirty = true;
      return true;
    },
  });

  return { proxy, isDirty: () => dirty, getRaw: () => rawState };
}

// ---------------------------------------------------------------------------
// Helper: hydrate raw state from a frame's state field (same as FrameRouter)
// ---------------------------------------------------------------------------

function hydrateState(frameState) {
  let rawState = {};

  try {
    if (frameState)
      rawState = (typeof frameState === 'string') ? JSON.parse(frameState) : frameState;
  } catch (_e) {
    rawState = {};
  }

  // Ensure we always have a plain object
  if (rawState === null || typeof rawState !== 'object' || Array.isArray(rawState))
    rawState = {};

  return rawState;
}

// =============================================================================
// Tests
// =============================================================================

describe('Plugin State Proxy', () => {

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe('get/set primitive values', () => {
    it('should set and get a string value', () => {
      let { proxy } = createStateProxy({});
      proxy.toolName = 'shell:execute';
      assert.strictEqual(proxy.toolName, 'shell:execute');
    });

    it('should set and get a number value', () => {
      let { proxy } = createStateProxy({});
      proxy.retryCount = 3;
      assert.strictEqual(proxy.retryCount, 3);
    });

    it('should set and get a boolean value', () => {
      let { proxy } = createStateProxy({});
      proxy.approved = true;
      assert.strictEqual(proxy.approved, true);
    });

    it('should set and get null', () => {
      let { proxy } = createStateProxy({});
      proxy.result = null;
      assert.strictEqual(proxy.result, null);
    });
  });

  describe('get/set nested objects', () => {
    it('should set and get a nested object', () => {
      let { proxy } = createStateProxy({});
      proxy.params = { command: 'ls', args: ['-la'] };
      assert.deepStrictEqual(proxy.params, { command: 'ls', args: ['-la'] });
    });

    it('should set and get an array value', () => {
      let { proxy } = createStateProxy({});
      proxy.history = ['step1', 'step2'];
      assert.deepStrictEqual(proxy.history, ['step1', 'step2']);
    });
  });

  describe('state starts empty when no prior state on frame', () => {
    it('should return empty object when frame has no state', () => {
      let raw = hydrateState(undefined);
      let { proxy } = createStateProxy(raw);
      assert.deepStrictEqual({ ...proxy }, {});
    });

    it('should return empty object when frame state is null', () => {
      let raw = hydrateState(null);
      let { proxy } = createStateProxy(raw);
      assert.deepStrictEqual({ ...proxy }, {});
    });

    it('should return empty object when frame state is empty string', () => {
      let raw = hydrateState('');
      let { proxy } = createStateProxy(raw);
      assert.deepStrictEqual({ ...proxy }, {});
    });
  });

  describe('state hydrated from stored JSON string', () => {
    it('should hydrate from a valid JSON string', () => {
      let raw = hydrateState('{"toolName":"shell:execute","step":"awaiting-approval"}');
      let { proxy } = createStateProxy(raw);
      assert.strictEqual(proxy.toolName, 'shell:execute');
      assert.strictEqual(proxy.step, 'awaiting-approval');
    });

    it('should hydrate from an object (already parsed)', () => {
      let raw = hydrateState({ toolName: 'shell:execute' });
      let { proxy } = createStateProxy(raw);
      assert.strictEqual(proxy.toolName, 'shell:execute');
    });
  });

  // ---------------------------------------------------------------------------
  // Dirty tracking
  // ---------------------------------------------------------------------------

  describe('dirty flag', () => {
    it('should not be dirty on read-only access', () => {
      let raw = hydrateState('{"x":1}');
      let { proxy, isDirty } = createStateProxy(raw);
      let _val = proxy.x;
      assert.strictEqual(isDirty(), false);
    });

    it('should be dirty after a write', () => {
      let { proxy, isDirty } = createStateProxy({});
      proxy.x = 1;
      assert.strictEqual(isDirty(), true);
    });

    it('should be dirty after a delete', () => {
      let raw = hydrateState('{"x":1}');
      let { proxy, isDirty } = createStateProxy(raw);
      delete proxy.x;
      assert.strictEqual(isDirty(), true);
    });

    it('should stay dirty after multiple writes (single persist)', () => {
      let { proxy, isDirty } = createStateProxy({});
      proxy.a = 1;
      proxy.b = 2;
      proxy.c = 3;
      assert.strictEqual(isDirty(), true);
    });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  describe('corrupted / invalid frame state', () => {
    it('should fall back to empty object on corrupted JSON', () => {
      let raw = hydrateState('{not-valid-json');
      let { proxy } = createStateProxy(raw);
      assert.deepStrictEqual({ ...proxy }, {});
    });

    it('should fall back to empty object when state is a number', () => {
      let raw = hydrateState(42);
      let { proxy } = createStateProxy(raw);
      // 42 is not an object, hydrateState should treat it as empty
      assert.deepStrictEqual({ ...proxy }, {});
    });

    it('should fall back to empty object when state is an array', () => {
      let raw = hydrateState('[1,2,3]');
      let { proxy } = createStateProxy(raw);
      assert.deepStrictEqual({ ...proxy }, {});
    });

    it('should fall back to empty object when state is boolean', () => {
      let raw = hydrateState(true);
      let { proxy } = createStateProxy(raw);
      assert.deepStrictEqual({ ...proxy }, {});
    });
  });

  describe('delete key from state', () => {
    it('should remove the key and mark dirty', () => {
      let raw = hydrateState('{"x":1,"y":2}');
      let { proxy, isDirty, getRaw } = createStateProxy(raw);
      delete proxy.x;
      assert.strictEqual(isDirty(), true);
      assert.strictEqual(proxy.x, undefined);
      assert.strictEqual(getRaw().x, undefined);
      assert.strictEqual(proxy.y, 2);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle state with large values', () => {
      let { proxy, getRaw } = createStateProxy({});
      let largeString = 'x'.repeat(100000);
      proxy.bigData = largeString;
      assert.strictEqual(proxy.bigData.length, 100000);
      // Verify it serializes
      let json = JSON.stringify(getRaw());
      assert.ok(json.length > 100000);
    });

    it('should not be dirty when plugin does not write to state', () => {
      let raw = hydrateState('{"step":"ready"}');
      let { proxy, isDirty } = createStateProxy(raw);
      // Read-only operations
      let _step = proxy.step;
      let _keys = Object.keys(proxy);
      assert.strictEqual(isDirty(), false);
    });

    it('should produce independent proxies for different frames', () => {
      let raw1 = hydrateState('{"a":1}');
      let raw2 = hydrateState('{"b":2}');
      let s1 = createStateProxy(raw1);
      let s2 = createStateProxy(raw2);

      s1.proxy.a = 10;
      assert.strictEqual(s1.proxy.a, 10);
      assert.strictEqual(s2.proxy.b, 2);
      assert.strictEqual(s1.isDirty(), true);
      assert.strictEqual(s2.isDirty(), false);
    });

    it('should allow overwriting a value', () => {
      let { proxy } = createStateProxy({});
      proxy.step = 'pending';
      proxy.step = 'approved';
      assert.strictEqual(proxy.step, 'approved');
    });

    it('should support Object.keys enumeration', () => {
      let raw = hydrateState('{"a":1,"b":2}');
      let { proxy } = createStateProxy(raw);
      assert.deepStrictEqual(Object.keys(proxy).sort(), ['a', 'b']);
    });

    it('should support "in" operator', () => {
      let raw = hydrateState('{"a":1}');
      let { proxy } = createStateProxy(raw);
      assert.strictEqual('a' in proxy, true);
      assert.strictEqual('b' in proxy, false);
    });

    it('should support spread operator', () => {
      let raw = hydrateState('{"x":1,"y":2}');
      let { proxy } = createStateProxy(raw);
      let copy = { ...proxy };
      assert.deepStrictEqual(copy, { x: 1, y: 2 });
    });
  });
});
