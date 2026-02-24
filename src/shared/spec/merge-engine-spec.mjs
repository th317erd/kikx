'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/frame-manager.mjs';
import { Frame } from '../frame-manager/frame.mjs';

describe('Merge Engine', () => {
  describe('target merge: content', () => {
    it('should deep-merge content into target', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'hello', meta: { lang: 'en' } } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { extra: 'data', meta: { author: 'bot' } } },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.content.text, 'hello');
      assert.equal(head.content.extra, 'data');
      assert.equal(head.content.meta.lang, 'en');
      assert.equal(head.content.meta.author, 'bot');
    });

    it('should handle null deletion in content', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'hello', remove: 'me' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { remove: null } },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.content.text, 'hello');
      assert.equal(head.content.remove, undefined);
      assert.ok(!('remove' in head.content));
    });

    it('should handle array replacement in content', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { tags: ['old', 'tags'] } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { tags: ['new'] } },
      ]);

      let head = manager.getHead('target-1');
      assert.deepEqual(head.content.tags, ['new']);
    });
  });

  describe('target merge: non-mergeable properties', () => {
    it('should NOT propagate id, type, parentId from source', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', parentId: 'parent-1', content: { text: 'hello' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge-op', parentId: 'parent-2', targets: ['target-1'], content: { extra: 'data' } },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.id, 'target-1');
      assert.equal(head.type, 'message');
      assert.equal(head.parentId, 'parent-1');
    });
  });

  describe('target merge: mergeable scalar properties', () => {
    it('should propagate hidden from source', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', hidden: true },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], hidden: false },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.hidden, false);
    });

    it('should propagate deleted from source', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', deleted: false },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], deleted: true },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.deleted, true);
    });

    it('should propagate updatedAt from source', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', updatedAt: 1000 },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], updatedAt: 2000 },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.updatedAt, 2000);
    });
  });

  describe('multi-target merge', () => {
    it('should apply content to each target identically', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'first' } },
        { id: 'target-2', type: 'message', content: { text: 'second' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1', 'target-2'], content: { extra: 'data' } },
      ]);

      let head1 = manager.getHead('target-1');
      let head2 = manager.getHead('target-2');

      assert.equal(head1.content.text, 'first');
      assert.equal(head1.content.extra, 'data');
      assert.equal(head2.content.text, 'second');
      assert.equal(head2.content.extra, 'data');
    });

    it('should update each target independently', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { a: 1 } },
        { id: 'target-2', type: 'event', content: { b: 2 } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1', 'target-2'], content: { c: 3 }, hidden: false },
      ]);

      let head1 = manager.getHead('target-1');
      let head2 = manager.getHead('target-2');

      // Each preserves its own id, type, and original content
      assert.equal(head1.id, 'target-1');
      assert.equal(head1.type, 'message');
      assert.equal(head1.content.a, 1);
      assert.equal(head1.content.c, 3);

      assert.equal(head2.id, 'target-2');
      assert.equal(head2.type, 'event');
      assert.equal(head2.content.b, 2);
      assert.equal(head2.content.c, 3);

      // Both got hidden from source
      assert.equal(head1.hidden, false);
      assert.equal(head2.hidden, false);
    });
  });

  describe('edge cases', () => {
    it('should silently skip self-referencing target', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'frame-1', type: 'message', content: { text: 'original' } },
      ]);

      let results = manager.merge([
        { id: 'frame-1', type: 'merge', targets: ['frame-1'], content: { extra: 'data' } },
      ]);

      // Only the source frame itself should be in results, no merge applied to itself
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'frame-1');
    });

    it('should deduplicate targets and merge only once', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { count: 0 } },
      ]);

      let results = manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1', 'target-1', 'target-1'], content: { extra: 'data' } },
      ]);

      // Source + one merged target (not three)
      let targetResults = results.filter((f) => f.id === 'target-1');
      assert.equal(targetResults.length, 1);
    });

    it('should silently skip non-existent target', () => {
      let manager = new FrameManager();

      let results = manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['nonexistent'], content: { extra: 'data' } },
      ]);

      // Only the source frame
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'merge-1');
    });

    it('should store source frame in index', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'hello' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { extra: 'data' } },
      ]);

      let source = manager.get('merge-1');
      assert.ok(source);
      assert.equal(source.id, 'merge-1');
      assert.equal(source.type, 'merge');
    });
  });

  describe('version history (history:true)', () => {
    it('should build FramePointer chain after merge', () => {
      let manager = new FrameManager({ history: true });

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { text: 'v2' } },
      ]);

      let history = manager.getVersionHistory('target-1');
      assert.equal(history.length, 2);
      assert.equal(history[0].content.text, 'v1');
      assert.equal(history[1].content.text, 'v2');
    });

    it('should show pre- and post-merge frames in getVersionHistory', () => {
      let manager = new FrameManager({ history: true });

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'original', meta: { rev: 1 } } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { meta: { rev: 2 } } },
      ]);

      let history = manager.getVersionHistory('target-1');
      assert.equal(history.length, 2);

      // First version: original
      assert.equal(history[0].content.text, 'original');
      assert.equal(history[0].content.meta.rev, 1);

      // Second version: merged
      assert.equal(history[1].content.text, 'original');
      assert.equal(history[1].content.meta.rev, 2);
    });

    it('should return merged frame via getHead after merge', () => {
      let manager = new FrameManager({ history: true });

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'old' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { text: 'new' } },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.content.text, 'new');
    });
  });

  describe('history:false', () => {
    it('should still merge correctly with history disabled', () => {
      let manager = new FrameManager({ history: false });

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'original' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { extra: 'data' } },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.content.text, 'original');
      assert.equal(head.content.extra, 'data');
    });

    it('should update pointer in-place when history:false', () => {
      let manager = new FrameManager({ history: false });

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'v1' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { text: 'v2' } },
      ]);

      // history:false should only have the latest
      let history = manager.getVersionHistory('target-1');
      assert.equal(history.length, 1);
      assert.equal(history[0].content.text, 'v2');
    });
  });

  describe('sequential merges', () => {
    it('should accumulate content from multiple sequential merges into same target', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'base' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { a: 1 } },
      ]);

      manager.merge([
        { id: 'merge-2', type: 'merge', targets: ['target-1'], content: { b: 2 } },
      ]);

      manager.merge([
        { id: 'merge-3', type: 'merge', targets: ['target-1'], content: { c: 3 } },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.content.text, 'base');
      assert.equal(head.content.a, 1);
      assert.equal(head.content.b, 2);
      assert.equal(head.content.c, 3);
    });

    it('should build full version history from sequential merges', () => {
      let manager = new FrameManager({ history: true });

      manager.merge([
        { id: 'target-1', type: 'message', content: { rev: 0 } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: { rev: 1 } },
      ]);

      manager.merge([
        { id: 'merge-2', type: 'merge', targets: ['target-1'], content: { rev: 2 } },
      ]);

      let history = manager.getVersionHistory('target-1');
      assert.equal(history.length, 3);
      assert.equal(history[0].content.rev, 0);
      assert.equal(history[1].content.rev, 1);
      assert.equal(history[2].content.rev, 2);
    });
  });

  describe('merge with empty content', () => {
    it('should leave target content unchanged when source content is empty', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'hello', nested: { key: 'value' } } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'], content: {} },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.content.text, 'hello');
      assert.deepEqual(head.content.nested, { key: 'value' });
    });

    it('should leave target content unchanged when source has no content specified', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'target-1', type: 'message', content: { text: 'hello' } },
      ]);

      manager.merge([
        { id: 'merge-1', type: 'merge', targets: ['target-1'] },
      ]);

      let head = manager.getHead('target-1');
      assert.equal(head.content.text, 'hello');
    });
  });
});
