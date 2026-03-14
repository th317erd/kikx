'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }      from '../../../src/core/index.mjs';
import { InteractionLoop }     from '../../../src/core/interaction/index.mjs';
import { SessionManager }      from '../../../src/core/session/index.mjs';
import { FramePersistence }    from '../../../src/core/frames/index.mjs';
import { ContentSanitizer }    from '../../../src/core/lib/content-sanitizer.mjs';
import { SessionScheduler }    from '../../../src/core/scheduling/session-scheduler.mjs';
import { AgentResolver }       from '../../../src/core/scheduling/agent-resolver.mjs';
import { FrameManager }        from '../../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Phase B5 — Session Scheduler
// =============================================================================

describe('SessionScheduler (B5)', () => {
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
    return models.Organization.create({ name: 'Sched Org' });
  }

  async function createTestAgent(org) {
    return models.Agent.create({
      organizationID: org.id,
      name:           'test-sched-agent',
      pluginID:       'mock-agent',
    });
  }

  function createScheduler() {
    return new SessionScheduler({
      sessionManager,
      interactionLoop,
    });
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('should create with required dependencies', () => {
      let scheduler = createScheduler();
      assert.ok(scheduler);
    });

    it('should throw without sessionManager', () => {
      assert.throws(() => new SessionScheduler({ interactionLoop }), /sessionManager/);
    });

    it('should throw without interactionLoop', () => {
      assert.throws(() => new SessionScheduler({ sessionManager }), /interactionLoop/);
    });
  });

  // ---------------------------------------------------------------------------
  // Triggering single agent
  // ---------------------------------------------------------------------------

  describe('single agent triggering', () => {
    it('should trigger single agent on user-message commit', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org);
      let session = await sessionManager.createSession(org.id, { name: 'Sched Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      // Simulate a user message commit
      let results = frameManager.merge([{
        id:   'frm_user_1',
        type: 'user-message',
        content: { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let commit    = frameManager.getLatestCommit();
      let scheduled = await scheduler.onCommit(session.id, commit);

      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].agentID, agent.id);
      assert.ok(scheduled[0].newFrames.length > 0);
    });

    it('should emit schedule event', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org);
      let session = await sessionManager.createSession(org.id, { name: 'Event Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);
      let events       = [];

      scheduler.on('schedule', (data) => events.push(data));

      frameManager.merge([{
        id: 'frm_ev_1', type: 'user-message', content: { text: 'Hi' },
        authorType: 'user', authorID: 'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.equal(events.length, 1);
      assert.equal(events[0].agentID, agent.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-agent triggering
  // ---------------------------------------------------------------------------

  describe('multi-agent triggering', () => {
    it('should trigger multiple agents on same commit', async () => {
      let org    = await createTestOrg();
      let agentA = await models.Agent.create({ organizationID: org.id, name: 'test-sched-a', pluginID: 'mock' });
      let agentB = await models.Agent.create({ organizationID: org.id, name: 'test-sched-b', pluginID: 'mock' });
      let session = await sessionManager.createSession(org.id, { name: 'Multi Test' });

      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id: 'frm_multi_1', type: 'user-message', content: { text: 'Hello both' },
        authorType: 'user', authorID: 'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.equal(scheduled.length, 2);

      let agentIds = scheduled.map((s) => s.agentID);
      assert.ok(agentIds.includes(agentA.id));
      assert.ok(agentIds.includes(agentB.id));
    });
  });

  // ---------------------------------------------------------------------------
  // Self-authored commit prevention
  // ---------------------------------------------------------------------------

  describe('self-authored commit prevention', () => {
    it('should NOT trigger agent on its own commits', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org);
      let session = await sessionManager.createSession(org.id, { name: 'Self Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      // First: user message → agent should be triggered
      frameManager.merge([{
        id: 'frm_self_1', type: 'user-message', content: { text: 'Hi' },
        authorType: 'user', authorID: 'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled1 = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled1.length, 1);
      scheduler.markComplete(session.id, agent.id);

      // Then: agent's own message → should NOT trigger
      frameManager.merge([{
        id: 'frm_self_2', type: 'message', content: { html: '<p>Reply</p>' },
        authorType: 'agent', authorID: agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      let scheduled2 = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled2.length, 0);
    });

    it('should emit schedule:skip for self-authored', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org);
      let session = await sessionManager.createSession(org.id, { name: 'Skip Self' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);
      let skips        = [];

      scheduler.on('schedule:skip', (data) => skips.push(data));

      frameManager.merge([{
        id: 'frm_ss_1', type: 'message', content: { html: '<p>Self</p>' },
        authorType: 'agent', authorID: agent.id,
      }], { authorType: 'agent', authorID: agent.id });

      await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.ok(skips.some((s) => s.reason === 'self-authored'));
    });
  });

  // ---------------------------------------------------------------------------
  // Active agent prevention
  // ---------------------------------------------------------------------------

  describe('active agent prevention', () => {
    it('should NOT trigger agent while already active', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org);
      let session = await sessionManager.createSession(org.id, { name: 'Active Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id: 'frm_act_1', type: 'user-message', content: { text: 'Hello' },
        authorType: 'user', authorID: 'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      // First trigger — should schedule
      let scheduled1 = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled1.length, 1);

      // Second commit while agent still active — should skip
      frameManager.merge([{
        id: 'frm_act_2', type: 'user-message', content: { text: 'Another' },
        authorType: 'user', authorID: 'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled2 = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled2.length, 0);

      // After marking complete, should be schedulable again
      scheduler.markComplete(session.id, agent.id);
      assert.equal(scheduler.isAgentActive(session.id, agent.id), false);
    });
  });

  // ---------------------------------------------------------------------------
  // Already caught up
  // ---------------------------------------------------------------------------

  describe('caught-up detection', () => {
    it('should NOT trigger agent already at heads/main', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org);
      let session = await sessionManager.createSession(org.id, { name: 'CaughtUp Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id: 'frm_cu_1', type: 'user-message', content: { text: 'Hi' },
        authorType: 'user', authorID: 'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let headsMain = frameManager.getRef('heads/main');

      // Manually create the agent ref at heads/main (simulating agent already processed)
      frameManager.createRef(`processed/agent-${agent.id}`, headsMain);

      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should return empty for sessions with no participants', async () => {
      let org     = await createTestOrg();
      let session = await sessionManager.createSession(org.id, { name: 'No Parts' });

      let scheduler    = createScheduler();
      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id: 'frm_np_1', type: 'user-message', content: { text: 'Hello?' },
        authorType: 'user', authorID: 'usr_1',
      }], { authorType: 'user', authorID: 'usr_1' });

      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());
      assert.equal(scheduled.length, 0);
    });

    it('should return empty for null commit', async () => {
      let scheduler = createScheduler();
      let scheduled = await scheduler.onCommit('ses_test', null);
      assert.equal(scheduled.length, 0);
    });

    it('should track active agents per session', async () => {
      let scheduler = createScheduler();

      // getActiveAgents returns empty initially
      assert.deepEqual(scheduler.getActiveAgents('ses_1'), []);
    });
  });

  // ---------------------------------------------------------------------------
  // Resolve Context
  // ---------------------------------------------------------------------------

  describe('resolve context', () => {
    it('should store and retrieve resolve context', () => {
      let scheduler = createScheduler();
      let ctx       = { keystore: 'ks', umk: 'umk', userID: 'usr_1' };

      scheduler.setResolveContext('ses_1', ctx);

      let retrieved = scheduler.getResolveContext('ses_1');
      assert.deepEqual(retrieved, ctx);
    });

    it('should return null for unknown session', () => {
      let scheduler = createScheduler();
      assert.equal(scheduler.getResolveContext('ses_unknown'), null);
    });

    it('should clear resolve context explicitly', () => {
      let scheduler = createScheduler();
      scheduler.setResolveContext('ses_1', { keystore: 'ks' });
      scheduler.clearResolveContext('ses_1');

      assert.equal(scheduler.getResolveContext('ses_1'), null);
    });

    it('should NOT clear resolve context in markComplete (deferred to _triggerNext)', () => {
      let scheduler = createScheduler();
      scheduler.setResolveContext('ses_1', { keystore: 'ks' });

      // Simulate an active agent
      scheduler._activeAgents.set('ses_1:agt_1', true);
      assert.ok(scheduler.getResolveContext('ses_1'));

      // markComplete no longer clears — _triggerNext handles cleanup
      scheduler.markComplete('ses_1', 'agt_1');
      assert.ok(scheduler.getResolveContext('ses_1'));
    });

    it('should clear resolve context in _triggerNext when no pending triggers and no active agents', async () => {
      let scheduler = createScheduler();
      scheduler.setResolveContext('ses_1', { keystore: 'ks' });

      scheduler._activeAgents.set('ses_1:agt_1', true);
      scheduler.markComplete('ses_1', 'agt_1');

      // Context still present after markComplete
      assert.ok(scheduler.getResolveContext('ses_1'));

      // _triggerNext finds no pending triggers + no active agents → clears context
      await scheduler._triggerNext('ses_1');
      assert.equal(scheduler.getResolveContext('ses_1'), null);
    });

    it('should NOT clear resolve context when other agents still active', async () => {
      let scheduler = createScheduler();
      scheduler.setResolveContext('ses_1', { keystore: 'ks' });

      scheduler._activeAgents.set('ses_1:agt_1', true);
      scheduler._activeAgents.set('ses_1:agt_2', true);

      scheduler.markComplete('ses_1', 'agt_1');

      // agt_2 still active, context should remain even after _triggerNext
      await scheduler._triggerNext('ses_1');
      assert.ok(scheduler.getResolveContext('ses_1'));

      scheduler.markComplete('ses_1', 'agt_2');
      await scheduler._triggerNext('ses_1');
      assert.equal(scheduler.getResolveContext('ses_1'), null);
    });
  });

  // ---------------------------------------------------------------------------
  // AgentResolver
  // ---------------------------------------------------------------------------

  describe('AgentResolver', () => {
    it('should throw without core', () => {
      assert.throws(() => new AgentResolver(), /requires/);
    });

    it('should throw for non-existent agent', async () => {
      let resolver = new AgentResolver(core);

      await assert.rejects(
        () => resolver.resolve('agt_nonexistent'),
        /not found/,
      );
    });
  });
});
