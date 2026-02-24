'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/frame-manager.mjs';
import { EventRecorder } from './test-utils/event-recorder.mjs';
import { HistoryWalker } from './test-utils/history-walker.mjs';
import { IntegrityChecker } from './test-utils/integrity-checker.mjs';

// ─── EventRecorder ─────────────────────────────────────────────────────────────

describe('EventRecorder', () => {
  let manager;
  let recorder;

  beforeEach(() => {
    manager  = new FrameManager();
    recorder = new EventRecorder();
  });

  afterEach(() => {
    recorder.detach();
  });

  describe('attach / detach', () => {
    it('should attach to a FrameManager and record events', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.ok(recorder.events.length > 0);
    });

    it('should stop recording after detach', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let countBefore = recorder.events.length;
      recorder.detach();

      manager.merge([
        { id: 'f2', type: 'message', content: { text: 'world' } },
      ]);

      assert.equal(recorder.events.length, countBefore);
    });

    it('should detach previous manager when attaching to a new one', () => {
      let manager2 = new FrameManager();

      recorder.attach(manager);
      recorder.attach(manager2);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      // Events from manager should NOT be recorded since we reattached to manager2
      let eventsBefore = recorder.events.length;

      manager2.merge([
        { id: 'f2', type: 'message', content: { text: 'world' } },
      ]);

      assert.ok(recorder.events.length > eventsBefore);
    });
  });

  describe('records frame:added events', () => {
    it('should capture frame:added for new non-phantom frames', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let addedEvents = recorder.getEvents('frame:added');
      assert.ok(addedEvents.length > 0);

      // Should include both the base event and the namespaced event
      let baseEvent      = recorder.events.find((e) => e.name === 'frame:added');
      let namespacedEvent = recorder.events.find((e) => e.name === 'frame:added:f1');

      assert.ok(baseEvent, 'Should have base frame:added event');
      assert.ok(namespacedEvent, 'Should have namespaced frame:added:f1 event');
    });

    it('should not fire frame:added for phantom frames', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', phantom: true, content: { text: 'ghost' } },
      ]);

      let addedEvents = recorder.events.filter((e) => e.name === 'frame:added');
      assert.equal(addedEvents.length, 0);
    });

    it('should capture frame:updated for target-based merges', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      recorder.reset();

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'updated' } },
      ]);

      let updatedEvents = recorder.getEvents('frame:updated');
      assert.ok(updatedEvents.length > 0);
    });
  });

  describe('assertFired / assertNotFired', () => {
    it('should pass when event was fired', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.doesNotThrow(() => recorder.assertFired('frame:added'));
    });

    it('should throw when event was not fired', () => {
      recorder.attach(manager);

      assert.throws(() => recorder.assertFired('frame:added'), /never did/);
    });

    it('should pass assertNotFired when event was not fired', () => {
      recorder.attach(manager);

      assert.doesNotThrow(() => recorder.assertNotFired('frame:added'));
    });

    it('should throw assertNotFired when event was fired', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.throws(() => recorder.assertNotFired('frame:added'), /NOT have fired/);
    });
  });

  describe('assertFiredWith', () => {
    it('should find an event matching the predicate', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let match = recorder.assertFiredWith('frame:added', (payload) => payload.frame.id === 'f1');
      assert.ok(match);
      assert.equal(match.payload.frame.id, 'f1');
    });

    it('should throw when no event matches the predicate', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.throws(
        () => recorder.assertFiredWith('frame:added', (payload) => payload.frame.id === 'nonexistent'),
        /none matched/,
      );
    });
  });

  describe('assertOrder', () => {
    it('should pass when events fired in correct order', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'first' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'second' } },
      ]);

      recorder.assertOrder(['frame:added', 'frame:updated']);
    });

    it('should throw when events fired in wrong order', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'first' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'second' } },
      ]);

      assert.throws(
        () => recorder.assertOrder(['frame:updated', 'frame:added']),
        /no match found/,
      );
    });

    it('should throw when an event in the sequence never fired', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.throws(
        () => recorder.assertOrder(['frame:added', 'frame:processed']),
        /never did/,
      );
    });
  });

  describe('assertCount', () => {
    it('should pass when count matches', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
        { id: 'f2', type: 'message', content: { text: 'world' } },
      ]);

      recorder.assertCount('frame:added', 2);
    });

    it('should throw when count does not match', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.throws(
        () => recorder.assertCount('frame:added', 5),
        /exactly 5/,
      );
    });
  });

  describe('reset', () => {
    it('should clear all recorded events', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.ok(recorder.events.length > 0);

      recorder.reset();

      assert.equal(recorder.events.length, 0);
      assert.equal(recorder._counter, 0);
    });

    it('should continue recording after reset', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      recorder.reset();

      manager.merge([
        { id: 'f2', type: 'message', content: { text: 'world' } },
      ]);

      assert.ok(recorder.events.length > 0);
    });
  });

  describe('event structure', () => {
    it('should record events with name, payload, order, and timestamp', () => {
      recorder.attach(manager);

      let before = Date.now();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let after = Date.now();
      let event = recorder.events[0];

      assert.ok(event.name, 'event should have a name');
      assert.ok(event.payload !== undefined, 'event should have a payload');
      assert.ok(typeof event.order === 'number', 'event should have an order');
      assert.ok(event.timestamp >= before && event.timestamp <= after, 'event should have a valid timestamp');
    });

    it('should assign monotonically increasing order values', () => {
      recorder.attach(manager);

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
        { id: 'f2', type: 'message', content: { text: 'world' } },
      ]);

      for (let i = 1; i < recorder.events.length; i++)
        assert.ok(recorder.events[i].order > recorder.events[i - 1].order);
    });
  });
});

// ─── HistoryWalker ──────────────────────────────────────────────────────────────

