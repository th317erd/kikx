'use strict';

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../../../src/shared/lib/event-emitter.mjs';

// =============================================================================
// Shared EventEmitter — browser + Node compatible
// =============================================================================

describe('EventEmitter', () => {
  let emitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  // ---------------------------------------------------------------------------
  // on / emit basics
  // ---------------------------------------------------------------------------

  describe('on and emit', () => {
    it('calls listener when event is emitted', () => {
      let called = false;
      emitter.on('test', () => { called = true; });
      emitter.emit('test');

      assert.equal(called, true);
    });

    it('passes arguments to listener', () => {
      let received;
      emitter.on('test', (a, b, c) => { received = [a, b, c]; });
      emitter.emit('test', 1, 'two', { three: 3 });

      assert.deepStrictEqual(received, [1, 'two', { three: 3 }]);
    });

    it('calls multiple listeners on same event in registration order', () => {
      let order = [];
      emitter.on('test', () => order.push(1));
      emitter.on('test', () => order.push(2));
      emitter.on('test', () => order.push(3));
      emitter.emit('test');

      assert.deepStrictEqual(order, [1, 2, 3]);
    });

    it('returns true when event has listeners', () => {
      emitter.on('test', () => {});
      assert.equal(emitter.emit('test'), true);
    });

    it('returns false when event has no listeners', () => {
      assert.equal(emitter.emit('test'), false);
    });

    it('does not call listeners for other events', () => {
      let called = false;
      emitter.on('other', () => { called = true; });
      emitter.emit('test');

      assert.equal(called, false);
    });

    it('supports namespaced event names (colon-separated)', () => {
      let called = false;
      emitter.on('frame:added:frm_123', () => { called = true; });
      emitter.emit('frame:added:frm_123');

      assert.equal(called, true);
    });

    it('returns this for chaining', () => {
      let result = emitter.on('test', () => {});
      assert.equal(result, emitter);
    });
  });

  // ---------------------------------------------------------------------------
  // off / removeListener
  // ---------------------------------------------------------------------------

  describe('off', () => {
    it('removes a specific listener', () => {
      let callCount = 0;
      let listener = () => { callCount++; };

      emitter.on('test', listener);
      emitter.emit('test');
      assert.equal(callCount, 1);

      emitter.off('test', listener);
      emitter.emit('test');
      assert.equal(callCount, 1);
    });

    it('does not remove other listeners for same event', () => {
      let calls = [];
      let listenerA = () => calls.push('a');
      let listenerB = () => calls.push('b');

      emitter.on('test', listenerA);
      emitter.on('test', listenerB);
      emitter.off('test', listenerA);
      emitter.emit('test');

      assert.deepStrictEqual(calls, ['b']);
    });

    it('is safe to call with a listener that was never registered', () => {
      emitter.on('test', () => {});
      emitter.off('test', () => {}); // different function reference

      assert.equal(emitter.listenerCount('test'), 1);
    });

    it('is safe to call for an event that does not exist', () => {
      emitter.off('nonexistent', () => {});
      // no throw
    });

    it('cleans up empty event entry', () => {
      let listener = () => {};
      emitter.on('test', listener);
      emitter.off('test', listener);

      assert.equal(emitter.eventNames().includes('test'), false);
    });

    it('returns this for chaining', () => {
      let result = emitter.off('test', () => {});
      assert.equal(result, emitter);
    });

    it('removing listener during emit does not affect current iteration', () => {
      let calls = [];
      let listenerA;

      listenerA = () => {
        calls.push('a');
        emitter.off('test', listenerA);
      };

      let listenerB = () => calls.push('b');

      emitter.on('test', listenerA);
      emitter.on('test', listenerB);
      emitter.emit('test');

      assert.deepStrictEqual(calls, ['a', 'b']);

      // Second emit: listenerA should be gone
      calls = [];
      emitter.emit('test');
      assert.deepStrictEqual(calls, ['b']);
    });
  });

  // ---------------------------------------------------------------------------
  // once
  // ---------------------------------------------------------------------------

  describe('once', () => {
    it('fires listener only once', () => {
      let callCount = 0;
      emitter.once('test', () => { callCount++; });

      emitter.emit('test');
      emitter.emit('test');
      emitter.emit('test');

      assert.equal(callCount, 1);
    });

    it('passes arguments correctly', () => {
      let received;
      emitter.once('test', (a, b) => { received = [a, b]; });
      emitter.emit('test', 'hello', 42);

      assert.deepStrictEqual(received, ['hello', 42]);
    });

    it('can be removed before firing via off with original listener', () => {
      let called = false;
      let listener = () => { called = true; };

      emitter.once('test', listener);
      emitter.off('test', listener);
      emitter.emit('test');

      assert.equal(called, false);
    });

    it('returns this for chaining', () => {
      let result = emitter.once('test', () => {});
      assert.equal(result, emitter);
    });

    it('does not interfere with regular listeners on same event', () => {
      let calls = [];
      emitter.on('test', () => calls.push('regular'));
      emitter.once('test', () => calls.push('once'));

      emitter.emit('test');
      assert.deepStrictEqual(calls, ['regular', 'once']);

      calls = [];
      emitter.emit('test');
      assert.deepStrictEqual(calls, ['regular']);
    });
  });

  // ---------------------------------------------------------------------------
  // error event
  // ---------------------------------------------------------------------------

  describe('error event', () => {
    it('throws the Error object when no error listener is registered', () => {
      let error = new Error('test error');

      assert.throws(
        () => emitter.emit('error', error),
        (thrown) => thrown === error,
      );
    });

    it('throws generic error when non-Error value emitted and no listener', () => {
      assert.throws(
        () => emitter.emit('error', 'string error'),
        { message: 'Unhandled error event' },
      );
    });

    it('calls error listener instead of throwing when registered', () => {
      let received;
      emitter.on('error', (error) => { received = error; });

      let error = new Error('test error');
      emitter.emit('error', error);

      assert.equal(received, error);
    });

    it('returns true when error listener is registered', () => {
      emitter.on('error', () => {});
      assert.equal(emitter.emit('error', new Error('test')), true);
    });
  });

  // ---------------------------------------------------------------------------
  // removeAllListeners
  // ---------------------------------------------------------------------------

  describe('removeAllListeners', () => {
    it('removes all listeners for a specific event', () => {
      emitter.on('a', () => {});
      emitter.on('a', () => {});
      emitter.on('b', () => {});

      emitter.removeAllListeners('a');

      assert.equal(emitter.listenerCount('a'), 0);
      assert.equal(emitter.listenerCount('b'), 1);
    });

    it('removes all listeners for all events when called without argument', () => {
      emitter.on('a', () => {});
      emitter.on('b', () => {});
      emitter.on('c', () => {});

      emitter.removeAllListeners();

      assert.equal(emitter.listenerCount('a'), 0);
      assert.equal(emitter.listenerCount('b'), 0);
      assert.equal(emitter.listenerCount('c'), 0);
      assert.deepStrictEqual(emitter.eventNames(), []);
    });

    it('returns this for chaining', () => {
      let result = emitter.removeAllListeners();
      assert.equal(result, emitter);
    });

    it('is safe to call for a nonexistent event', () => {
      emitter.removeAllListeners('nonexistent');
      // no throw
    });

    it('cleans up once wrappers', () => {
      let listener = () => {};
      emitter.once('test', listener);
      emitter.removeAllListeners('test');

      assert.equal(emitter.listenerCount('test'), 0);
      // Verify the once wrapper map is also cleaned
      assert.equal(emitter._onceWrapped.size, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // setMaxListeners / max listener warning
  // ---------------------------------------------------------------------------

  describe('setMaxListeners', () => {
    it('defaults to 10', () => {
      assert.equal(emitter.getMaxListeners(), 10);
    });

    it('can be set to a custom value', () => {
      emitter.setMaxListeners(5);
      assert.equal(emitter.getMaxListeners(), 5);
    });

    it('Infinity suppresses warnings', () => {
      emitter.setMaxListeners(Infinity);

      let warned = false;
      let originalWarn = console.warn;
      console.warn = () => { warned = true; };

      try {
        for (let i = 0; i < 100; i++)
          emitter.on('test', () => {});

        assert.equal(warned, false);
      } finally {
        console.warn = originalWarn;
      }
    });

    it('0 disables the warning', () => {
      emitter.setMaxListeners(0);

      let warned = false;
      let originalWarn = console.warn;
      console.warn = () => { warned = true; };

      try {
        for (let i = 0; i < 100; i++)
          emitter.on('test', () => {});

        assert.equal(warned, false);
      } finally {
        console.warn = originalWarn;
      }
    });

    it('warns when listener count exceeds max', () => {
      emitter.setMaxListeners(2);

      let warnings = [];
      let originalWarn = console.warn;
      console.warn = (...args) => { warnings.push(args.join(' ')); };

      try {
        emitter.on('test', () => {});
        emitter.on('test', () => {});
        assert.equal(warnings.length, 0);

        emitter.on('test', () => {}); // 3rd listener, exceeds max of 2
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('3 listeners'));
        assert.ok(warnings[0].includes('"test"'));
      } finally {
        console.warn = originalWarn;
      }
    });

    it('returns this for chaining', () => {
      let result = emitter.setMaxListeners(20);
      assert.equal(result, emitter);
    });

    it('throws on negative number', () => {
      assert.throws(
        () => emitter.setMaxListeners(-1),
        { name: 'RangeError' },
      );
    });

    it('throws on non-number', () => {
      assert.throws(
        () => emitter.setMaxListeners('ten'),
        { name: 'RangeError' },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listenerCount / listeners / eventNames
  // ---------------------------------------------------------------------------

  describe('listenerCount', () => {
    it('returns 0 for events with no listeners', () => {
      assert.equal(emitter.listenerCount('test'), 0);
    });

    it('returns correct count', () => {
      emitter.on('test', () => {});
      emitter.on('test', () => {});

      assert.equal(emitter.listenerCount('test'), 2);
    });

    it('counts once listeners', () => {
      emitter.once('test', () => {});

      assert.equal(emitter.listenerCount('test'), 1);
    });
  });

  describe('listeners', () => {
    it('returns empty array for events with no listeners', () => {
      assert.deepStrictEqual(emitter.listeners('test'), []);
    });

    it('returns copy of listeners array', () => {
      let listener = () => {};
      emitter.on('test', listener);

      let result = emitter.listeners('test');
      assert.equal(result.length, 1);

      // Should be a copy, not the internal set
      result.push(() => {});
      assert.equal(emitter.listenerCount('test'), 1);
    });
  });

  describe('eventNames', () => {
    it('returns empty array when no events registered', () => {
      assert.deepStrictEqual(emitter.eventNames(), []);
    });

    it('returns registered event names', () => {
      emitter.on('a', () => {});
      emitter.on('b', () => {});
      emitter.on('c', () => {});

      let names = emitter.eventNames();
      assert.deepStrictEqual(names.sort(), ['a', 'b', 'c']);
    });
  });

  // ---------------------------------------------------------------------------
  // addListener / removeListener aliases
  // ---------------------------------------------------------------------------

  describe('aliases', () => {
    it('addListener is the same as on', () => {
      let called = false;
      emitter.addListener('test', () => { called = true; });
      emitter.emit('test');

      assert.equal(called, true);
    });

    it('removeListener is the same as off', () => {
      let called = false;
      let listener = () => { called = true; };
      emitter.addListener('test', listener);
      emitter.removeListener('test', listener);
      emitter.emit('test');

      assert.equal(called, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Error paths: invalid arguments
  // ---------------------------------------------------------------------------

  describe('invalid arguments', () => {
    it('on throws when listener is not a function', () => {
      assert.throws(
        () => emitter.on('test', 'not a function'),
        { name: 'TypeError', message: 'listener must be a function' },
      );
    });

    it('once throws when listener is not a function', () => {
      assert.throws(
        () => emitter.once('test', null),
        { name: 'TypeError', message: 'listener must be a function' },
      );
    });

    it('off throws when listener is not a function', () => {
      assert.throws(
        () => emitter.off('test', 42),
        { name: 'TypeError', message: 'listener must be a function' },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('same function registered twice is only stored once (Set behavior)', () => {
      let callCount = 0;
      let listener = () => { callCount++; };

      emitter.on('test', listener);
      emitter.on('test', listener);
      emitter.emit('test');

      // Set deduplicates — listener should fire once
      assert.equal(callCount, 1);
      assert.equal(emitter.listenerCount('test'), 1);
    });

    it('emit with no arguments beyond event name works', () => {
      let called = false;
      emitter.on('test', () => { called = true; });
      emitter.emit('test');

      assert.equal(called, true);
    });

    it('listeners added during emit are not called in that cycle', () => {
      let calls = [];
      emitter.on('test', () => {
        calls.push('first');
        emitter.on('test', () => calls.push('dynamic'));
      });

      emitter.emit('test');
      assert.deepStrictEqual(calls, ['first']);

      // Second emit should include the dynamically added listener
      calls = [];
      emitter.emit('test');
      assert.ok(calls.includes('dynamic'));
    });

    it('works with symbol event names', () => {
      let sym = Symbol('test');
      let called = false;
      emitter.on(sym, () => { called = true; });
      emitter.emit(sym);

      assert.equal(called, true);
    });

    it('emit returns false for removed event', () => {
      let listener = () => {};
      emitter.on('test', listener);
      emitter.off('test', listener);

      assert.equal(emitter.emit('test'), false);
    });

    it('many events in sequence work correctly', () => {
      let results = [];

      for (let i = 0; i < 50; i++)
        emitter.on(`event-${i}`, (value) => results.push(value));

      for (let i = 0; i < 50; i++)
        emitter.emit(`event-${i}`, i);

      assert.equal(results.length, 50);
      assert.deepStrictEqual(results, Array.from({ length: 50 }, (_, i) => i));
    });
  });
});
