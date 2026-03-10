'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/frame-manager.mjs';

describe('FrameManager Events', () => {
  describe('frame:added', () => {
    it('should fire when a new frame is merged', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('frame:added', () => { fired = true; });
      manager.merge([{ id: 'f1', type: 'message' }]);

      assert.equal(fired, true);
    });

    it('should fire frame:added:{id} with correct frame ID', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frame:added:f1', (payload) => { captured = payload; });
      manager.merge([{ id: 'f1', type: 'message', content: { text: 'hello' } }]);

      assert.ok(captured);
      assert.equal(captured.frame.id, 'f1');
    });

    it('should include the frame in the payload', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frame:added', (payload) => { captured = payload; });
      manager.merge([{ id: 'f1', type: 'message', content: { text: 'hello' } }]);

      assert.ok(captured);
      assert.ok(captured.frame);
      assert.equal(captured.frame.id, 'f1');
      assert.equal(captured.frame.type, 'message');
      assert.deepEqual(captured.frame.content, { text: 'hello' });
    });

    it('should NOT fire when options.events === false', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('frame:added', () => { fired = true; });
      manager.merge([{ id: 'f1', type: 'message' }], { events: false });

      assert.equal(fired, false);
    });

    it('should fire for each frame in a multi-frame merge', () => {
      let manager = new FrameManager();
      let ids     = [];

      manager.on('frame:added', (payload) => { ids.push(payload.frame.id); });
      manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'message' },
        { id: 'f3', type: 'message' },
      ]);

      assert.deepEqual(ids, ['f1', 'f2', 'f3']);
    });

    it('should NOT fire for phantom frames', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('frame:added', () => { fired = true; });
      manager.merge([{ id: 'f1', type: 'message', phantom: true }]);

      assert.equal(fired, false);
    });

    it('should fire synchronously (callback runs before merge returns)', () => {
      let manager     = new FrameManager();
      let callbackRan = false;
      let ranBefore   = false;

      manager.on('frame:added', () => { callbackRan = true; });

      // If synchronous, callbackRan will be true immediately after merge returns
      manager.merge([{ id: 'f1', type: 'message' }]);
      ranBefore = callbackRan;

      assert.equal(ranBefore, true, 'Event callback should run synchronously during merge');
    });
  });

  describe('frames:bulk-loaded', () => {
    it('should fire when options.events === false', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frames:bulk-loaded', (payload) => { captured = payload; });
      manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'message' },
      ], { events: false });

      assert.ok(captured);
    });

    it('should include count in the payload', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frames:bulk-loaded', (payload) => { captured = payload; });
      manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'message' },
        { id: 'f3', type: 'message' },
      ], { events: false });

      assert.equal(captured.count, 3);
    });

    it('should NOT fire when events are not suppressed', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('frames:bulk-loaded', () => { fired = true; });
      manager.merge([{ id: 'f1', type: 'message' }]);

      assert.equal(fired, false);
    });
  });

  describe('frame:updated', () => {
    it('should fire when a target is merged', () => {
      let manager  = new FrameManager();
      let captured = null;

      // Create the target frame first
      manager.merge([{ id: 'target1', type: 'message', content: { text: 'original' } }]);

      manager.on('frame:updated', (payload) => { captured = payload; });

      // Now merge a frame that targets it
      manager.merge([{ id: 'delta1', type: 'message', targets: ['target1'], content: { text: 'updated' } }]);

      assert.ok(captured);
      assert.equal(captured.frame.id, 'target1');
      assert.ok(captured.previousHead);
    });

    it('should fire frame:updated:{targetID} with correct ID', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.merge([{ id: 'target1', type: 'message', content: { text: 'original' } }]);

      manager.on('frame:updated:target1', (payload) => { captured = payload; });

      manager.merge([{ id: 'delta1', type: 'message', targets: ['target1'], content: { text: 'updated' } }]);

      assert.ok(captured);
      assert.equal(captured.frame.id, 'target1');
    });

    it('should include previousHead in the payload', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.merge([{ id: 'target1', type: 'message', content: { text: 'original' } }]);

      manager.on('frame:updated', (payload) => { captured = payload; });

      manager.merge([{ id: 'delta1', type: 'message', targets: ['target1'], content: { text: 'updated' } }]);

      assert.ok(captured.previousHead);
      assert.deepEqual(captured.previousHead.content, { text: 'original' });
    });

    it('should NOT fire frame:updated when options.events === false', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.merge([{ id: 'target1', type: 'message', content: { text: 'original' } }]);

      manager.on('frame:updated', () => { fired = true; });

      manager.merge([{ id: 'delta1', type: 'message', targets: ['target1'], content: { text: 'updated' } }], { events: false });

      assert.equal(fired, false);
    });
  });

  describe('setProcessed()', () => {
    it('should set processed and processedAt on the frame', () => {
      let manager = new FrameManager();
      manager.merge([{ id: 'f1', type: 'message' }]);

      let before = Date.now();
      manager.setProcessed('f1', 'abc123');
      let after = Date.now();

      let frame = manager.getHead('f1');
      assert.equal(frame.processed, 'abc123');
      assert.ok(frame.processedAt >= before && frame.processedAt <= after);
    });

    it('should emit frame:processed after setProcessed', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.merge([{ id: 'f1', type: 'message' }]);
      manager.on('frame:processed', (payload) => { captured = payload; });

      manager.setProcessed('f1', 'fp-001');

      assert.ok(captured);
      assert.equal(captured.frame.id, 'f1');
      assert.equal(captured.frame.processed, 'fp-001');
    });

    it('should emit frame:processed:{id} with correct frame ID', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.merge([{ id: 'f1', type: 'message' }]);
      manager.on('frame:processed:f1', (payload) => { captured = payload; });

      manager.setProcessed('f1', 'fp-002');

      assert.ok(captured);
      assert.equal(captured.frame.id, 'f1');
    });

    it('should be a no-op with no event for non-existent frame', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('frame:processed', () => { fired = true; });
      manager.setProcessed('nonexistent', 'fp-999');

      assert.equal(fired, false);
    });

    it('should work correctly with history:false', () => {
      let manager = new FrameManager({ history: false });
      manager.merge([{ id: 'f1', type: 'message' }]);

      manager.setProcessed('f1', 'fp-no-hist');

      let frame = manager.getHead('f1');
      assert.equal(frame.processed, 'fp-no-hist');
      assert.ok(frame.processedAt);
    });
  });

  describe('onFrameEvent / offFrameEvent', () => {
    it('should subscribe to namespaced events via onFrameEvent', () => {
      let manager  = new FrameManager();
      let captured = null;

      let callback = (payload) => { captured = payload; };
      manager.onFrameEvent('frame:added', 'f1', callback);

      manager.merge([{ id: 'f1', type: 'message' }]);

      assert.ok(captured);
      assert.equal(captured.frame.id, 'f1');
    });

    it('should unsubscribe from namespaced events via offFrameEvent', () => {
      let manager = new FrameManager();
      let count   = 0;

      let callback = () => { count++; };
      manager.onFrameEvent('frame:added', 'f1', callback);

      // First merge triggers the event
      manager.merge([{ id: 'f1', type: 'message' }]);
      assert.equal(count, 1);

      // Unsubscribe
      manager.offFrameEvent('frame:added', 'f1', callback);

      // Second merge with same ID — would fire frame:added:f1 again if still subscribed
      // But since the ID is the same, it will just overwrite. Let's use a different approach:
      // Emit directly to test unsubscription
      manager.emit('frame:added:f1', { frame: { id: 'f1' } });
      assert.equal(count, 1, 'Should not have incremented after offFrameEvent');
    });
  });

  describe('on / off (generic event subscription)', () => {
    it('should subscribe to events via on()', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('custom:event', () => { fired = true; });
      manager.emit('custom:event', {});

      assert.equal(fired, true);
    });

    it('should unsubscribe from events via off()', () => {
      let manager = new FrameManager();
      let count   = 0;

      let callback = () => { count++; };
      manager.on('custom:event', callback);

      manager.emit('custom:event', {});
      assert.equal(count, 1);

      manager.off('custom:event', callback);
      manager.emit('custom:event', {});
      assert.equal(count, 1, 'Should not fire after off()');
    });

    it('on() should return the manager for chaining', () => {
      let manager = new FrameManager();
      let result  = manager.on('some:event', () => {});

      assert.equal(result, manager);
    });

    it('off() should return the manager for chaining', () => {
      let manager  = new FrameManager();
      let callback = () => {};
      manager.on('some:event', callback);
      let result = manager.off('some:event', callback);

      assert.equal(result, manager);
    });

    it('emit() should return the manager for chaining', () => {
      let manager = new FrameManager();
      let result  = manager.emit('some:event', {});

      assert.equal(result, manager);
    });
  });

  describe('synchronous event semantics', () => {
    it('frame:added callback completes before merge() returns', () => {
      let manager = new FrameManager();
      let order   = [];

      manager.on('frame:added', () => { order.push('event'); });

      manager.merge([{ id: 'f1', type: 'message' }]);
      order.push('after-merge');

      assert.deepEqual(order, ['event', 'after-merge']);
    });

    it('frame:updated callback completes before merge() returns', () => {
      let manager = new FrameManager();
      let order   = [];

      manager.merge([{ id: 'target1', type: 'message', content: { text: 'original' } }]);

      manager.on('frame:updated', () => { order.push('event'); });

      manager.merge([{ id: 'delta1', type: 'message', targets: ['target1'], content: { text: 'updated' } }]);
      order.push('after-merge');

      assert.deepEqual(order, ['event', 'after-merge']);
    });

    it('frame:processed callback completes before setProcessed() returns', () => {
      let manager = new FrameManager();
      let order   = [];

      manager.merge([{ id: 'f1', type: 'message' }]);
      manager.on('frame:processed', () => { order.push('event'); });

      manager.setProcessed('f1', 'fp-sync');
      order.push('after-set');

      assert.deepEqual(order, ['event', 'after-set']);
    });
  });
});