describe('HistoryWalker', () => {
  describe('walk', () => {
    it('should return frames in chronological order (oldest first)', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } },
      ]);

      let frames = HistoryWalker.walk(manager, 'f1');
      assert.equal(frames.length, 2);
      assert.equal(frames[0].content.text, 'v1');
      assert.equal(frames[1].content.text, 'v2');
    });

    it('should return single frame when no history', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let frames = HistoryWalker.walk(manager, 'f1');
      assert.equal(frames.length, 1);
      assert.equal(frames[0].content.text, 'hello');
    });

    it('should return empty array for non-existent frame', () => {
      let manager = new FrameManager();
      let frames  = HistoryWalker.walk(manager, 'nonexistent');
      assert.deepEqual(frames, []);
    });
  });

  describe('walkReverse', () => {
    it('should return frames in reverse order (newest first)', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } },
      ]);

      let frames = HistoryWalker.walkReverse(manager, 'f1');
      assert.equal(frames.length, 2);
      assert.equal(frames[0].content.text, 'v2');
      assert.equal(frames[1].content.text, 'v1');
    });
  });

  describe('assertChainLength', () => {
    it('should pass when chain length matches', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.doesNotThrow(() => HistoryWalker.assertChainLength(manager, 'f1', 1));
    });

    it('should throw when chain length does not match', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.throws(
        () => HistoryWalker.assertChainLength(manager, 'f1', 5),
        /Expected chain length 5.*got 1/,
      );
    });
  });

  describe('assertChainIntegrity', () => {
    it('should pass on valid chain', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } },
      ]);

      assert.doesNotThrow(() => HistoryWalker.assertChainIntegrity(manager, 'f1'));
    });

    it('should throw for non-existent frame', () => {
      let manager = new FrameManager();

      assert.throws(
        () => HistoryWalker.assertChainIntegrity(manager, 'nonexistent'),
        /No pointer found/,
      );
    });

    it('should detect broken forward chain (corrupted next link)', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } },
      ]);

      // Corrupt the chain: break the next link so forward walk cannot reach head
      let pointer = manager._store.pointers.get('f1');
      pointer.next = null;

      assert.throws(
        () => HistoryWalker.assertChainIntegrity(manager, 'f1'),
        /did not reach head/,
      );
    });

    it('should detect cycle in chain', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } },
      ]);

      // Create a cycle: make head.next point back to head
      let pointer      = manager._store.pointers.get('f1');
      let headPointer  = pointer.head;
      headPointer.next = pointer;

      assert.throws(
        () => HistoryWalker.assertChainIntegrity(manager, 'f1'),
        /Cycle detected/,
      );
    });
  });

  describe('assertHeadContent', () => {
    it('should pass when head content matches (subset)', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello', extra: 42 } },
      ]);

      assert.doesNotThrow(() => HistoryWalker.assertHeadContent(manager, 'f1', { text: 'hello' }));
    });

    it('should throw when head content does not match', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.throws(
        () => HistoryWalker.assertHeadContent(manager, 'f1', { text: 'wrong' }),
        /Expected.*text/,
      );
    });
  });

  describe('diff', () => {
    it('should detect added, removed, and changed keys', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello', removed: true } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'updated', added: 'new', removed: null } },
      ]);

      let result = HistoryWalker.diff(manager, 'f1', 0, 1);

      assert.ok('added' in result.added, 'should detect added key');
      assert.ok('removed' in result.removed, 'should detect removed key');
      assert.ok('text' in result.changed, 'should detect changed key');
      assert.deepEqual(result.changed.text, { from: 'hello', to: 'updated' });
    });

    it('should throw for out of range indices', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.throws(() => HistoryWalker.diff(manager, 'f1', 0, 5), RangeError);
      assert.throws(() => HistoryWalker.diff(manager, 'f1', -1, 0), RangeError);
    });
  });
});

// ─── IntegrityChecker ───────────────────────────────────────────────────────────

describe('IntegrityChecker', () => {
  describe('assertValid on valid FrameManager', () => {
    it('should pass for empty FrameManager', () => {
      let manager = new FrameManager();
      assert.doesNotThrow(() => IntegrityChecker.assertValid(manager));
    });

    it('should pass for FrameManager with frames', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'parent', type: 'thread' },
        { id: 'child-1', type: 'message', parentId: 'parent' },
        { id: 'child-2', type: 'message', parentId: 'parent' },
      ]);

      assert.doesNotThrow(() => IntegrityChecker.assertValid(manager));
    });

    it('should pass for FrameManager with version history', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } },
      ]);

      assert.doesNotThrow(() => IntegrityChecker.assertValid(manager));
    });

    it('should pass for FrameManager with history:false', () => {
      let manager = new FrameManager({ history: false });

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } },
      ]);

      assert.doesNotThrow(() => IntegrityChecker.assertValid(manager));
    });
  });

  describe('check detects problems', () => {
    it('should detect orphaned children references', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'parent', type: 'thread' },
        { id: 'child-1', type: 'message', parentId: 'parent' },
      ]);

      // Corrupt: remove child-1 from frames but leave it in children index
      manager._store.frames.remove('child-1');

      let result = IntegrityChecker.check(manager);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('child-1')));
    });

    it('should detect mismatched parentId references', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', parentId: 'nonexistent-parent' },
      ]);

      let result = IntegrityChecker.check(manager);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('nonexistent-parent')));
    });

    it('should return valid:true and empty errors for clean state', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let result = IntegrityChecker.check(manager);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('should detect orphaned pointers (pointer without frame)', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      // Corrupt: remove frame but leave pointer
      manager._store.frames.remove('f1');

      let result = IntegrityChecker.check(manager);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('Pointer exists') && e.includes('f1')));
    });
  });
});
