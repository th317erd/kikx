'use strict';

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import { BasePluginClass } from '../../../src/core/routing/base-plugin-class.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createContext(overrides) {
  return { logger: console, changes: [], ...overrides };
}

// =============================================================================
// Construction
// =============================================================================

describe('BasePluginClass', () => {
  describe('construction', () => {
    it('should store context on the instance', () => {
      let context  = createContext();
      let plugin   = new BasePluginClass(context);
      assert.strictEqual(plugin._context, context);
    });

    it('should return the context via the getter', () => {
      let context = createContext();
      let plugin  = new BasePluginClass(context);
      assert.strictEqual(plugin.context, context);
    });

    it('should return context.logger when available', () => {
      let customLogger = { log: () => {}, warn: () => {}, error: () => {} };
      let context      = createContext({ logger: customLogger });
      let plugin       = new BasePluginClass(context);
      assert.strictEqual(plugin.logger, customLogger);
    });

    it('should fall back to console when no logger in context', () => {
      let context = createContext({ logger: undefined });
      let plugin  = new BasePluginClass(context);
      assert.strictEqual(plugin.logger, console);
    });

    it('should fall back to console when logger is null', () => {
      let context = createContext({ logger: null });
      let plugin  = new BasePluginClass(context);
      assert.strictEqual(plugin.logger, console);
    });
  });

  // ===========================================================================
  // process()
  // ===========================================================================

  describe('process()', () => {
    it('should call next(context) by default — chain continues', async () => {
      let context     = createContext();
      let plugin      = new BasePluginClass(context);
      let nextCalled  = false;
      let receivedCtx = null;

      let next = (ctx) => {
        nextCalled  = true;
        receivedCtx = ctx;
        return 'next-result';
      };
      let done = () => { throw new Error('done() should not be called'); };

      let result = await plugin.process(next, done);

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(receivedCtx, context);
      assert.strictEqual(result, 'next-result');
    });

    it('should allow subclass to override and call done() instead', async () => {
      class StopPlugin extends BasePluginClass {
        async process(next, done) {
          return await done(this.context);
        }
      }

      let context    = createContext();
      let plugin     = new StopPlugin(context);
      let doneCalled = false;

      let next = () => { throw new Error('next() should not be called'); };
      let done = (ctx) => {
        doneCalled = true;
        return 'done-result';
      };

      let result = await plugin.process(next, done);

      assert.strictEqual(doneCalled, true);
      assert.strictEqual(result, 'done-result');
    });

    it('should allow subclass to modify context before calling next', async () => {
      class MutatingPlugin extends BasePluginClass {
        async process(next, done) {
          this.context.modified = true;
          return await next(this.context);
        }
      }

      let context     = createContext();
      let plugin      = new MutatingPlugin(context);
      let receivedCtx = null;

      let next = (ctx) => { receivedCtx = ctx; return 'ok'; };
      let done = () => {};

      await plugin.process(next, done);

      assert.strictEqual(receivedCtx.modified, true);
      assert.strictEqual(context.modified, true);
    });

    it('should propagate errors from next()', async () => {
      let context = createContext();
      let plugin  = new BasePluginClass(context);

      let next = () => { throw new Error('chain error'); };
      let done = () => {};

      await assert.rejects(
        () => plugin.process(next, done),
        { message: 'chain error' },
      );
    });

    it('should handle async next() that returns a promise', async () => {
      let context = createContext();
      let plugin  = new BasePluginClass(context);

      let next = async (ctx) => {
        return 'async-result';
      };
      let done = () => {};

      let result = await plugin.process(next, done);
      assert.strictEqual(result, 'async-result');
    });
  });

  // ===========================================================================
  // processChanges()
  // ===========================================================================

  describe('processChanges()', () => {
    it('should iterate context.changes and call onChange() per entry', () => {
      let received = [];

      class TrackingPlugin extends BasePluginClass {
        onChange(propName, previousValue, newValue) {
          received.push({ propName, previousValue, newValue });
        }
      }

      let context = createContext({
        changes: [
          { propName: 'color', previousValue: 'red', newValue: 'blue' },
        ],
      });
      let plugin = new TrackingPlugin(context);
      plugin.processChanges();

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], {
        propName:      'color',
        previousValue: 'red',
        newValue:      'blue',
      });
    });

    it('should pass propName, previousValue, newValue correctly', () => {
      let captured = {};

      class CapturePlugin extends BasePluginClass {
        onChange(propName, previousValue, newValue) {
          captured = { propName, previousValue, newValue };
        }
      }

      let context = createContext({
        changes: [
          { propName: 'status', previousValue: 'active', newValue: 'inactive' },
        ],
      });
      let plugin = new CapturePlugin(context);
      plugin.processChanges();

      assert.strictEqual(captured.propName, 'status');
      assert.strictEqual(captured.previousValue, 'active');
      assert.strictEqual(captured.newValue, 'inactive');
    });

    it('should handle empty changes array', () => {
      let callCount = 0;

      class CountPlugin extends BasePluginClass {
        onChange() { callCount++; }
      }

      let context = createContext({ changes: [] });
      let plugin  = new CountPlugin(context);
      plugin.processChanges();

      assert.strictEqual(callCount, 0);
    });

    it('should handle null changes — no error', () => {
      let context = createContext({ changes: null });
      let plugin  = new BasePluginClass(context);

      // Should not throw
      plugin.processChanges();
    });

    it('should handle undefined changes — no error', () => {
      let context = createContext({ changes: undefined });
      let plugin  = new BasePluginClass(context);

      // Should not throw
      plugin.processChanges();
    });

    it('should handle missing changes property — no error', () => {
      let context = {};
      let plugin  = new BasePluginClass(context);

      // Should not throw
      plugin.processChanges();
    });

    it('should process multiple changes in order', () => {
      let received = [];

      class OrderPlugin extends BasePluginClass {
        onChange(propName, previousValue, newValue) {
          received.push(propName);
        }
      }

      let context = createContext({
        changes: [
          { propName: 'first',  previousValue: null, newValue: 1 },
          { propName: 'second', previousValue: null, newValue: 2 },
          { propName: 'third',  previousValue: null, newValue: 3 },
        ],
      });
      let plugin = new OrderPlugin(context);
      plugin.processChanges();

      assert.deepStrictEqual(received, ['first', 'second', 'third']);
    });

    it('should handle changes that are not an array — no error', () => {
      let context = createContext({ changes: 'not-an-array' });
      let plugin  = new BasePluginClass(context);

      // Should not throw — the guard rejects non-arrays
      plugin.processChanges();
    });

    it('should handle changes set to an object — no error', () => {
      let context = createContext({ changes: { length: 2 } });
      let plugin  = new BasePluginClass(context);

      // Should not throw — object is not an array
      plugin.processChanges();
    });
  });

  // ===========================================================================
  // onChange()
  // ===========================================================================

  describe('onChange()', () => {
    it('should be a no-op by default — no error', () => {
      let context = createContext();
      let plugin  = new BasePluginClass(context);

      // Should not throw
      plugin.onChange('test', 'old', 'new');
    });

    it('should allow subclass to override and receive correct arguments', () => {
      let received = null;

      class OverridePlugin extends BasePluginClass {
        onChange(propName, previousValue, newValue) {
          received = { propName, previousValue, newValue };
        }
      }

      let context = createContext();
      let plugin  = new OverridePlugin(context);
      plugin.onChange('name', 'Alice', 'Bob');

      assert.deepStrictEqual(received, {
        propName:      'name',
        previousValue: 'Alice',
        newValue:      'Bob',
      });
    });

    it('should handle undefined arguments without error', () => {
      let context = createContext();
      let plugin  = new BasePluginClass(context);

      // Should not throw
      plugin.onChange(undefined, undefined, undefined);
    });
  });

  // ===========================================================================
  // checkPermission()
  // ===========================================================================

  describe('checkPermission()', () => {
    it('should return { approved: true } for any input (Phase C1 stub)', async () => {
      let context = createContext();
      let plugin  = new BasePluginClass(context);

      let result = await plugin.checkPermission('shell:execute', { command: 'ls' });

      assert.deepStrictEqual(result, { approved: true });
    });

    it('should accept toolName and params without error', async () => {
      let context = createContext();
      let plugin  = new BasePluginClass(context);

      // Various argument shapes should all resolve cleanly
      let resultNoArgs       = await plugin.checkPermission();
      let resultNullArgs     = await plugin.checkPermission(null, null);
      let resultEmptyParams  = await plugin.checkPermission('some-tool', {});
      let resultComplexArgs  = await plugin.checkPermission('web:fetch', {
        url:     'https://example.com',
        method:  'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      assert.deepStrictEqual(resultNoArgs, { approved: true });
      assert.deepStrictEqual(resultNullArgs, { approved: true });
      assert.deepStrictEqual(resultEmptyParams, { approved: true });
      assert.deepStrictEqual(resultComplexArgs, { approved: true });
    });

    it('should return a promise', () => {
      let context = createContext();
      let plugin  = new BasePluginClass(context);

      let result = plugin.checkPermission('test', {});
      assert.ok(result instanceof Promise);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle context with no logger property', () => {
      let context = { someOtherProp: 'value' };
      let plugin  = new BasePluginClass(context);

      assert.strictEqual(plugin.logger, console);
      assert.strictEqual(plugin.context.someOtherProp, 'value');
    });

    it('should handle context with empty changes array', () => {
      let callCount = 0;

      class CountPlugin extends BasePluginClass {
        onChange() { callCount++; }
      }

      let context = createContext({ changes: [] });
      let plugin  = new CountPlugin(context);
      plugin.processChanges();

      assert.strictEqual(callCount, 0);
    });

    it('should handle processChanges() before changes exist on context', () => {
      let context = {};
      let plugin  = new BasePluginClass(context);

      // Should not throw
      plugin.processChanges();
    });

    it('should support subclass calling processChanges() inside process()', async () => {
      let received = [];

      class HybridPlugin extends BasePluginClass {
        onChange(propName, previousValue, newValue) {
          received.push({ propName, previousValue, newValue });
        }

        async process(next, done) {
          this.processChanges();
          return await next(this.context);
        }
      }

      let context = createContext({
        changes: [
          { propName: 'alpha', previousValue: 0, newValue: 1 },
          { propName: 'beta',  previousValue: 'x', newValue: 'y' },
        ],
      });

      let plugin      = new HybridPlugin(context);
      let nextCalled  = false;
      let next        = (ctx) => { nextCalled = true; return 'chain-result'; };
      let done        = () => {};

      let result = await plugin.process(next, done);

      assert.strictEqual(received.length, 2);
      assert.deepStrictEqual(received[0], { propName: 'alpha', previousValue: 0, newValue: 1 });
      assert.deepStrictEqual(received[1], { propName: 'beta', previousValue: 'x', newValue: 'y' });
      assert.strictEqual(nextCalled, true);
      assert.strictEqual(result, 'chain-result');
    });

    it('should handle context being an empty object', () => {
      let context = {};
      let plugin  = new BasePluginClass(context);

      assert.strictEqual(plugin.context, context);
      assert.strictEqual(plugin.logger, console);
    });

    it('should handle logger being false — falls back to console', () => {
      let context = createContext({ logger: false });
      let plugin  = new BasePluginClass(context);

      assert.strictEqual(plugin.logger, console);
    });

    it('should handle logger being 0 — falls back to console', () => {
      let context = createContext({ logger: 0 });
      let plugin  = new BasePluginClass(context);

      assert.strictEqual(plugin.logger, console);
    });

    it('should handle logger being an empty string — falls back to console', () => {
      let context = createContext({ logger: '' });
      let plugin  = new BasePluginClass(context);

      assert.strictEqual(plugin.logger, console);
    });
  });
});
