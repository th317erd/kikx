'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Frame } from '../frame-manager/frame.mjs';

describe('Frame', () => {
  describe('constructor defaults', () => {
    it('should apply all defaults when no data is provided', () => {
      let before = Date.now();
      let frame  = new Frame();
      let after  = Date.now();

      assert.equal(frame.id, undefined);
      assert.equal(frame.type, undefined);
      assert.deepEqual(frame.targets, []);
      assert.equal(frame.phantom, false);
      assert.deepEqual(frame.content, {});
      assert.equal(frame.parentID, null);
      assert.equal(frame.groupID, null);
      assert.equal(frame.groupType, null);
      assert.equal(frame.order, 0);
      assert.equal(frame.hidden, true);
      assert.equal(frame.deleted, false);
      assert.equal(frame.processed, null);
      assert.equal(frame.processedAt, null);

      assert.ok(frame.timestamp >= before && frame.timestamp <= after);
      assert.ok(frame.updatedAt >= before && frame.updatedAt <= after);
      assert.ok(frame.createdAt >= before && frame.createdAt <= after);
    });

    it('should default hidden to true', () => {
      let frame = new Frame();
      assert.equal(frame.hidden, true);
    });

    it('should default deleted to false', () => {
      let frame = new Frame();
      assert.equal(frame.deleted, false);
    });

    it('should default content to an empty object', () => {
      let frame = new Frame();
      assert.deepEqual(frame.content, {});
    });

    it('should default targets to an empty array', () => {
      let frame = new Frame();
      assert.deepEqual(frame.targets, []);
    });

    it('should default timestamp, updatedAt, and createdAt to Date.now()', () => {
      let before = Date.now();
      let frame  = new Frame();
      let after  = Date.now();

      assert.ok(frame.timestamp >= before && frame.timestamp <= after);
      assert.ok(frame.updatedAt >= before && frame.updatedAt <= after);
      assert.ok(frame.createdAt >= before && frame.createdAt <= after);
    });

    it('should leave id and type as undefined when not provided', () => {
      let frame = new Frame();
      assert.equal(frame.id, undefined);
      assert.equal(frame.type, undefined);
    });
  });

  describe('constructor with provided values', () => {
    it('should use provided values over defaults', () => {
      let data = {
        id:          'abc123',
        type:        'message',
        targets:     ['user-1', 'user-2'],
        phantom:     true,
        content:     { text: 'hello' },
        parentID:    'parent-1',
        groupID:     'group-1',
        groupType:   'thread',
        order:       5,
        timestamp:   1000,
        hidden:      false,
        deleted:     true,
        updatedAt:   2000,
        createdAt:   3000,
        processed:   'complete',
        processedAt: 4000,
      };

      let frame = new Frame(data);

      assert.equal(frame.id, 'abc123');
      assert.equal(frame.type, 'message');
      assert.deepEqual(frame.targets, ['user-1', 'user-2']);
      assert.equal(frame.phantom, true);
      assert.deepEqual(frame.content, { text: 'hello' });
      assert.equal(frame.parentID, 'parent-1');
      assert.equal(frame.groupID, 'group-1');
      assert.equal(frame.groupType, 'thread');
      assert.equal(frame.order, 5);
      assert.equal(frame.timestamp, 1000);
      assert.equal(frame.hidden, false);
      assert.equal(frame.deleted, true);
      assert.equal(frame.updatedAt, 2000);
      assert.equal(frame.createdAt, 3000);
      assert.equal(frame.processed, 'complete');
      assert.equal(frame.processedAt, 4000);
    });

    it('should allow partial overrides while keeping other defaults', () => {
      let frame = new Frame({ id: 'xyz', type: 'event', order: 10 });

      assert.equal(frame.id, 'xyz');
      assert.equal(frame.type, 'event');
      assert.equal(frame.order, 10);
      assert.deepEqual(frame.targets, []);
      assert.equal(frame.phantom, false);
      assert.deepEqual(frame.content, {});
      assert.equal(frame.hidden, true);
      assert.equal(frame.deleted, false);
    });
  });
});
