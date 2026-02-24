'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Frame } from '../frame-manager/frame.mjs';
import { FramePointer } from '../frame-manager/frame-pointer.mjs';

describe('FramePointer', () => {
  describe('single pointer', () => {
    it('should have head and tail pointing to itself', () => {
      let frame   = new Frame({ id: 'f1', type: 'message' });
      let pointer = new FramePointer(frame);

      assert.equal(pointer.head, pointer);
      assert.equal(pointer.tail, pointer);
      assert.equal(pointer.previous, null);
      assert.equal(pointer.next, null);
      assert.equal(pointer.frame, frame);
    });
  });

  describe('chain of 2', () => {
    it('should link previous and next correctly', () => {
      let frame1   = new Frame({ id: 'f1', type: 'message' });
      let frame2   = new Frame({ id: 'f2', type: 'message' });
      let pointer1 = new FramePointer(frame1);
      let pointer2 = new FramePointer(frame2, pointer1);

      assert.equal(pointer1.next, pointer2);
      assert.equal(pointer2.previous, pointer1);
      assert.equal(pointer1.previous, null);
      assert.equal(pointer2.next, null);
    });

    it('should have consistent head and tail across the chain', () => {
      let frame1   = new Frame({ id: 'f1', type: 'message' });
      let frame2   = new Frame({ id: 'f2', type: 'message' });
      let pointer1 = new FramePointer(frame1);
      let pointer2 = new FramePointer(frame2, pointer1);

      assert.equal(pointer1.head, pointer1);
      assert.equal(pointer2.head, pointer1);
      assert.equal(pointer1.tail, pointer2);
      assert.equal(pointer2.tail, pointer2);
    });
  });

  describe('chain of 3', () => {
    it('should support full traversal from tail to head via previous', () => {
      let frame1   = new Frame({ id: 'f1', type: 'message' });
      let frame2   = new Frame({ id: 'f2', type: 'message' });
      let frame3   = new Frame({ id: 'f3', type: 'message' });
      let pointer1 = new FramePointer(frame1);
      let pointer2 = new FramePointer(frame2, pointer1);
      let pointer3 = new FramePointer(frame3, pointer2);

      // Walk from tail to head via previous
      let collected = [];
      let current   = pointer3.tail;
      while (current) {
        collected.push(current.frame.id);
        current = current.previous;
      }

      assert.deepEqual(collected, ['f3', 'f2', 'f1']);
    });

    it('should support full traversal from head to tail via next', () => {
      let frame1   = new Frame({ id: 'f1', type: 'message' });
      let frame2   = new Frame({ id: 'f2', type: 'message' });
      let frame3   = new Frame({ id: 'f3', type: 'message' });
      let pointer1 = new FramePointer(frame1);
      let pointer2 = new FramePointer(frame2, pointer1);
      let pointer3 = new FramePointer(frame3, pointer2);

      // Walk from head to tail via next
      let collected = [];
      let current   = pointer1.head;
      while (current) {
        collected.push(current.frame.id);
        current = current.next;
      }

      assert.deepEqual(collected, ['f1', 'f2', 'f3']);
    });

    it('should have consistent head and tail for all pointers', () => {
      let frame1   = new Frame({ id: 'f1', type: 'message' });
      let frame2   = new Frame({ id: 'f2', type: 'message' });
      let frame3   = new Frame({ id: 'f3', type: 'message' });
      let pointer1 = new FramePointer(frame1);
      let pointer2 = new FramePointer(frame2, pointer1);
      let pointer3 = new FramePointer(frame3, pointer2);

      // All pointers should agree on head
      assert.equal(pointer1.head, pointer1);
      assert.equal(pointer2.head, pointer1);
      assert.equal(pointer3.head, pointer1);

      // All pointers should agree on tail
      assert.equal(pointer1.tail, pointer3);
      assert.equal(pointer2.tail, pointer3);
      assert.equal(pointer3.tail, pointer3);
    });
  });

  describe('multiple pointers referencing same Frame', () => {
    it('should maintain independent chains', () => {
      let frame    = new Frame({ id: 'shared', type: 'message' });
      let pointerA = new FramePointer(frame);
      let pointerB = new FramePointer(frame);

      assert.equal(pointerA.frame, pointerB.frame);
      assert.equal(pointerA.head, pointerA);
      assert.equal(pointerB.head, pointerB);
      assert.equal(pointerA.tail, pointerA);
      assert.equal(pointerB.tail, pointerB);
      assert.equal(pointerA.next, null);
      assert.equal(pointerB.next, null);
      assert.equal(pointerA.previous, null);
      assert.equal(pointerB.previous, null);
    });
  });

  describe('updateHead', () => {
    it('should propagate the new head to all pointers in the chain', () => {
      let frame1   = new Frame({ id: 'f1', type: 'message' });
      let frame2   = new Frame({ id: 'f2', type: 'message' });
      let frame3   = new Frame({ id: 'f3', type: 'message' });
      let pointer1 = new FramePointer(frame1);
      let pointer2 = new FramePointer(frame2, pointer1);
      let pointer3 = new FramePointer(frame3, pointer2);

      // Create a new pointer to be the new head
      let newFrame      = new Frame({ id: 'new-head', type: 'message' });
      let newHeadPointer = new FramePointer(newFrame);

      pointer2.updateHead(newHeadPointer);

      assert.equal(pointer1.head, newHeadPointer);
      assert.equal(pointer2.head, newHeadPointer);
      assert.equal(pointer3.head, newHeadPointer);
    });

    it('should work when called from any pointer in the chain', () => {
      let frame1   = new Frame({ id: 'f1', type: 'message' });
      let frame2   = new Frame({ id: 'f2', type: 'message' });
      let pointer1 = new FramePointer(frame1);
      let pointer2 = new FramePointer(frame2, pointer1);

      let sentinel      = new Frame({ id: 'sentinel', type: 'marker' });
      let sentinelPointer = new FramePointer(sentinel);

      // Call from the tail pointer
      pointer2.updateHead(sentinelPointer);

      assert.equal(pointer1.head, sentinelPointer);
      assert.equal(pointer2.head, sentinelPointer);
    });
  });

  describe('chain integrity', () => {
    it('should walk from tail to head via next references', () => {
      let frames   = [];
      let pointers = [];

      for (let i = 0; i < 5; i++) {
        let frame   = new Frame({ id: `f${i}`, type: 'message' });
        let previous = (i > 0) ? pointers[i - 1] : null;
        let pointer = new FramePointer(frame, previous);

        frames.push(frame);
        pointers.push(pointer);
      }

      // Walk from head to tail via next
      let visited = [];
      let current = pointers[0].head;
      while (current) {
        visited.push(current.frame.id);
        current = current.next;
      }

      assert.deepEqual(visited, ['f0', 'f1', 'f2', 'f3', 'f4']);
    });

    it('should walk from head to tail via previous references', () => {
      let frames   = [];
      let pointers = [];

      for (let i = 0; i < 5; i++) {
        let frame    = new Frame({ id: `f${i}`, type: 'message' });
        let previous = (i > 0) ? pointers[i - 1] : null;
        let pointer  = new FramePointer(frame, previous);

        frames.push(frame);
        pointers.push(pointer);
      }

      // Walk from tail to head via previous
      let visited = [];
      let current = pointers[4].tail;
      while (current) {
        visited.push(current.frame.id);
        current = current.previous;
      }

      assert.deepEqual(visited, ['f4', 'f3', 'f2', 'f1', 'f0']);
    });
  });
});
