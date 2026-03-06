'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }          from '../../../src/core/index.mjs';
import { InteractionLoop }         from '../../../src/core/interaction/index.mjs';
import { SessionManager }          from '../../../src/core/session/index.mjs';
import { FramePersistence }        from '../../../src/core/frames/index.mjs';
import { ContentSanitizer }        from '../../../src/core/lib/content-sanitizer.mjs';
import { SessionScheduler }        from '../../../src/core/scheduling/session-scheduler.mjs';
import { AgentResolver }           from '../../../src/core/scheduling/agent-resolver.mjs';
import { SchedulerOrchestrator }   from '../../../src/core/scheduling/scheduler-orchestrator.mjs';

// =============================================================================
// Scheduler Orchestrator Tests
// =============================================================================

describe('SchedulerOrchestrator', () => {
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
    context.setProperty('interactionLoop', interactionLoop);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestOrg() {
    return models.Organization.create({ name: 'Orch Org' });
  }

  async function createTestAgent(org, name = 'test-orch-agent') {
    return models.Agent.create({
      organizationID: org.id,
      name,
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
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({
        scheduler,
        agentResolver,
        interactionLoop,
      });

      assert.ok(orchestrator);
    });

    it('should throw without scheduler', () => {
      assert.throws(
        () => new SchedulerOrchestrator({ agentResolver: new AgentResolver(core), interactionLoop }),
        /requires scheduler/,
      );
    });

    it('should throw without agentResolver', () => {
      let scheduler = createScheduler();
      assert.throws(
        () => new SchedulerOrchestrator({ scheduler, interactionLoop }),
        /requires agentResolver/,
      );
    });

    it('should throw without interactionLoop', () => {
      let scheduler = createScheduler();
      assert.throws(
        () => new SchedulerOrchestrator({ scheduler, agentResolver: new AgentResolver(core) }),
        /requires interactionLoop/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Commit handling
  // ---------------------------------------------------------------------------

  describe('commit handling', () => {
    it('should call scheduler.onCommit for non-agent commits', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org);
      let session = await sessionManager.createSession(org.id, { name: 'Orch Commit Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      orchestrator.start();

      let frameManager = sessionManager.getFrameManager(session.id);

      // Create a user-message commit
      frameManager.merge([{
        id:         'frm_orch_1',
        type:       'user-message',
        content:    { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorId: 'usr_1' });

      let commit = frameManager.getLatestCommit();

      // Manually emit commit event (simulating what InteractionLoop does)
      interactionLoop.emit('commit', { sessionID: session.id, commit });

      // Give async handler time to execute
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The scheduler should have marked the agent as active
      assert.equal(scheduler.isAgentActive(session.id, agent.id), true);

      orchestrator.stop();
    });

    it('should ignore agent-authored commits (no ping-pong)', async () => {
      let org     = await createTestOrg();
      let agentA  = await createTestAgent(org, 'test-orch-a');
      let agentB  = await createTestAgent(org, 'test-orch-b');
      let session = await sessionManager.createSession(org.id, { name: 'Orch NoPing Test' });

      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);

      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      orchestrator.start();

      let frameManager = sessionManager.getFrameManager(session.id);

      // Create an agent-authored commit
      frameManager.merge([{
        id:         'frm_orch_agent_1',
        type:       'message',
        content:    { html: '<p>Agent reply</p>' },
        authorType: 'agent',
        authorID:   agentA.id,
      }], { authorType: 'agent', authorId: agentA.id });

      let commit = frameManager.getLatestCommit();

      // Emit commit as if from InteractionLoop
      interactionLoop.emit('commit', { sessionID: session.id, commit });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Neither agent should have been scheduled
      assert.equal(scheduler.isAgentActive(session.id, agentA.id), false);
      assert.equal(scheduler.isAgentActive(session.id, agentB.id), false);
      assert.equal(orchestrator.hasPendingTriggers(session.id), false);

      orchestrator.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // interaction:end handling
  // ---------------------------------------------------------------------------

  describe('interaction:end handling', () => {
    it('should call scheduler.markComplete on interaction:end', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org, 'test-orch-end');
      let session = await sessionManager.createSession(org.id, { name: 'Orch End Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      orchestrator.start();

      // Manually mark agent as active
      scheduler._activeAgents.set(`${session.id}:${agent.id}`, true);
      assert.equal(scheduler.isAgentActive(session.id, agent.id), true);

      // Emit interaction:end
      interactionLoop.emit('interaction:end', {
        sessionID:     session.id,
        interactionID: 'int_test',
        agentID:       agent.id,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Agent should now be inactive
      assert.equal(scheduler.isAgentActive(session.id, agent.id), false);

      orchestrator.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Cancel handling
  // ---------------------------------------------------------------------------

  describe('cancel handling', () => {
    it('should clear pending triggers on schedule:cancel', async () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      orchestrator.start();

      // Manually queue some pending triggers
      orchestrator._pendingTriggers.set('ses_cancel', [{ agentID: 'agt_1' }, { agentID: 'agt_2' }]);
      assert.equal(orchestrator.hasPendingTriggers('ses_cancel'), true);

      // Emit schedule:cancel from scheduler
      scheduler.emit('schedule:cancel', { sessionID: 'ses_cancel' });

      // Pending triggers should be cleared
      assert.equal(orchestrator.hasPendingTriggers('ses_cancel'), false);

      orchestrator.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Single-agent backward compatibility
  // ---------------------------------------------------------------------------

  describe('single-agent backward compatibility', () => {
    it('should not add extra triggers for single-agent sessions', async () => {
      let org     = await createTestOrg();
      let agent   = await createTestAgent(org, 'test-orch-single');
      let session = await sessionManager.createSession(org.id, { name: 'Single Agent Test' });

      await sessionManager.addParticipant(session.id, agent.id);

      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      orchestrator.start();

      let frameManager = sessionManager.getFrameManager(session.id);

      // Create user message
      frameManager.merge([{
        id:         'frm_single_1',
        type:       'user-message',
        content:    { text: 'Hello' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorId: 'usr_1' });

      let commit = frameManager.getLatestCommit();
      interactionLoop.emit('commit', { sessionID: session.id, commit });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Only 1 agent scheduled, and it's the only one — pending triggers should have 1 entry
      let pending = orchestrator.getPendingTriggers(session.id);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].agentID, agent.id);

      orchestrator.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-agent queuing
  // ---------------------------------------------------------------------------

  describe('multi-agent queuing', () => {
    it('should queue multiple agents from a single commit', async () => {
      let org    = await createTestOrg();
      let agentA = await createTestAgent(org, 'test-orch-multi-a');
      let agentB = await createTestAgent(org, 'test-orch-multi-b');
      let agentC = await createTestAgent(org, 'test-orch-multi-c');

      let session = await sessionManager.createSession(org.id, { name: 'Multi Queue Test' });

      await sessionManager.addParticipant(session.id, agentA.id);
      await sessionManager.addParticipant(session.id, agentB.id);
      await sessionManager.addParticipant(session.id, agentC.id);

      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      orchestrator.start();

      let frameManager = sessionManager.getFrameManager(session.id);

      frameManager.merge([{
        id:         'frm_multi_q_1',
        type:       'user-message',
        content:    { text: 'Hello all three' },
        authorType: 'user',
        authorID:   'usr_1',
      }], { authorType: 'user', authorId: 'usr_1' });

      let commit = frameManager.getLatestCommit();
      interactionLoop.emit('commit', { sessionID: session.id, commit });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // All three should be queued
      let pending  = orchestrator.getPendingTriggers(session.id);
      let agentIds = pending.map((p) => p.agentID);

      assert.equal(pending.length, 3);
      assert.ok(agentIds.includes(agentA.id));
      assert.ok(agentIds.includes(agentB.id));
      assert.ok(agentIds.includes(agentC.id));

      orchestrator.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should emit trigger:error and mark agent complete on failure', async () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      orchestrator.start();

      let errors = [];
      orchestrator.on('trigger:error', (data) => errors.push(data));

      // Queue a trigger for a non-existent agent
      orchestrator._pendingTriggers.set('ses_err', [{ agentID: 'agt_nonexistent' }]);

      // Emit interaction:end to trigger the next agent
      interactionLoop.emit('interaction:end', {
        sessionID:     'ses_err',
        interactionID: 'int_err',
        agentID:       null,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have emitted a trigger:error
      assert.equal(errors.length, 1);
      assert.equal(errors[0].agentID, 'agt_nonexistent');
      assert.ok(errors[0].error);

      // Pending queue should be drained
      assert.equal(orchestrator.hasPendingTriggers('ses_err'), false);

      orchestrator.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // start / stop lifecycle
  // ---------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('should subscribe and unsubscribe from events', () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      let commitListeners = interactionLoop.listenerCount('commit');
      let endListeners    = interactionLoop.listenerCount('interaction:end');
      let cancelListeners = scheduler.listenerCount('schedule:cancel');

      orchestrator.start();

      assert.equal(interactionLoop.listenerCount('commit'), commitListeners + 1);
      assert.equal(interactionLoop.listenerCount('interaction:end'), endListeners + 1);
      assert.equal(scheduler.listenerCount('schedule:cancel'), cancelListeners + 1);

      orchestrator.stop();

      assert.equal(interactionLoop.listenerCount('commit'), commitListeners);
      assert.equal(interactionLoop.listenerCount('interaction:end'), endListeners);
      assert.equal(scheduler.listenerCount('schedule:cancel'), cancelListeners);
    });

    it('should clear pending triggers on stop', () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);
      let orchestrator  = new SchedulerOrchestrator({ scheduler, agentResolver, interactionLoop });

      orchestrator.start();
      orchestrator._pendingTriggers.set('ses_1', [{ agentID: 'agt_1' }]);

      orchestrator.stop();

      assert.equal(orchestrator.hasPendingTriggers('ses_1'), false);
    });
  });
});
