'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/index.mjs';

// =============================================================================
// Commit Log Tests — Phase A Step 2
// =============================================================================
// Every successful merge() creates a Commit record. Commits are immutable,
// monotonically ordered, and record which frames were created/updated/deleted.
// =============================================================================

describe('Commit Log', () => {
  let manager;

  beforeEach(() => {
    manager = new FrameManager();
  });

  // ---------------------------------------------------------------------------
  // Commit creation
  // ---------------------------------------------------------------------------

  it('should create a commit on merge', () => {
    manager.merge([
      { id: 'f1', type: 'message', content: { text: 'hello' } },
    ]);

    let commit = manager.getLatestCommit();
    assert.ok(commit, 'expected a commit to exist');
    assert.equal(commit.order, 1);
    assert.ok(commit.timestamp > 0);
  });

  it('should not create a commit for empty merge', () => {
    manager.merge([]);
    assert.equal(manager.getLatestCommit(), undefined);
  });

  it('should not create a commit when all frames are skipped (no id/type)', () => {
    manager.merge([
      { content: { text: 'no id' } },
      { id: 'f1', content: { text: 'no type' } },
    ]);

    assert.equal(manager.getLatestCommit(), undefined);
  });

  it('should assign monotonically increasing commit orders', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);
    manager.merge([{ id: 'f3', type: 'message' }]);

    let commits = manager.getCommits(0, Infinity);
    assert.equal(commits.length, 3);
    assert.ok(commits[0].order < commits[1].order);
    assert.ok(commits[1].order < commits[2].order);
  });

  it('should record parentOrder linking commits', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);

    let commits = manager.getCommits(0, Infinity);
    assert.equal(commits[0].parentOrder, null, 'first commit has no parent');
    assert.equal(commits[1].parentOrder, commits[0].order, 'second commit points to first');
  });

  // ---------------------------------------------------------------------------
  // Commit changes tracking
  // ---------------------------------------------------------------------------

  it('should track created frames in changes', () => {
    manager.merge([
      { id: 'f1', type: 'message', content: { text: 'hello' } },
    ]);

    let commit = manager.getLatestCommit();
    assert.ok(commit.changes.length >= 1);

    let change = commit.changes.find((c) => c.frameID === 'f1');
    assert.ok(change, 'expected change for f1');
    assert.equal(change.operation, 'create');
  });

  it('should track multiple frames in a single atomic commit', () => {
    manager.merge([
      { id: 'f1', type: 'message', content: { text: 'one' } },
      { id: 'f2', type: 'message', content: { text: 'two' } },
    ]);

    let commits = manager.getCommits(0, Infinity);
    assert.equal(commits.length, 1, 'multiple frames in one merge = one commit');

    let commit = commits[0];
    assert.equal(commit.changes.length, 2);
    assert.ok(commit.changes.find((c) => c.frameID === 'f1'));
    assert.ok(commit.changes.find((c) => c.frameID === 'f2'));
  });

  it('should track target merges as updates', () => {
    manager.merge([
      { id: 'f1', type: 'message', content: { text: 'original' } },
    ]);

    manager.merge([
      { id: 'u1', type: 'message', targets: ['f1'], content: { text: 'updated' } },
    ]);

    let commit = manager.getLatestCommit();
    let updateChange = commit.changes.find((c) => c.frameID === 'f1');
    assert.ok(updateChange, 'expected update change for target f1');
    assert.equal(updateChange.operation, 'update');
  });

  it('should track phantom group creation as create', () => {
    manager.merge([
      { id: 'p1', type: 'message', phantom: true, groupID: 'g1', groupType: 'message', content: { text: 'streaming' } },
    ]);

    let commit = manager.getLatestCommit();
    let change = commit.changes.find((c) => c.frameID === 'g1');
    assert.ok(change, 'expected change for group frame g1');
    assert.equal(change.operation, 'create');
  });

  it('should track phantom merge into existing group as update', () => {
    manager.merge([
      { id: 'p1', type: 'message', phantom: true, groupID: 'g1', groupType: 'message', content: { text: 'v1' } },
    ]);

    manager.merge([
      { id: 'p2', type: 'message', phantom: true, groupID: 'g1', content: { text: 'v2' } },
    ]);

    let commit = manager.getLatestCommit();
    let change = commit.changes.find((c) => c.frameID === 'g1');
    assert.ok(change, 'expected update change for group g1');
    assert.equal(change.operation, 'update');
  });

  // ---------------------------------------------------------------------------
  // Author tracking
  // ---------------------------------------------------------------------------

  it('should default authorType to system when not specified', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);

    let commit = manager.getLatestCommit();
    assert.equal(commit.authorType, 'system');
    assert.equal(commit.authorID, null);
  });

  it('should record authorType and authorID from merge options', () => {
    manager.merge([{ id: 'f1', type: 'message' }], {
      authorType: 'user',
      authorID:   'alice',
    });

    let commit = manager.getLatestCommit();
    assert.equal(commit.authorType, 'user');
    assert.equal(commit.authorID, 'alice');
  });

  // ---------------------------------------------------------------------------
  // Retrieval methods
  // ---------------------------------------------------------------------------

  it('getCommit() should return a specific commit by order', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);

    let commits = manager.getCommits(0, Infinity);
    let first   = manager.getCommit(commits[0].order);
    assert.ok(first);
    assert.equal(first.order, commits[0].order);
  });

  it('getCommit() should return undefined for non-existent order', () => {
    assert.equal(manager.getCommit(999), undefined);
  });

  it('getCommits() should return range (exclusive from, inclusive to)', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);
    manager.merge([{ id: 'f3', type: 'message' }]);

    let all     = manager.getCommits(0, Infinity);
    let order1  = all[0].order;
    let order3  = all[2].order;

    // From order1 (exclusive) to order3 (inclusive) = commits 2 and 3
    let range = manager.getCommits(order1, order3);
    assert.equal(range.length, 2);
    assert.equal(range[0].order, all[1].order);
    assert.equal(range[1].order, all[2].order);
  });

  it('getLatestCommit() should return the most recent commit', () => {
    manager.merge([{ id: 'f1', type: 'message' }]);
    manager.merge([{ id: 'f2', type: 'message' }]);

    let latest = manager.getLatestCommit();
    let all    = manager.getCommits(0, Infinity);
    assert.equal(latest.order, all[all.length - 1].order);
  });

  // ---------------------------------------------------------------------------
  // Commit event
  // ---------------------------------------------------------------------------

  it('should emit "commit" event with commit payload', () => {
    let emitted = null;

    manager.on('commit', (data) => {
      emitted = data;
    });

    manager.merge([{ id: 'f1', type: 'message' }]);

    assert.ok(emitted, 'expected commit event to be emitted');
    assert.ok(emitted.commit, 'expected commit in event payload');
    assert.equal(emitted.commit.order, manager.getLatestCommit().order);
  });

  it('should not emit "commit" event for empty merge', () => {
    let emitted = false;

    manager.on('commit', () => {
      emitted = true;
    });

    manager.merge([]);

    assert.equal(emitted, false);
  });

  // ---------------------------------------------------------------------------
  // Bulk loading (events:false)
  // ---------------------------------------------------------------------------

  it('should still create commits during bulk loading', () => {
    manager.merge([
      { id: 'f1', type: 'message' },
      { id: 'f2', type: 'message' },
    ], { events: false });

    let commits = manager.getCommits(0, Infinity);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].changes.length, 2);
  });

  it('should still emit "commit" event during bulk loading', () => {
    let emitted = null;

    manager.on('commit', (data) => {
      emitted = data;
    });

    manager.merge([{ id: 'f1', type: 'message' }], { events: false });

    assert.ok(emitted, 'commit event should fire even during bulk loading');
  });
});
