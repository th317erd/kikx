'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/index.mjs';

// =============================================================================
// Window Tests — Phase A Step 5
// =============================================================================
// loadWindow() bulk-loads frames. evict() removes frames below an order
// threshold. getWindowBounds() returns the current loaded range.
// =============================================================================

describe('Windowed Loading', () => {
  let manager;

  beforeEach(() => {
    manager = new FrameManager();
  });

  // ---------------------------------------------------------------------------
  // loadWindow()
  // ---------------------------------------------------------------------------

  it('loadWindow() should load frames with events suppressed', () => {
    let events = [];
    manager.on('frame:added', (d) => events.push(d));

    manager.loadWindow([
      { id: 'f1', type: 'message', content: { text: 'one' } },
      { id: 'f2', type: 'message', content: { text: 'two' } },
    ]);

    // Frames should be loaded
    assert.ok(manager.get('f1'));
    assert.ok(manager.get('f2'));

    // No per-frame events should have fired
    assert.equal(events.length, 0);
  });

  it('loadWindow() should create a commit', () => {
    manager.loadWindow([
      { id: 'f1', type: 'message' },
    ]);

    assert.ok(manager.getLatestCommit());
  });

  it('loadWindow() should return the merge results', () => {
    let results = manager.loadWindow([
      { id: 'f1', type: 'message' },
      { id: 'f2', type: 'message' },
    ]);

    assert.equal(results.length, 2);
  });

  // ---------------------------------------------------------------------------
  // evict()
  // ---------------------------------------------------------------------------

  it('evict() should remove frames below the threshold order', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let f1Order = manager.get('f1').order;

    manager.merge([{ id: 'f2', type: 'message' }]);
    manager.merge([{ id: 'f3', type: 'message' }]);

    let evicted = manager.evict(f1Order + 1);

    assert.equal(evicted, 1);
    assert.equal(manager.get('f1'), undefined);
    assert.ok(manager.get('f2'));
    assert.ok(manager.get('f3'));
  });

  it('evict() should return 0 when no frames are below threshold', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let evicted = manager.evict(0);
    assert.equal(evicted, 0);
  });

  it('evict() should also remove pointers and children entries', () => {
    manager.merge([{ id: 'parent', type: 'message' }]);
    manager.merge([{ id: 'child', type: 'message', parentID: 'parent' }]);
    let parentOrder = manager.get('parent').order;

    manager.evict(parentOrder + 1);

    // Parent frame, pointer, and children entry should be gone
    assert.equal(manager.get('parent'), undefined);
    assert.equal(manager._pointers.get('parent'), undefined);
  });

  it('evict() should handle evicting all frames', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);

    let evicted = manager.evict(Infinity);
    assert.equal(evicted, 2);
    assert.deepEqual(manager.toArray(), []);
  });

  it('evict() should not affect commits', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);

    manager.evict(Infinity);

    // Commits should still be there even after evicting frames
    let commits = manager.getCommits(0, Infinity);
    assert.equal(commits.length, 2);
  });

  // ---------------------------------------------------------------------------
  // getWindowBounds()
  // ---------------------------------------------------------------------------

  it('getWindowBounds() should return { from: 0, to: 0 } when empty', () => {
    let bounds = manager.getWindowBounds();
    assert.deepEqual(bounds, { from: 0, to: 0 });
  });

  it('getWindowBounds() should return min/max order of loaded frames', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);
    manager.merge([{ id: 'f3', type: 'message' }]);

    let bounds = manager.getWindowBounds();
    assert.equal(bounds.from, manager.get('f1').order);
    assert.equal(bounds.to, manager.get('f3').order);
  });

  it('getWindowBounds() should update after eviction', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let f1Order = manager.get('f1').order;
    manager.merge([{ id: 'f2', type: 'message' }]);
    manager.merge([{ id: 'f3', type: 'message' }]);

    manager.evict(f1Order + 1);

    let bounds = manager.getWindowBounds();
    assert.equal(bounds.from, manager.get('f2').order);
    assert.equal(bounds.to, manager.get('f3').order);
  });

  it('getWindowBounds() should return { from: 0, to: 0 } after evicting all frames', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.evict(Infinity);

    let bounds = manager.getWindowBounds();
    assert.deepEqual(bounds, { from: 0, to: 0 });
  });
});
