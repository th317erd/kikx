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

// =============================================================================
// Phase C2 — SessionScheduler Trigger Queue + Interaction Loop Integration
// =============================================================================

describe('SessionScheduler (C2 — trigger queue + interaction loop)', () => {
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

  function createScheduler() {
    return new SessionScheduler({
      sessionManager,
      interactionLoop,
    });
  }

  // ---------------------------------------------------------------------------
  // Trigger Queue
  // ---------------------------------------------------------------------------

  describe('trigger queue', () => {
    it('should queue and dequeue triggers in FIFO order', () => {
      let scheduler = createScheduler();

      scheduler.queueTrigger('ses_1', 'agt_a');
      scheduler.queueTrigger('ses_1', 'agt_b');
      scheduler.queueTrigger('ses_1', 'agt_c');

      assert.equal(scheduler.hasPendingTriggers('ses_1'), true);

      let first  = scheduler.dequeueTrigger('ses_1');
      let second = scheduler.dequeueTrigger('ses_1');
      let third  = scheduler.dequeueTrigger('ses_1');
      let fourth = scheduler.dequeueTrigger('ses_1');

      assert.deepEqual(first, { agentID: 'agt_a' });
      assert.deepEqual(second, { agentID: 'agt_b' });
      assert.deepEqual(third, { agentID: 'agt_c' });
      assert.equal(fourth, null);
    });

    it('should return null for empty queue', () => {
      let scheduler = createScheduler();
      assert.equal(scheduler.dequeueTrigger('ses_none'), null);
    });

    it('should report hasPendingTriggers correctly', () => {
      let scheduler = createScheduler();

      assert.equal(scheduler.hasPendingTriggers('ses_1'), false);

      scheduler.queueTrigger('ses_1', 'agt_a');
      assert.equal(scheduler.hasPendingTriggers('ses_1'), true);

      scheduler.dequeueTrigger('ses_1');
      assert.equal(scheduler.hasPendingTriggers('ses_1'), false);
    });

    it('should clear triggers for a session', () => {
      let scheduler = createScheduler();

      scheduler.queueTrigger('ses_1', 'agt_a');
      scheduler.queueTrigger('ses_1', 'agt_b');
      scheduler.queueTrigger('ses_2', 'agt_c');

      scheduler.clearTriggers('ses_1');

      assert.equal(scheduler.hasPendingTriggers('ses_1'), false);
      assert.equal(scheduler.hasPendingTriggers('ses_2'), true);
    });

    it('should return pending triggers list', () => {
      let scheduler = createScheduler();

      scheduler.queueTrigger('ses_1', 'agt_a');
      scheduler.queueTrigger('ses_1', 'agt_b');

      let pending = scheduler.getPendingTriggers('ses_1');
      assert.equal(pending.length, 2);
      assert.equal(pending[0].agentID, 'agt_a');
      assert.equal(pending[1].agentID, 'agt_b');
    });

    it('should return empty array for non-existent session', () => {
      let scheduler = createScheduler();
      let pending = scheduler.getPendingTriggers('ses_unknown');
      assert.deepEqual(pending, []);
    });

    it('should isolate triggers per session', () => {
      let scheduler = createScheduler();

      scheduler.queueTrigger('ses_1', 'agt_a');
      scheduler.queueTrigger('ses_2', 'agt_b');

      assert.equal(scheduler.getPendingTriggers('ses_1').length, 1);
      assert.equal(scheduler.getPendingTriggers('ses_2').length, 1);

      scheduler.dequeueTrigger('ses_1');
      assert.equal(scheduler.hasPendingTriggers('ses_1'), false);
      assert.equal(scheduler.hasPendingTriggers('ses_2'), true);
    });
  });

  // ---------------------------------------------------------------------------
  // connectToInteractionLoop / disconnectFromInteractionLoop
  // ---------------------------------------------------------------------------

  describe('connectToInteractionLoop', () => {
    it('should subscribe to interaction:end on the interaction loop', () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);

      let before = interactionLoop.listenerCount('interaction:end');
      scheduler.connectToInteractionLoop(interactionLoop, agentResolver);
      assert.equal(interactionLoop.listenerCount('interaction:end'), before + 1);

      scheduler.disconnectFromInteractionLoop();
      assert.equal(interactionLoop.listenerCount('interaction:end'), before);
    });

    it('should subscribe to schedule:cancel on self', () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);

      let before = scheduler.listenerCount('schedule:cancel');
      scheduler.connectToInteractionLoop(interactionLoop, agentResolver);
      assert.equal(scheduler.listenerCount('schedule:cancel'), before + 1);

      scheduler.disconnectFromInteractionLoop();
      assert.equal(scheduler.listenerCount('schedule:cancel'), before);
    });

    it('should mark agent complete on interaction:end', async () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);

      scheduler.connectToInteractionLoop(interactionLoop, agentResolver);

      // Manually mark an agent as active
      scheduler._activeAgents.set('ses_t:agt_1', true);
      assert.equal(scheduler.isAgentActive('ses_t', 'agt_1'), true);

      // Emit interaction:end
      interactionLoop.emit('interaction:end', {
        sessionID:     'ses_t',
        interactionID: 'int_t',
        agentID:       'agt_1',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(scheduler.isAgentActive('ses_t', 'agt_1'), false);

      scheduler.disconnectFromInteractionLoop();
    });

    it('should clear pending triggers on schedule:cancel', () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);

      scheduler.connectToInteractionLoop(interactionLoop, agentResolver);

      scheduler.queueTrigger('ses_c', 'agt_1');
      scheduler.queueTrigger('ses_c', 'agt_2');
      assert.equal(scheduler.hasPendingTriggers('ses_c'), true);

      scheduler.emit('schedule:cancel', { sessionID: 'ses_c' });

      assert.equal(scheduler.hasPendingTriggers('ses_c'), false);

      scheduler.disconnectFromInteractionLoop();
    });

    it('should handle interaction:end with no agentID gracefully', async () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);

      scheduler.connectToInteractionLoop(interactionLoop, agentResolver);

      // Should not throw
      interactionLoop.emit('interaction:end', {
        sessionID:     'ses_x',
        interactionID: 'int_x',
        agentID:       null,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      scheduler.disconnectFromInteractionLoop();
    });

    it('should handle interaction:end with no sessionID gracefully', async () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);

      scheduler.connectToInteractionLoop(interactionLoop, agentResolver);

      // Should not throw
      interactionLoop.emit('interaction:end', {
        interactionID: 'int_y',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      scheduler.disconnectFromInteractionLoop();
    });

    it('should emit trigger:error when agent resolution fails', async () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);

      scheduler.connectToInteractionLoop(interactionLoop, agentResolver);

      let errors = [];
      scheduler.on('trigger:error', (data) => errors.push(data));

      // Queue a trigger for a non-existent agent
      scheduler.queueTrigger('ses_err', 'agt_nonexistent');

      // Emit interaction:end to trigger _triggerNext
      interactionLoop.emit('interaction:end', {
        sessionID:     'ses_err',
        interactionID: 'int_err',
        agentID:       null,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(errors.length, 1);
      assert.equal(errors[0].agentID, 'agt_nonexistent');
      assert.ok(errors[0].error);

      // Queue should be drained
      assert.equal(scheduler.hasPendingTriggers('ses_err'), false);

      scheduler.disconnectFromInteractionLoop();
    });

    it('should throw from _triggerAgent if not connected', async () => {
      let scheduler = createScheduler();

      await assert.rejects(
        () => scheduler._triggerAgent('ses_1', 'agt_1'),
        /not connected/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // _triggerNext re-queue when interaction is active
  // ---------------------------------------------------------------------------

  describe('_triggerNext re-queue', () => {
    it('should re-queue trigger when the SAME agent is already active', async () => {
      let scheduler     = createScheduler();
      let agentResolver = new AgentResolver(core);

      scheduler.connectToInteractionLoop(interactionLoop, agentResolver);

      // Queue a trigger for agt_1
      scheduler.queueTrigger('ses_active', 'agt_1');

      // Simulate agt_1 already active (per-agent composite key)
      interactionLoop._active.set('ses_active:agt_1', true);

      // Call _triggerNext directly
      await scheduler._triggerNext('ses_active');

      // The trigger should have been re-queued since the same agent is busy
      assert.equal(scheduler.hasPendingTriggers('ses_active'), true);
      let pending = scheduler.getPendingTriggers('ses_active');
      assert.equal(pending[0].agentID, 'agt_1');

      // Clean up
      interactionLoop._active.delete('ses_active:agt_1');
      scheduler.clearTriggers('ses_active');
      scheduler.disconnectFromInteractionLoop();
    });
  });
});
