'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/index.mjs';

// =============================================================================
// Diff Tests — Phase A Step 4
// =============================================================================
// diff() returns all frame changes between two commit orders.
// diffFrames() convenience method returns just the frames (HEAD state).
// =============================================================================

describe('Diff', () => {
  let manager;

  beforeEach(() => {
    manager = new FrameManager();
  });

  // ---------------------------------------------------------------------------
  // diff() basic behaviour
  // ---------------------------------------------------------------------------

  it('diff() should return empty array when fromOrder === toOrder', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let order = manager.getLatestCommit().order;

    let result = manager.diff(order, order);
    assert.deepEqual(result, []);
  });

  it('diff() should return empty array when no commits exist in range', () => {
    let result = manager.diff(0, 0);
    assert.deepEqual(result, []);
  });

  it('diff() should return created frames', () => {
    manager.merge([{ id: 'f1', type: 'message', content: { text: 'hello' } }]);
    let order = manager.getLatestCommit().order;

    let result = manager.diff(0, order);
    assert.equal(result.length, 1);
    assert.equal(result[0].frameId, 'f1');
    assert.equal(result[0].operation, 'create');
    assert.ok(result[0].frame);
    assert.equal(result[0].frame.id, 'f1');
  });

  it('diff() should return updated frames from target merges', () => {
    manager.merge([{ id: 'f1', type: 'message', content: { text: 'original' } }]);
    let order1 = manager.getLatestCommit().order;

    manager.merge([{ id: 'u1', type: 'message', targets: ['f1'], content: { text: 'updated' } }]);
    let order2 = manager.getLatestCommit().order;

    let result = manager.diff(order1, order2);

    // u1 is created, f1 is updated
    let f1Change = result.find((c) => c.frameId === 'f1');
    assert.ok(f1Change);
    assert.equal(f1Change.operation, 'update');
  });

  it('diff() should deduplicate frames that appear in multiple commits', () => {
    manager.merge([{ id: 'f1', type: 'message', content: { text: 'v1' } }]);

    manager.merge([{ id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } }]);

    manager.merge([{ id: 'u2', type: 'message', targets: ['f1'], content: { text: 'v3' } }]);

    let result = manager.diff(0, manager.getLatestCommit().order);

    // f1 should appear once with its latest state, not multiple times
    let f1Changes = result.filter((c) => c.frameId === 'f1');
    assert.equal(f1Changes.length, 1);
    assert.equal(f1Changes[0].frame.content.text, 'v3');
  });

  it('diff() should handle range spanning multiple commits', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let order1 = manager.getLatestCommit().order;

    manager.merge([{ id: 'f2', type: 'message' }]);
    manager.merge([{ id: 'f3', type: 'message' }]);
    let order3 = manager.getLatestCommit().order;

    // Should include f2 and f3 (from after order1 to order3)
    let result = manager.diff(order1, order3);
    let frameIds = result.map((c) => c.frameId);
    assert.ok(frameIds.includes('f2'));
    assert.ok(frameIds.includes('f3'));
    assert.ok(!frameIds.includes('f1'));
  });

  it('diff(0, HEAD) should return all frames', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);
    manager.merge([{ id: 'f3', type: 'message' }]);

    let result = manager.diff(0, manager.getLatestCommit().order);
    let frameIds = result.map((c) => c.frameId);
    assert.ok(frameIds.includes('f1'));
    assert.ok(frameIds.includes('f2'));
    assert.ok(frameIds.includes('f3'));
  });

  // ---------------------------------------------------------------------------
  // diff() with ref names
  // ---------------------------------------------------------------------------

  it('diff() should accept ref names instead of numeric orders', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let order1 = manager.getLatestCommit().order;
    manager.createRef('processed/agent-1', order1);

    manager.merge([{ id: 'f2', type: 'message' }]);

    let result = manager.diff('processed/agent-1', 'heads/main');
    assert.equal(result.length, 1);
    assert.equal(result[0].frameId, 'f2');
  });

  it('diff() should throw for non-existent ref name', () => {
    assert.throws(
      () => manager.diff('nonexistent', 'heads/main'),
      /ref "nonexistent" not found/i,
    );
  });

  // ---------------------------------------------------------------------------
  // diff() operation field reflects last operation for deduped frames
  // ---------------------------------------------------------------------------

  it('diff() should use last operation when frame is created then updated', () => {
    // Frame created in commit 1, updated in commit 2 — diff over both should say 'create'
    // because relative to the fromOrder, the frame didn't exist yet
    manager.merge([{ id: 'f1', type: 'message', content: { text: 'v1' } }]);
    manager.merge([{ id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } }]);

    let result = manager.diff(0, manager.getLatestCommit().order);
    let f1Change = result.find((c) => c.frameId === 'f1');
    // First operation was 'create', so it stays 'create'
    assert.equal(f1Change.operation, 'create');
  });

  // ---------------------------------------------------------------------------
  // diffFrames()
  // ---------------------------------------------------------------------------

  it('diffFrames() should return just frames (no operation metadata)', () => {
    manager.merge([{ id: 'f1', type: 'message', content: { text: 'hello' } }]);
    manager.merge([{ id: 'f2', type: 'message', content: { text: 'world' } }]);

    let frames = manager.diffFrames(0, manager.getLatestCommit().order);
    assert.ok(Array.isArray(frames));
    assert.equal(frames.length, 2);

    // Should be Frame objects, not change records
    assert.ok(frames[0].id);
    assert.ok(frames[0].type);
    assert.equal(frames[0].frameId, undefined);
    assert.equal(frames[0].operation, undefined);
  });

  it('diffFrames() should accept ref names', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let order1 = manager.getLatestCommit().order;
    manager.createRef('seen/client-1', order1);

    manager.merge([{ id: 'f2', type: 'message' }]);

    let frames = manager.diffFrames('seen/client-1', 'heads/main');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].id, 'f2');
  });

  it('diffFrames() should return empty array for empty range', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    let order = manager.getLatestCommit().order;

    let frames = manager.diffFrames(order, order);
    assert.deepEqual(frames, []);
  });

  it('diffFrames() should return HEAD state of each frame', () => {
    manager.merge([{ id: 'f1', type: 'message', content: { text: 'v1' } }]);
    manager.merge([{ id: 'u1', type: 'message', targets: ['f1'], content: { text: 'v2' } }]);

    let frames = manager.diffFrames(0, manager.getLatestCommit().order);
    let f1 = frames.find((f) => f.id === 'f1');
    assert.ok(f1);
    assert.equal(f1.content.text, 'v2');
  });
});
