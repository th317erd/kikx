'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/frame-manager.mjs';
import { Frame } from '../frame-manager/frame.mjs';

describe('FrameManager', () => {
  describe('constructor', () => {
    it('should create with default options', () => {
      let manager = new FrameManager();
      assert.equal(manager.history, true);
      assert.equal(manager._orderCounter, 0);
    });

    it('should default history to true', () => {
      let manager = new FrameManager();
      assert.equal(manager.history, true);
    });

    it('should accept history:false option', () => {
      let manager = new FrameManager({ history: false });
      assert.equal(manager.history, false);
    });
  });

  describe('merge()', () => {
    it('should accept an array and return an array of frames', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      assert.ok(Array.isArray(results));
      assert.equal(results.length, 1);
      assert.ok(results[0] instanceof Frame);
    });

    it('should throw TypeError on non-array argument', () => {
      let manager = new FrameManager();

      assert.throws(() => manager.merge('not-an-array'), TypeError);
      assert.throws(() => manager.merge({}), TypeError);
      assert.throws(() => manager.merge(null), TypeError);
      assert.throws(() => manager.merge(undefined), TypeError);
      assert.throws(() => manager.merge(42), TypeError);
    });

    it('should return empty array for empty input', () => {
      let manager = new FrameManager();
      let results = manager.merge([]);

      assert.deepEqual(results, []);
    });

    it('should silently skip frames without id', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { type: 'message', content: { text: 'no id' } },
        { id: 'f1', type: 'message', content: { text: 'has id' } },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'f1');
    });

    it('should silently skip frames without type', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'f1', content: { text: 'no type' } },
        { id: 'f2', type: 'message', content: { text: 'has type' } },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'f2');
    });

    it('should assign monotonically increasing order', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'message' },
        { id: 'f3', type: 'message' },
      ]);

      assert.equal(results[0].order, 1);
      assert.equal(results[1].order, 2);
      assert.equal(results[2].order, 3);
    });

    it('should create Frame instances from raw data', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' }, parentID: 'p1' },
      ]);

      let frame = results[0];
      assert.ok(frame instanceof Frame);
      assert.equal(frame.id, 'f1');
      assert.equal(frame.type, 'message');
      assert.deepEqual(frame.content, { text: 'hello' });
      assert.equal(frame.parentID, 'p1');
    });

    it('should assign timestamp if not set', () => {
      let manager = new FrameManager();
      let before  = Date.now();
      let results = manager.merge([
        { id: 'f1', type: 'message' },
      ]);
      let after = Date.now();

      assert.ok(results[0].timestamp >= before && results[0].timestamp <= after);
    });

    it('should preserve explicit timestamp', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'f1', type: 'message', timestamp: 1234567890 },
      ]);

      assert.equal(results[0].timestamp, 1234567890);
    });
  });

  describe('get()', () => {
    it('should return frame by ID', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let frame = manager.get('f1');
      assert.ok(frame instanceof Frame);
      assert.equal(frame.id, 'f1');
      assert.deepEqual(frame.content, { text: 'hello' });
    });

    it('should return undefined for non-existent ID', () => {
      let manager = new FrameManager();
      let frame   = manager.get('nonexistent');
      assert.equal(frame, undefined);
    });
  });

  describe('getHead()', () => {
    it('should return HEAD frame', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let head = manager.getHead('f1');
      assert.ok(head instanceof Frame);
      assert.equal(head.id, 'f1');
    });

    it('should return undefined for non-existent ID', () => {
      let manager = new FrameManager();
      let head    = manager.getHead('nonexistent');
      assert.equal(head, undefined);
    });

    it('should behave same as get() when history:false', () => {
      let manager = new FrameManager({ history: false });
      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let frame = manager.get('f1');
      let head  = manager.getHead('f1');
      assert.equal(head, frame);
    });
  });

  describe('getChildren()', () => {
    it('should return children sorted by order', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'parent', type: 'thread' },
        { id: 'child-1', type: 'message', parentID: 'parent' },
        { id: 'child-2', type: 'message', parentID: 'parent' },
        { id: 'child-3', type: 'message', parentID: 'parent' },
      ]);

      let children = manager.getChildren('parent');
      assert.equal(children.length, 3);
      assert.equal(children[0].id, 'child-1');
      assert.equal(children[1].id, 'child-2');
      assert.equal(children[2].id, 'child-3');

      // Verify sorted by order
      assert.ok(children[0].order < children[1].order);
      assert.ok(children[1].order < children[2].order);
    });

    it('should return empty array for no children', () => {
      let manager  = new FrameManager();
      let children = manager.getChildren('nonexistent');
      assert.deepEqual(children, []);
    });
  });

  describe('toArray()', () => {
    it('should return all frames sorted by order', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'event' },
        { id: 'f3', type: 'message' },
      ]);

      let frames = manager.toArray();
      assert.equal(frames.length, 3);
      assert.equal(frames[0].id, 'f1');
      assert.equal(frames[1].id, 'f2');
      assert.equal(frames[2].id, 'f3');
      assert.ok(frames[0].order < frames[1].order);
      assert.ok(frames[1].order < frames[2].order);
    });

    it('should return empty array when no frames exist', () => {
      let manager = new FrameManager();
      let frames  = manager.toArray();
      assert.deepEqual(frames, []);
    });
  });

  describe('[Symbol.iterator]', () => {
    it('should iterate frames in order', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'event' },
        { id: 'f3', type: 'message' },
      ]);

      let ids = [];
      for (let frame of manager)
        ids.push(frame.id);

      assert.deepEqual(ids, ['f1', 'f2', 'f3']);
    });

    it('should work with spread operator', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'event' },
      ]);

      let frames = [...manager];
      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, 'f1');
      assert.equal(frames[1].id, 'f2');
    });
  });

  describe('getVersionHistory()', () => {
    it('should return single-element array in Phase 3 (no merge chains)', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let history = manager.getVersionHistory('f1');
      assert.equal(history.length, 1);
      assert.equal(history[0].id, 'f1');
    });

    it('should return empty array for non-existent frame', () => {
      let manager = new FrameManager();
      let history = manager.getVersionHistory('nonexistent');
      assert.deepEqual(history, []);
    });

    it('should return single-element array when history:false', () => {
      let manager = new FrameManager({ history: false });
      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let history = manager.getVersionHistory('f1');
      assert.equal(history.length, 1);
      assert.equal(history[0].id, 'f1');
    });
  });

  describe('multiple merges', () => {
    it('should maintain correct state across multiple merge calls', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'first' } },
      ]);

      manager.merge([
        { id: 'f2', type: 'event', content: { text: 'second' } },
      ]);

      assert.equal(manager.get('f1').id, 'f1');
      assert.equal(manager.get('f2').id, 'f2');

      let frames = manager.toArray();
      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, 'f1');
      assert.equal(frames[1].id, 'f2');
    });

    it('should persist order counter across merge calls', () => {
      let manager = new FrameManager();

      let first = manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'message' },
      ]);

      let second = manager.merge([
        { id: 'f3', type: 'message' },
      ]);

      assert.equal(first[0].order, 1);
      assert.equal(first[1].order, 2);
      assert.equal(second[0].order, 3);
    });

    it('should index children across multiple merge calls', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'parent', type: 'thread' },
        { id: 'child-1', type: 'message', parentID: 'parent' },
      ]);

      manager.merge([
        { id: 'child-2', type: 'message', parentID: 'parent' },
      ]);

      let children = manager.getChildren('parent');
      assert.equal(children.length, 2);
      assert.equal(children[0].id, 'child-1');
      assert.equal(children[1].id, 'child-2');
    });
  });
});
