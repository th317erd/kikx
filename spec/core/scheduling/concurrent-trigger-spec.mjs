'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }      from '../../../src/core/index.mjs';
import { InteractionLoop }     from '../../../src/core/interaction/index.mjs';
import { SessionManager }      from '../../../src/core/session/index.mjs';
import { FramePersistence }    from '../../../src/core/frames/index.mjs';
import { ContentSanitizer }    from '../../../src/core/lib/content-sanitizer.mjs';
import { SessionScheduler }    from '../../../src/core/scheduling/session-scheduler.mjs';

// =============================================================================
// Concurrent Trigger Tests
// =============================================================================
// Verifies that SessionScheduler can schedule multiple agents from a single
// onCommit call and that self-authored / already-active skips still work.
// =============================================================================

describe('SessionScheduler concurrent triggers', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let interactionLoop;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);
    interactionLoop  = new InteractionLoop(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', new ContentSanitizer());
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestOrg() {
    return models.Organization.create({ name: 'Concurrent Org' });
  }

  function createScheduler() {
    return new SessionScheduler({
      sessionManager,
      interactionLoop,
    });
  }

  // ---------------------------------------------------------------------------
  // onCommit schedules multiple agents in a single call
  // ---------------------------------------------------------------------------

  describe('multi-agent scheduling from single commit', () => {
    it('should schedule all agents with unprocessed frames simultaneously', async () => {
      let org    = await createTestOrg();
      let agentA = await models.Agent.create({ organizationID: org.id, name: 'test-conc-a', pluginID: 'mock' });
      let agentB = await models.Agent.create({ organizationID: org.id, name: 'test-conc-b', pluginID: 'mock' });
      let agentC = await models.Agent.create({ organizationID: org.id, name: 'test-conc-c', pluginID: 'mock' });

      let session = await sessionManager.createSession(org.id, { name: 'Concurrent Test' });

      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);
      await sessionManager.addParticipant(session.id, agentC.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);
      let events       = [];

      scheduler.on('schedule', (data) => events.push(data));

      frameManager.merge([{
        id:         'frm_conc_1',
        type:       'user-message',
        content:    { text: 'Hello all agents' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.equal(scheduled.length, 3, 'All three agents should be scheduled');
      assert.equal(events.length, 3, 'Three schedule events should be emitted');

      let scheduledAgentIDs = scheduled.map((s) => s.agentID).sort();
      let expectedAgentIDs  = [agentA.id, agentB.id, agentC.id].sort();
      assert.deepEqual(scheduledAgentIDs, expectedAgentIDs);

      // All three should be marked as active
      assert.ok(scheduler.isAgentActive(session.id, agentA.id));
      assert.ok(scheduler.isAgentActive(session.id, agentB.id));
      assert.ok(scheduler.isAgentActive(session.id, agentC.id));
    });

    it('should emit schedule events for each agent independently', async () => {
      let org    = await createTestOrg();
      let agentA = await models.Agent.create({ organizationID: org.id, name: 'test-evt-a', pluginID: 'mock' });
      let agentB = await models.Agent.create({ organizationID: org.id, name: 'test-evt-b', pluginID: 'mock' });

      let session = await sessionManager.createSession(org.id, { name: 'Event Concurrent' });

      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);
      let events       = [];

      scheduler.on('schedule', (data) => events.push(data));

      frameManager.merge([{
        id:         'frm_evt_1',
        type:       'user-message',
        content:    { text: 'Hi agents' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.equal(events.length, 2);

      // Each event should have the session ID and agent-specific data
      for (let event of events) {
        assert.equal(event.sessionID, session.id);
        assert.ok(event.agentID);
        assert.ok(event.newFrames.length > 0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Agent that authored the commit is still skipped
  // ---------------------------------------------------------------------------

  describe('self-authored skip in concurrent context', () => {
    it('should skip the authoring agent but schedule others', async () => {
      let org    = await createTestOrg();
      let agentA = await models.Agent.create({ organizationID: org.id, name: 'test-skip-author', pluginID: 'mock' });
      let agentB = await models.Agent.create({ organizationID: org.id, name: 'test-skip-other', pluginID: 'mock' });

      let session = await sessionManager.createSession(org.id, { name: 'Skip Author Test' });

      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      // First: user message to give both agents something to process
      frameManager.merge([{
        id:         'frm_sa_1',
        type:       'user-message',
        content:    { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled1 = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled1.length, 2, 'Both agents should be scheduled initially');

      // Mark both as complete
      scheduler.markComplete(session.id, agentA.id);
      scheduler.markComplete(session.id, agentB.id);

      // Now agent A replies — agent A should be skipped, agent B should be scheduled
      frameManager.merge([{
        id:         'frm_sa_2',
        type:       'message',
        content:    { html: '<p>Reply from A</p>' },
        authorType: 'agent',
        authorID:   agentA.id,
      }], { authorType: 'agent', authorID: agentA.id });

      let skips = [];
      scheduler.on('schedule:skip', (data) => skips.push(data));

      let scheduled2 = await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.equal(scheduled2.length, 1, 'Only non-authoring agent should be scheduled');
      assert.equal(scheduled2[0].agentID, agentB.id);

      assert.ok(
        skips.some((s) => s.agentID === agentA.id && s.reason === 'self-authored'),
        'Agent A should have been skipped as self-authored'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Already-active agent is still skipped
  // ---------------------------------------------------------------------------

  describe('already-active skip in concurrent context', () => {
    it('should skip active agent but schedule inactive ones', async () => {
      let org    = await createTestOrg();
      let agentA = await models.Agent.create({ organizationID: org.id, name: 'test-active-skip-a', pluginID: 'mock' });
      let agentB = await models.Agent.create({ organizationID: org.id, name: 'test-active-skip-b', pluginID: 'mock' });

      let session = await sessionManager.createSession(org.id, { name: 'Active Skip Test' });

      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      // First commit — schedules both
      frameManager.merge([{
        id:         'frm_as_1',
        type:       'user-message',
        content:    { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled1 = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled1.length, 2);

      // Only mark B as complete — A is still active
      scheduler.markComplete(session.id, agentB.id);

      // Second commit — should only schedule B, skip A (still active)
      frameManager.merge([{
        id:         'frm_as_2',
        type:       'user-message',
        content:    { text: 'Another message' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let skips = [];
      scheduler.on('schedule:skip', (data) => skips.push(data));

      let scheduled2 = await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.equal(scheduled2.length, 1, 'Only inactive agent should be scheduled');
      assert.equal(scheduled2[0].agentID, agentB.id);

      assert.ok(
        skips.some((s) => s.agentID === agentA.id && s.reason === 'already-active'),
        'Agent A should be skipped as already-active'
      );
    });

    it('should skip all agents if all are already active', async () => {
      let org    = await createTestOrg();
      let agentA = await models.Agent.create({ organizationID: org.id, name: 'test-allactive-a', pluginID: 'mock' });
      let agentB = await models.Agent.create({ organizationID: org.id, name: 'test-allactive-b', pluginID: 'mock' });

      let session = await sessionManager.createSession(org.id, { name: 'All Active Test' });

      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      // First commit — schedules both (marks them active)
      frameManager.merge([{
        id:         'frm_aa_1',
        type:       'user-message',
        content:    { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      // Second commit while both active — should schedule zero
      frameManager.merge([{
        id:         'frm_aa_2',
        type:       'user-message',
        content:    { text: 'More' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled.length, 0, 'No agents should be scheduled when all are active');
    });
  });

  // ---------------------------------------------------------------------------
  // _triggerNext with per-agent isActive
  // ---------------------------------------------------------------------------

  describe('_triggerNext concurrent awareness', () => {
    it('should not re-queue trigger when only a DIFFERENT agent is active', async () => {
      let scheduler = createScheduler();

      // Queue a trigger for agent B
      scheduler.queueTrigger('ses_conc', 'agt_b');

      // Simulate agent A being active in the interaction loop (not agent B)
      // The _active map now uses composite keys
      interactionLoop._active.set('ses_conc:agt_a', { generator: null });

      // _triggerNext should check if the specific agent (agt_b) is blocked,
      // not whether ANY agent is active. However, _triggerAgent will fail
      // because there's no agent resolver. The key test is that it doesn't
      // re-queue based on a different agent being active.
      //
      // Since _triggerAgent throws (no agentResolver), the trigger:error
      // event fires — which means it was NOT re-queued.
      let errors = [];
      scheduler.on('trigger:error', (data) => errors.push(data));

      await scheduler._triggerNext('ses_conc');

      // It should have attempted to trigger (not re-queued), and failed
      // because there's no agent resolver connected
      assert.equal(errors.length, 1, 'Should have attempted trigger (not re-queued)');
      assert.equal(errors[0].agentID, 'agt_b');

      // Clean up
      interactionLoop._active.delete('ses_conc:agt_a');
    });

    it('should re-queue trigger when the SAME agent is active', async () => {
      let scheduler = createScheduler();

      scheduler.queueTrigger('ses_conc', 'agt_a');

      // Simulate agent A being active
      interactionLoop._active.set('ses_conc:agt_a', { generator: null });

      await scheduler._triggerNext('ses_conc');

      // Should have been re-queued since the same agent is active
      assert.ok(scheduler.hasPendingTriggers('ses_conc'), 'Trigger should be re-queued');
      let pending = scheduler.getPendingTriggers('ses_conc');
      assert.equal(pending[0].agentID, 'agt_a');

      // Clean up
      interactionLoop._active.delete('ses_conc:agt_a');
      scheduler.clearTriggers('ses_conc');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('single agent session still works correctly', async () => {
      let org   = await createTestOrg();
      let agent = await models.Agent.create({ organizationID: org.id, name: 'test-single-conc', pluginID: 'mock' });

      let session = await sessionManager.createSession(org.id, { name: 'Single Concurrent' });
      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id:         'frm_single_1',
        type:       'user-message',
        content:    { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].agentID, agent.id);
    });

    it('mixed: some agents caught up, some not, some active', async () => {
      let org    = await createTestOrg();
      let agentA = await models.Agent.create({ organizationID: org.id, name: 'test-mixed-a', pluginID: 'mock' });
      let agentB = await models.Agent.create({ organizationID: org.id, name: 'test-mixed-b', pluginID: 'mock' });
      let agentC = await models.Agent.create({ organizationID: org.id, name: 'test-mixed-c', pluginID: 'mock' });

      let session = await sessionManager.createSession(org.id, { name: 'Mixed Test' });
      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);
      await sessionManager.addParticipant(session.id, agentC.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id:         'frm_mix_1',
        type:       'user-message',
        content:    { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      // Mark agent A as caught up
      let headsMain = frameManager.getRef('heads/main');
      frameManager.createRef(`processed/agent-${agentA.id}`, headsMain);

      // Mark agent B as active
      scheduler._activeAgents.set(`${session.id}:${agentB.id}`, true);

      // Agent C has no ref — should be scheduled
      let skips = [];
      scheduler.on('schedule:skip', (data) => skips.push(data));

      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.equal(scheduled.length, 1, 'Only agent C should be scheduled');
      assert.equal(scheduled[0].agentID, agentC.id);

      assert.ok(skips.some((s) => s.agentID === agentA.id && s.reason === 'already-caught-up'));
      assert.ok(skips.some((s) => s.agentID === agentB.id && s.reason === 'already-active'));
    });
  });
});
