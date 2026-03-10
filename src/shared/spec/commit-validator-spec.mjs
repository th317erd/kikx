'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/index.mjs';

// =============================================================================
// Commit Validator Tests — Phase A Step 6
// =============================================================================
// Pluggable validation function called after merge logic, before commit is
// recorded. Can reject entire commits with rollback.
// =============================================================================

describe('Commit Validator', () => {

  // ---------------------------------------------------------------------------
  // Default behaviour (no validator)
  // ---------------------------------------------------------------------------

  it('should allow all commits when no validator is set', () => {
    let manager = new FrameManager();
    manager.merge([{ id: 'f1', type: 'message' }]);
    assert.ok(manager.get('f1'));
    assert.ok(manager.getLatestCommit());
  });

  it('should allow all commits when validator is null', () => {
    let manager = new FrameManager({ commitValidator: null });
    manager.merge([{ id: 'f1', type: 'message' }]);
    assert.ok(manager.get('f1'));
  });

  // ---------------------------------------------------------------------------
  // Validator allows commit
  // ---------------------------------------------------------------------------

  it('should allow commit when validator returns { allowed: true }', () => {
    let manager = new FrameManager({
      commitValidator: () => ({ allowed: true }),
    });

    manager.merge([{ id: 'f1', type: 'message', content: { text: 'ok' } }]);

    assert.ok(manager.get('f1'));
    assert.ok(manager.getLatestCommit());
  });

  // ---------------------------------------------------------------------------
  // Validator rejects commit — rollback
  // ---------------------------------------------------------------------------

  it('should rollback frames when validator rejects', () => {
    let manager = new FrameManager({
      commitValidator: () => ({ allowed: false, reason: 'forbidden' }),
    });

    manager.merge([{ id: 'f1', type: 'message', content: { text: 'bad' } }]);

    // Frame should NOT exist — rolled back
    assert.equal(manager.get('f1'), undefined);
  });

  it('should not create a commit when validator rejects', () => {
    let manager = new FrameManager({
      commitValidator: () => ({ allowed: false, reason: 'nope' }),
    });

    manager.merge([{ id: 'f1', type: 'message' }]);
    assert.equal(manager.getLatestCommit(), undefined);
  });

  it('should not advance heads/main when validator rejects', () => {
    let manager = new FrameManager({
      commitValidator: () => ({ allowed: false }),
    });

    manager.merge([{ id: 'f1', type: 'message' }]);
    assert.equal(manager.getRef('heads/main'), undefined);
  });

  it('should return empty array when validator rejects', () => {
    let manager = new FrameManager({
      commitValidator: () => ({ allowed: false }),
    });

    let results = manager.merge([{ id: 'f1', type: 'message' }]);
    assert.deepEqual(results, []);
  });

  it('should emit commit:rejected event when validator rejects', () => {
    let manager = new FrameManager({
      commitValidator: () => ({ allowed: false, reason: 'access denied' }),
    });

    let emitted = null;
    manager.on('commit:rejected', (data) => { emitted = data; });

    manager.merge([{ id: 'f1', type: 'message' }]);

    assert.ok(emitted);
    assert.equal(emitted.reason, 'access denied');
  });

  it('should not emit frame:added events when validator rejects', () => {
    let manager = new FrameManager({
      commitValidator: () => ({ allowed: false }),
    });

    let events = [];
    manager.on('frame:added', (d) => events.push(d));

    manager.merge([{ id: 'f1', type: 'message' }]);

    assert.equal(events.length, 0);
  });

  // ---------------------------------------------------------------------------
  // Validator receives correct arguments
  // ---------------------------------------------------------------------------

  it('should pass commit, frames, and actorContext to validator', () => {
    let received = null;

    let manager = new FrameManager({
      commitValidator: (commit, frames, actorContext) => {
        received = { commit, frames, actorContext };
        return { allowed: true };
      },
    });

    manager.merge(
      [{ id: 'f1', type: 'message', content: { text: 'hello' } }],
      { authorType: 'user', authorID: 'alice' },
    );

    assert.ok(received);
    assert.ok(received.commit);
    assert.ok(received.commit.changes);
    assert.equal(received.commit.authorType, 'user');
    assert.equal(received.commit.authorID, 'alice');
    assert.ok(Array.isArray(received.frames));
    assert.equal(received.frames.length, 1);
    assert.equal(received.frames[0].id, 'f1');
    assert.deepEqual(received.actorContext, { authorType: 'user', authorID: 'alice' });
  });

  // ---------------------------------------------------------------------------
  // Selective validation (conditional logic)
  // ---------------------------------------------------------------------------

  it('should allow first commit and reject second based on validator logic', () => {
    let callCount = 0;

    let manager = new FrameManager({
      commitValidator: () => {
        callCount++;
        if (callCount === 1) return { allowed: true };
        return { allowed: false, reason: 'no more commits' };
      },
    });

    manager.merge([{ id: 'f1', type: 'message' }]);
    assert.ok(manager.get('f1'));

    manager.merge([{ id: 'f2', type: 'message' }]);
    assert.equal(manager.get('f2'), undefined);
    assert.equal(manager.getCommits(0, Infinity).length, 1);
  });

  // ---------------------------------------------------------------------------
  // Rollback with target merges
  // ---------------------------------------------------------------------------

  it('should rollback target merge updates when validator rejects', () => {
    // First commit: create f1 (with permissive validator)
    let rejectNext = false;

    let manager = new FrameManager({
      commitValidator: () => {
        if (rejectNext) return { allowed: false, reason: 'rejected' };
        return { allowed: true };
      },
    });

    manager.merge([{ id: 'f1', type: 'message', content: { text: 'original' } }]);
    assert.equal(manager.get('f1').content.text, 'original');

    // Second commit: target merge update — rejected
    rejectNext = true;
    manager.merge([{ id: 'u1', type: 'message', targets: ['f1'], content: { text: 'modified' } }]);

    // f1 should still have original content
    assert.equal(manager.get('f1').content.text, 'original');
  });
});
