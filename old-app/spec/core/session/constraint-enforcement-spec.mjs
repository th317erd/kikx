'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }           from '../../../src/core/index.mjs';
import { SessionManager }           from '../../../src/core/session/index.mjs';
import { createConstraintEnforcer } from '../../../src/core/session/constraint-enforcement.mjs';

// =============================================================================
// Session Constraint Enforcement
// =============================================================================
// Verifies that session constraints (maxInteractions, endsAt) are enforced
// at the commit level via the FrameManager's commitValidator hook.
// =============================================================================

describe('Session constraint enforcement', () => {
  let core;
  let models;
  let manager;
  let organization;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    manager      = new SessionManager(core.getContext());
    organization = await models.Organization.create({ name: 'Constraint Enforcement Org' });
  });

  // ---------------------------------------------------------------------------
  // Helper: create a session with constraints and wire up the enforcer
  // ---------------------------------------------------------------------------

  function setupConstrainedSession(frameManager, constraints, callbacks = {}) {
    return createConstraintEnforcer(frameManager, {
      maxInteractions: constraints.maxInteractions ?? null,
      endsAt:          constraints.endsAt ?? null,
      onConstrained:   callbacks.onConstrained ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // maxInteractions — commit succeeds under limit
  // ---------------------------------------------------------------------------

  describe('maxInteractions — under limit', () => {
    it('commit succeeds when agent commits are under maxInteractions', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 3 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 3 });

      let results = frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'hello' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 1);
      assert.ok(frameManager.get('f1'));
    });

    it('allows multiple agent commits up to the limit', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 3 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 3 });

      // Three agent commits should all succeed
      for (let i = 1; i <= 3; i++) {
        let results = frameManager.merge(
          [{ id: `f${i}`, type: 'Message', content: { text: `msg ${i}` } }],
          { authorType: 'agent', authorID: 'agt_1' },
        );
        assert.equal(results.length, 1, `commit ${i} should succeed`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // maxInteractions — commit rejected at limit
  // ---------------------------------------------------------------------------

  describe('maxInteractions — at limit', () => {
    it('commit rejected when maxInteractions reached', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 2 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 2 });

      // Two agent commits succeed
      frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'first' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      frameManager.merge(
        [{ id: 'f2', type: 'Message', content: { text: 'second' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // Third agent commit should be rejected
      let results = frameManager.merge(
        [{ id: 'f3', type: 'Message', content: { text: 'third' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 0);
      assert.equal(frameManager.get('f3'), undefined);
    });

    it('emits commit:rejected with reason mentioning maxInteractions', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 1 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 1 });

      frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'first' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      let rejectedEvent = null;
      frameManager.on('commit:rejected', (data) => { rejectedEvent = data; });

      frameManager.merge(
        [{ id: 'f2', type: 'Message', content: { text: 'over limit' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.ok(rejectedEvent);
      assert.ok(rejectedEvent.reason.includes('maxInteractions'), `reason should mention maxInteractions, got: ${rejectedEvent.reason}`);
    });

    it('calls onConstrained callback when maxInteractions hit', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 1 });
      let frameManager = manager.getFrameManager(session.id);

      let constrainedData = null;

      setupConstrainedSession(frameManager, { maxInteractions: 1 }, {
        onConstrained: (data) => { constrainedData = data; },
      });

      frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'first' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      frameManager.merge(
        [{ id: 'f2', type: 'Message', content: { text: 'over' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.ok(constrainedData, 'onConstrained should have been called');
      assert.equal(constrainedData.constraint, 'maxInteractions');
      assert.ok(constrainedData.reason);
    });
  });

  // ---------------------------------------------------------------------------
  // maxInteractions — session-constrained system frame
  // ---------------------------------------------------------------------------

  describe('session-constrained frame', () => {
    it('creates a session-constrained system frame when maxInteractions hit', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 1 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 1 });

      frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'first' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // This should be rejected, and a session-constrained frame should be created
      frameManager.merge(
        [{ id: 'f2', type: 'Message', content: { text: 'over' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // Find the session-constrained frame
      let frames = frameManager.toArray();
      let constrainedFrame = frames.find((frame) => frame.type === 'session-constrained');

      assert.ok(constrainedFrame, 'session-constrained frame should exist');
      assert.equal(constrainedFrame.authorType, 'system');
      assert.ok(constrainedFrame.content.reason, 'should have a reason in content');
      assert.ok(constrainedFrame.content.reason.includes('maxInteractions'));
    });

    it('creates a session-constrained system frame when endsAt hit', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      let pastDate = new Date(Date.now() - 60000); // 1 minute ago
      setupConstrainedSession(frameManager, { endsAt: pastDate });

      frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'expired' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      let frames = frameManager.toArray();
      let constrainedFrame = frames.find((frame) => frame.type === 'session-constrained');

      assert.ok(constrainedFrame, 'session-constrained frame should exist');
      assert.equal(constrainedFrame.authorType, 'system');
      assert.ok(constrainedFrame.content.reason.includes('endsAt'));
    });
  });

  // ---------------------------------------------------------------------------
  // endsAt — before deadline
  // ---------------------------------------------------------------------------

  describe('endsAt — before deadline', () => {
    it('commit succeeds when current time is before endsAt', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      let futureDate = new Date(Date.now() + 3600000); // 1 hour from now
      setupConstrainedSession(frameManager, { endsAt: futureDate });

      let results = frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'on time' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 1);
      assert.ok(frameManager.get('f1'));
    });
  });

  // ---------------------------------------------------------------------------
  // endsAt — past deadline
  // ---------------------------------------------------------------------------

  describe('endsAt — past deadline', () => {
    it('commit rejected when current time is past endsAt', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      let pastDate = new Date(Date.now() - 60000); // 1 minute ago
      setupConstrainedSession(frameManager, { endsAt: pastDate });

      let results = frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'too late' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 0);
      assert.equal(frameManager.get('f1'), undefined);
    });

    it('emits commit:rejected with reason mentioning endsAt', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      let pastDate = new Date(Date.now() - 60000);
      setupConstrainedSession(frameManager, { endsAt: pastDate });

      let rejectedEvent = null;
      frameManager.on('commit:rejected', (data) => { rejectedEvent = data; });

      frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'expired' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.ok(rejectedEvent);
      assert.ok(rejectedEvent.reason.includes('endsAt'), `reason should mention endsAt, got: ${rejectedEvent.reason}`);
    });

    it('calls onConstrained callback when endsAt hit', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      let pastDate = new Date(Date.now() - 60000);
      let constrainedData = null;

      setupConstrainedSession(frameManager, { endsAt: pastDate }, {
        onConstrained: (data) => { constrainedData = data; },
      });

      frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'late' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.ok(constrainedData, 'onConstrained should have been called');
      assert.equal(constrainedData.constraint, 'endsAt');
    });
  });

  // ---------------------------------------------------------------------------
  // Author type filtering — only agent commits count
  // ---------------------------------------------------------------------------

  describe('author type filtering', () => {
    it('user-authored commits do not count toward maxInteractions', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 2 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 2 });

      // These user commits should not count
      frameManager.merge(
        [{ id: 'u1', type: 'UserMessage', content: { text: 'user msg 1' } }],
        { authorType: 'user', authorID: 'usr_1' },
      );

      frameManager.merge(
        [{ id: 'u2', type: 'UserMessage', content: { text: 'user msg 2' } }],
        { authorType: 'user', authorID: 'usr_1' },
      );

      frameManager.merge(
        [{ id: 'u3', type: 'UserMessage', content: { text: 'user msg 3' } }],
        { authorType: 'user', authorID: 'usr_1' },
      );

      // Agent commits should still be allowed (only 0 agent commits so far)
      let results = frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'agent msg 1' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 1, 'first agent commit should succeed');

      results = frameManager.merge(
        [{ id: 'a2', type: 'Message', content: { text: 'agent msg 2' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 1, 'second agent commit should succeed');

      // Third agent commit should be rejected (limit is 2)
      results = frameManager.merge(
        [{ id: 'a3', type: 'Message', content: { text: 'agent msg 3' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 0, 'third agent commit should be rejected');
    });

    it('system-authored commits do not count toward maxInteractions', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 1 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 1 });

      // System commits should not count
      frameManager.merge(
        [{ id: 's1', type: 'ParticipantJoined', content: { agentID: 'agt_1' } }],
        { authorType: 'system' },
      );

      frameManager.merge(
        [{ id: 's2', type: 'ParticipantLeft', content: { agentID: 'agt_2' } }],
        { authorType: 'system' },
      );

      // First agent commit should succeed (system commits didn't count)
      let results = frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'agent msg' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 1, 'first agent commit should succeed');

      // Second agent commit should be rejected (limit is 1)
      results = frameManager.merge(
        [{ id: 'a2', type: 'Message', content: { text: 'over' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 0, 'second agent commit should be rejected');
    });

    it('tool-authored commits do not count toward maxInteractions', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 1 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 1 });

      // Tool commits should not count
      frameManager.merge(
        [{ id: 't1', type: 'ToolResult', content: { result: 'done' } }],
        { authorType: 'tool', authorID: null },
      );

      // Agent commit should succeed (tool commit didn't count)
      let results = frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'agent msg' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 1);
    });

    it('system-authored commits are always allowed even when session is constrained', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 1 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 1 });

      // Use up the agent limit
      frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'agent msg' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // Agent commit rejected
      let agentResults = frameManager.merge(
        [{ id: 'a2', type: 'Message', content: { text: 'over' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(agentResults.length, 0, 'agent commit should be rejected');

      // System commit should still work
      let systemResults = frameManager.merge(
        [{ id: 's1', type: 'session-constrained', content: { reason: 'test' } }],
        { authorType: 'system' },
      );

      assert.equal(systemResults.length, 1, 'system commit should still succeed');
    });

    it('user-authored commits are rejected when endsAt is past', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      let pastDate = new Date(Date.now() - 60000);
      setupConstrainedSession(frameManager, { endsAt: pastDate });

      let results = frameManager.merge(
        [{ id: 'u1', type: 'UserMessage', content: { text: 'late user msg' } }],
        { authorType: 'user', authorID: 'usr_1' },
      );

      assert.equal(results.length, 0, 'user commit should be rejected when past endsAt');
    });
  });

  // ---------------------------------------------------------------------------
  // Both constraints simultaneously — first hit wins
  // ---------------------------------------------------------------------------

  describe('simultaneous constraints', () => {
    it('first constraint hit wins when both are set', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      let futureDate = new Date(Date.now() + 3600000); // 1 hour from now
      setupConstrainedSession(frameManager, { maxInteractions: 1, endsAt: futureDate });

      // Use up maxInteractions
      frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'first' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      let rejectedEvent = null;
      frameManager.on('commit:rejected', (data) => { rejectedEvent = data; });

      frameManager.merge(
        [{ id: 'a2', type: 'Message', content: { text: 'over' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.ok(rejectedEvent);
      // maxInteractions was hit first (endsAt is in the future)
      assert.ok(rejectedEvent.reason.includes('maxInteractions'));
    });

    it('endsAt triggers before maxInteractions when time is past', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      let pastDate = new Date(Date.now() - 60000);
      setupConstrainedSession(frameManager, { maxInteractions: 100, endsAt: pastDate });

      let rejectedEvent = null;
      frameManager.on('commit:rejected', (data) => { rejectedEvent = data; });

      frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'first' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.ok(rejectedEvent);
      // endsAt was hit first (maxInteractions is far from limit)
      assert.ok(rejectedEvent.reason.includes('endsAt'));
    });
  });

  // ---------------------------------------------------------------------------
  // Null constraints — unconstrained
  // ---------------------------------------------------------------------------

  describe('null constraints (unconstrained)', () => {
    it('null maxInteractions means unlimited agent commits', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: null, endsAt: null });

      // Many agent commits should all succeed
      for (let i = 1; i <= 20; i++) {
        let results = frameManager.merge(
          [{ id: `f${i}`, type: 'Message', content: { text: `msg ${i}` } }],
          { authorType: 'agent', authorID: 'agt_1' },
        );
        assert.equal(results.length, 1, `commit ${i} should succeed`);
      }
    });

    it('null endsAt means no time constraint', async () => {
      let session      = await manager.createSession(organization.id);
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: null, endsAt: null });

      let results = frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'no deadline' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('maxInteractions of 0 rejects the very first agent commit', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 0 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 0 });

      let results = frameManager.merge(
        [{ id: 'f1', type: 'Message', content: { text: 'nope' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 0);
    });

    it('constraint enforcer only fires once per rejection (not re-entrant)', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 1 });
      let frameManager = manager.getFrameManager(session.id);

      let constrainedCallCount = 0;

      setupConstrainedSession(frameManager, { maxInteractions: 1 }, {
        onConstrained: () => { constrainedCallCount++; },
      });

      frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'first' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // Multiple rejected commits should each trigger onConstrained
      frameManager.merge(
        [{ id: 'a2', type: 'Message', content: { text: 'rejected 1' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      frameManager.merge(
        [{ id: 'a3', type: 'Message', content: { text: 'rejected 2' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // The session-constrained frame is only created on first violation
      assert.equal(constrainedCallCount, 1, 'onConstrained should fire only once');
    });

    it('multiple agents contributing still share the same maxInteractions pool', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 2 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 2 });

      // Agent 1 uses one interaction
      frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'agent 1' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // Agent 2 uses one interaction
      frameManager.merge(
        [{ id: 'a2', type: 'Message', content: { text: 'agent 2' } }],
        { authorType: 'agent', authorID: 'agt_2' },
      );

      // Agent 1 tries again — should be rejected (total is 2, limit is 2)
      let results = frameManager.merge(
        [{ id: 'a3', type: 'Message', content: { text: 'over' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 0);
    });

    it('rejected commit does not increment the agent interaction count', async () => {
      let session      = await manager.createSession(organization.id, { maxInteractions: 2 });
      let frameManager = manager.getFrameManager(session.id);

      setupConstrainedSession(frameManager, { maxInteractions: 2 });

      // Use 2 agent interactions
      frameManager.merge(
        [{ id: 'a1', type: 'Message', content: { text: 'one' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      frameManager.merge(
        [{ id: 'a2', type: 'Message', content: { text: 'two' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // Rejected commit should not count
      frameManager.merge(
        [{ id: 'a3', type: 'Message', content: { text: 'rejected' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      // Verify the count hasn't increased — the rejected commit should not be in the log
      let commits = frameManager.getCommits(0, Infinity);
      let agentCommits = commits.filter((c) => c.authorType === 'agent');
      assert.equal(agentCommits.length, 2, 'rejected commits should not appear in the log');
    });
  });
});
