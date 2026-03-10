'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/frame-manager.mjs';

function shuffle(array) {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateFrames(count, options = {}) {
  let frames = [];

  for (let i = 0; i < count; i++) {
    let frame = {
      id:   `frame-${i}`,
      type: 'message',
      content: { text: `content-${i}`, index: i },
    };

    if (options.parentID)
      frame.parentID = options.parentID;

    frames.push(frame);
  }

  return frames;
}

describe('FrameManager Bulk Loading', () => {
  describe('event suppression', () => {
    it('should not fire per-frame events during bulk load', () => {
      let manager    = new FrameManager();
      let addedCount = 0;

      manager.on('frame:added', () => { addedCount++; });

      let frames = generateFrames(20);
      manager.merge(frames, { events: false });

      assert.equal(addedCount, 0, 'frame:added should not fire during bulk load');
    });

    it('should fire frames:bulk-loaded exactly once', () => {
      let manager   = new FrameManager();
      let fireCount = 0;

      manager.on('frames:bulk-loaded', () => { fireCount++; });

      let frames = generateFrames(20);
      manager.merge(frames, { events: false });

      assert.equal(fireCount, 1, 'frames:bulk-loaded should fire exactly once');
    });

    it('should report correct count in frames:bulk-loaded payload', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frames:bulk-loaded', (payload) => { captured = payload; });

      let frames = generateFrames(20);
      manager.merge(frames, { events: false });

      assert.ok(captured);
      assert.equal(captured.count, 20);
    });
  });

  describe('data integrity after bulk load', () => {
    it('should make all frames retrievable by ID', () => {
      let manager = new FrameManager();
      let frames  = generateFrames(20);
      manager.merge(frames, { events: false });

      for (let i = 0; i < 20; i++) {
        let frame = manager.get(`frame-${i}`);
        assert.ok(frame, `frame-${i} should be retrievable`);
        assert.equal(frame.id, `frame-${i}`);
        assert.deepEqual(frame.content, { text: `content-${i}`, index: i });
      }
    });

    it('should iterate frames in correct order after bulk load', () => {
      let manager = new FrameManager();
      let frames  = generateFrames(20);
      manager.merge(frames, { events: false });

      let iterated = [...manager];
      assert.equal(iterated.length, 20);

      for (let i = 0; i < 20; i++)
        assert.equal(iterated[i].id, `frame-${i}`);
    });

    it('should maintain parent-child relationships after bulk load', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'parent-1', type: 'thread' },
        { id: 'parent-2', type: 'thread' },
      ], { events: false });

      let children = [];
      for (let i = 0; i < 6; i++) {
        let parentID = (i < 3) ? 'parent-1' : 'parent-2';
        children.push({
          id:       `child-${i}`,
          type:     'message',
          parentID: parentID,
          content:  { index: i },
        });
      }

      manager.merge(children, { events: false });

      let parent1Children = manager.getChildren('parent-1');
      assert.equal(parent1Children.length, 3);
      assert.equal(parent1Children[0].id, 'child-0');
      assert.equal(parent1Children[1].id, 'child-1');
      assert.equal(parent1Children[2].id, 'child-2');

      let parent2Children = manager.getChildren('parent-2');
      assert.equal(parent2Children.length, 3);
      assert.equal(parent2Children[0].id, 'child-3');
      assert.equal(parent2Children[1].id, 'child-4');
      assert.equal(parent2Children[2].id, 'child-5');
    });

    it('should return correct sorted children via getChildren', () => {
      let manager = new FrameManager();

      let frames = [
        { id: 'root', type: 'thread' },
        { id: 'c-3', type: 'message', parentID: 'root', content: { label: 'third' } },
        { id: 'c-1', type: 'message', parentID: 'root', content: { label: 'first' } },
        { id: 'c-2', type: 'message', parentID: 'root', content: { label: 'second' } },
      ];

      manager.merge(frames, { events: false });

      let children = manager.getChildren('root');
      assert.equal(children.length, 3);

      // Order is by the order field assigned during merge, which is insertion order
      assert.equal(children[0].id, 'c-3');
      assert.equal(children[1].id, 'c-1');
      assert.equal(children[2].id, 'c-2');

      // Verify order values are ascending
      assert.ok(children[0].order < children[1].order);
      assert.ok(children[1].order < children[2].order);
    });
  });

  describe('any-order insertion correctness', () => {
    it('should produce same final state regardless of insertion order', () => {
      // Create frames with distinct content
      let frameData = [];
      for (let i = 0; i < 20; i++) {
        frameData.push({
          id:      `frame-${i}`,
          type:    'message',
          content: { text: `content-${i}`, index: i },
        });
      }

      // Load in order
      let orderedManager = new FrameManager();
      orderedManager.merge([...frameData], { events: false });

      // Load in shuffled order
      let shuffledManager = new FrameManager();
      let shuffledData    = shuffle(frameData);
      shuffledManager.merge(shuffledData, { events: false });

      // Both should have same frames retrievable by ID
      for (let i = 0; i < 20; i++) {
        let orderedFrame  = orderedManager.get(`frame-${i}`);
        let shuffledFrame = shuffledManager.get(`frame-${i}`);

        assert.ok(orderedFrame, `ordered manager should have frame-${i}`);
        assert.ok(shuffledFrame, `shuffled manager should have frame-${i}`);

        assert.equal(orderedFrame.id, shuffledFrame.id);
        assert.deepEqual(orderedFrame.content, shuffledFrame.content);
      }

      // Both should have same set of frame IDs when iterated
      let orderedIds  = orderedManager.toArray().map((f) => f.id).sort();
      let shuffledIds = shuffledManager.toArray().map((f) => f.id).sort();
      assert.deepEqual(orderedIds, shuffledIds);
    });

    it('should produce correct parent-child relationships regardless of insertion order', () => {
      let frameData = [
        { id: 'parent', type: 'thread' },
        { id: 'child-a', type: 'message', parentID: 'parent', content: { label: 'a' } },
        { id: 'child-b', type: 'message', parentID: 'parent', content: { label: 'b' } },
        { id: 'child-c', type: 'message', parentID: 'parent', content: { label: 'c' } },
      ];

      // Load in order
      let orderedManager = new FrameManager();
      orderedManager.merge([...frameData], { events: false });

      // Load shuffled (children before parent is the interesting case)
      let shuffledManager = new FrameManager();
      let shuffledData    = shuffle(frameData);
      shuffledManager.merge(shuffledData, { events: false });

      // Both should have all children for parent
      let orderedChildren  = orderedManager.getChildren('parent');
      let shuffledChildren = shuffledManager.getChildren('parent');

      assert.equal(orderedChildren.length, 3);
      assert.equal(shuffledChildren.length, 3);

      // Same child IDs (sorted, since order may differ based on insertion)
      let orderedChildIds  = orderedChildren.map((f) => f.id).sort();
      let shuffledChildIds = shuffledChildren.map((f) => f.id).sort();
      assert.deepEqual(orderedChildIds, shuffledChildIds);
    });

    it('should handle 5 different shuffles and produce consistent results', () => {
      let frameData = [];
      for (let i = 0; i < 20; i++) {
        frameData.push({
          id:      `frame-${i}`,
          type:    'message',
          content: { text: `content-${i}`, index: i },
        });
      }

      // Add parent-child relationships
      frameData.push({ id: 'parent-x', type: 'thread' });
      for (let i = 0; i < 5; i++) {
        frameData.push({
          id:       `child-x-${i}`,
          type:     'message',
          parentID: 'parent-x',
          content:  { childIndex: i },
        });
      }

      let expectedIds = frameData.map((f) => f.id).sort();

      for (let run = 0; run < 5; run++) {
        let manager     = new FrameManager();
        let shuffled    = shuffle(frameData);
        manager.merge(shuffled, { events: false });

        let actualIds = manager.toArray().map((f) => f.id).sort();
        assert.deepEqual(actualIds, expectedIds, `Run ${run}: frame IDs should match`);

        // Verify parent-child
        let children    = manager.getChildren('parent-x');
        let childIds    = children.map((f) => f.id).sort();
        let expectedChildIds = ['child-x-0', 'child-x-1', 'child-x-2', 'child-x-3', 'child-x-4'];
        assert.deepEqual(childIds, expectedChildIds, `Run ${run}: children should match`);
      }
    });
  });

  describe('bulk load followed by live interaction', () => {
    it('should merge live frames correctly on top of bulk-loaded frames', () => {
      let manager = new FrameManager();

      // Bulk load initial state
      manager.merge([
        { id: 'f1', type: 'message', content: { text: 'bulk-1' } },
        { id: 'f2', type: 'message', content: { text: 'bulk-2' } },
        { id: 'f3', type: 'message', content: { text: 'bulk-3' } },
      ], { events: false });

      // Live frames added normally
      manager.merge([
        { id: 'f4', type: 'message', content: { text: 'live-4' } },
        { id: 'f5', type: 'message', content: { text: 'live-5' } },
      ]);

      let allFrames = manager.toArray();
      assert.equal(allFrames.length, 5);

      // All should be retrievable
      assert.equal(manager.get('f1').content.text, 'bulk-1');
      assert.equal(manager.get('f4').content.text, 'live-4');
      assert.equal(manager.get('f5').content.text, 'live-5');

      // Order should reflect insertion sequence
      let ids = allFrames.map((f) => f.id);
      assert.deepEqual(ids, ['f1', 'f2', 'f3', 'f4', 'f5']);
    });

    it('should resume events for live frames after bulk load', () => {
      let manager  = new FrameManager();
      let addedIds = [];

      manager.on('frame:added', (payload) => { addedIds.push(payload.frame.id); });

      // Bulk load: no events
      manager.merge([
        { id: 'f1', type: 'message' },
        { id: 'f2', type: 'message' },
      ], { events: false });

      assert.equal(addedIds.length, 0, 'No events during bulk load');

      // Live merge: events should fire
      manager.merge([
        { id: 'f3', type: 'message' },
        { id: 'f4', type: 'message' },
      ]);

      assert.deepEqual(addedIds, ['f3', 'f4'], 'Events should resume for live frames');
    });
  });

  describe('bulk load with merge targets', () => {
    it('should execute merge logic for frames with targets during bulk load', () => {
      let manager = new FrameManager();

      // First, create the target frame
      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'original', status: 'pending' } },
      ], { events: false });

      // Now bulk-load a frame that targets it
      manager.merge([
        { id: 'delta-1', type: 'message', targets: ['target-1'], content: { status: 'complete' } },
      ], { events: false });

      let head = manager.getHead('target-1');
      assert.ok(head);
      assert.equal(head.content.text, 'original');
      assert.equal(head.content.status, 'complete');
    });

    it('should not fire frame:updated during bulk load with merge targets', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'original' } },
      ], { events: false });

      manager.on('frame:updated', () => { fired = true; });

      manager.merge([
        { id: 'delta-1', type: 'message', targets: ['target-1'], content: { text: 'updated' } },
      ], { events: false });

      assert.equal(fired, false, 'frame:updated should not fire during bulk load');
    });
  });

  describe('bulk load with duplicate IDs', () => {
    it('should let last frame win when duplicate IDs are bulk-loaded', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'dup-1', type: 'message', content: { text: 'first version' } },
        { id: 'dup-1', type: 'message', content: { text: 'second version' } },
      ], { events: false });

      let frame = manager.get('dup-1');
      assert.ok(frame);
      assert.equal(frame.content.text, 'second version');
    });
  });

  describe('bulk load edge cases', () => {
    it('should be a no-op for empty array with no events', () => {
      let manager   = new FrameManager();
      let anyFired  = false;

      manager.on('frame:added', () => { anyFired = true; });
      manager.on('frames:bulk-loaded', () => { anyFired = true; });

      let results = manager.merge([], { events: false });

      assert.deepEqual(results, []);
      assert.equal(anyFired, false, 'No events should fire for empty bulk load');
    });

    it('should handle large bulk load of 100 frames without issues', () => {
      let manager = new FrameManager();
      let frames  = generateFrames(100);

      let captured = null;
      manager.on('frames:bulk-loaded', (payload) => { captured = payload; });

      manager.merge(frames, { events: false });

      // All 100 frames retrievable
      for (let i = 0; i < 100; i++) {
        let frame = manager.get(`frame-${i}`);
        assert.ok(frame, `frame-${i} should exist`);
      }

      // Correct count
      let allFrames = manager.toArray();
      assert.equal(allFrames.length, 100);

      // Event payload correct
      assert.ok(captured);
      assert.equal(captured.count, 100);

      // Order is correct
      for (let i = 1; i < allFrames.length; i++)
        assert.ok(allFrames[i - 1].order < allFrames[i].order, 'Frames should be sorted by order');
    });
  });
});
