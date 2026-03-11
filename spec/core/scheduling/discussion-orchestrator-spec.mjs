'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../../../src/shared/lib/event-emitter.mjs';
import { DiscussionOrchestrator } from '../../../src/core/scheduling/discussion-orchestrator.mjs';

// =============================================================================
// DiscussionOrchestrator Tests
// =============================================================================
// Verifies the multi-coordinator discussion protocol: round-robin turns,
// claim detection, @mention bypass, auto-claim on max rounds, state machine
// transitions, and error/edge-case handling.
// =============================================================================

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createMockSessionManager(frames = []) {
  let frameManager = {
    _frames: [...frames],
    getHead(frameID) {
      return this._frames.find((f) => f.id === frameID) || null;
    },
    toArray() {
      return [...this._frames];
    },
    addFrame(frame) {
      this._frames.push(frame);
    },
  };

  return {
    _frameManager: frameManager,
    getFrameManager() {
      return frameManager;
    },
    async getCoordinators(sessionID) {
      return [];
    },
  };
}

function createMockInteractionLoop() {
  let loop = new EventEmitter();
  loop.setMaxListeners(Infinity);

  // Track startInteraction calls
  loop._interactions = [];
  loop.startInteraction = async function (sessionID, params) {
    this._interactions.push({ sessionID, params });

    // Simulate interaction ending after a tick
    process.nextTick(() => {
      this.emit('interaction:end', {
        sessionID,
        interactionID: `int_${this._interactions.length}`,
        agentID:       params.authorID,
      });
    });
  };

  // Provide a mock _context for _handleClaim's sessionScheduler lookup
  loop._context = {
    getProperty(name) {
      if (name === 'sessionScheduler') {
        return {
          _triggers: [],
          queueTrigger(sid, agentID) {
            this._triggers.push({ sid, agentID });
          },
        };
      }

      return null;
    },
  };

  return loop;
}

function createMockAgentResolver() {
  return {
    _resolvedAgents: new Map(),
    async resolve(agentID) {
      return {
        agentPlugin: { name: `plugin_${agentID}` },
        resolvedAgent: { id: agentID, name: agentID },
      };
    },
    buildCallbacks(resolvedAgent, sessionID) {
      return {
        checkPermission: async () => true,
        executeTool: async () => ({}),
      };
    },
  };
}

function createCoordinators(count = 2) {
  let coordinators = [];
  for (let i = 0; i < count; i++) {
    coordinators.push({
      agentID:       `agt_${i + 1}`,
      participantID: `prt_${i + 1}`,
      agentName:     `Agent${i + 1}`,
    });
  }

  return coordinators;
}

function createUserCommit(frameID = 'frm_user1', text = 'Hello agents') {
  return {
    authorType: 'user',
    changes:    [{ frameID }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscussionOrchestrator', () => {
  let sessionManager;
  let interactionLoop;
  let agentResolver;
  let orchestrator;

  beforeEach(() => {
    sessionManager  = createMockSessionManager();
    interactionLoop = createMockInteractionLoop();
    agentResolver   = createMockAgentResolver();

    orchestrator = new DiscussionOrchestrator({
      sessionManager,
      interactionLoop,
      agentResolver,
      maxRounds: 3,
    });
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('creates with required dependencies', () => {
      assert.ok(orchestrator);
      assert.equal(orchestrator.getState('ses_1'), 'idle');
    });

    it('throws without sessionManager', () => {
      assert.throws(
        () => new DiscussionOrchestrator({ interactionLoop }),
        { message: /requires sessionManager/ },
      );
    });

    it('throws without interactionLoop', () => {
      assert.throws(
        () => new DiscussionOrchestrator({ sessionManager }),
        { message: /requires interactionLoop/ },
      );
    });

    it('defaults maxRounds to 3', () => {
      let orch = new DiscussionOrchestrator({ sessionManager, interactionLoop });
      assert.equal(orch._maxRounds, 3);
    });

    it('accepts custom maxRounds', () => {
      let orch = new DiscussionOrchestrator({ sessionManager, interactionLoop, maxRounds: 5 });
      assert.equal(orch._maxRounds, 5);
    });
  });

  // ---------------------------------------------------------------------------
  // startDiscussion — basic flow
  // ---------------------------------------------------------------------------

  describe('startDiscussion', () => {
    it('throws when sessionID is missing', async () => {
      let coordinators = createCoordinators();
      await assert.rejects(
        () => orchestrator.startDiscussion(null, coordinators, createUserCommit()),
        { message: /sessionID is required/ },
      );
    });

    it('throws when fewer than 2 coordinators', async () => {
      await assert.rejects(
        () => orchestrator.startDiscussion('ses_1', [{ agentID: 'agt_1' }], createUserCommit()),
        { message: /at least 2 coordinators/ },
      );
    });

    it('throws when coordinators is null', async () => {
      await assert.rejects(
        () => orchestrator.startDiscussion('ses_1', null, createUserCommit()),
        { message: /at least 2 coordinators/ },
      );
    });

    it('throws when coordinators is empty', async () => {
      await assert.rejects(
        () => orchestrator.startDiscussion('ses_1', [], createUserCommit()),
        { message: /at least 2 coordinators/ },
      );
    });

    it('emits discussion:start event', async () => {
      let events = [];
      orchestrator.on('discussion:start', (e) => events.push(e));

      let coordinators = createCoordinators();
      await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());

      assert.equal(events.length, 1);
      assert.equal(events[0].sessionID, 'ses_1');
      assert.deepStrictEqual(events[0].coordinators, ['agt_1', 'agt_2']);
      assert.equal(events[0].maxRounds, 3);
    });

    it('returns { bypassed: false } on normal start', async () => {
      let coordinators = createCoordinators();
      let result = await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());
      assert.equal(result.bypassed, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Round-robin turns
  // ---------------------------------------------------------------------------

  describe('round-robin turns', () => {
    it('emits discussion:round for the first coordinator', async () => {
      let events = [];
      orchestrator.on('discussion:round', (e) => events.push(e));

      let coordinators = createCoordinators();
      await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());

      // At least the first round event should fire
      assert.ok(events.length >= 1);
      assert.equal(events[0].round, 1);
      assert.equal(events[0].agentID, 'agt_1');
    });

    it('starts an interaction for each coordinator in order', async () => {
      let coordinators = createCoordinators();

      // Prevent auto-advance by not auto-emitting interaction:end
      interactionLoop.startInteraction = async function (sessionID, params) {
        this._interactions.push({ sessionID, params });
        // Don't auto-emit — let the test control advancement
      };

      await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());

      // First interaction should be for agt_1
      assert.equal(interactionLoop._interactions.length, 1);
      assert.equal(interactionLoop._interactions[0].params.authorID, 'agt_1');
    });

    it('passes discussionContext to the interaction', async () => {
      interactionLoop.startInteraction = async function (sessionID, params) {
        this._interactions.push({ sessionID, params });
      };

      let coordinators = createCoordinators();
      await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());

      let params = interactionLoop._interactions[0].params;
      assert.ok(params.discussionContext);
      assert.equal(params.discussionContext.round, 1);
      assert.equal(params.discussionContext.maxRounds, 3);
      assert.deepStrictEqual(params.discussionContext.coordinators, ['agt_1', 'agt_2']);
    });
  });

  // ---------------------------------------------------------------------------
  // Claim detection
  // ---------------------------------------------------------------------------

  describe('claim detection', () => {
    it('detects claimIntent in the most recent discussion frame', () => {
      sessionManager._frameManager.addFrame({
        id:       'frm_disc1',
        type:     'discussion',
        authorID: 'agt_1',
        content:  { text: 'I will handle this', claimIntent: true },
      });

      let claimed = orchestrator._checkClaim('ses_1', 'agt_1');
      assert.equal(claimed, true);
    });

    it('returns false when no discussion frames exist', () => {
      let claimed = orchestrator._checkClaim('ses_1', 'agt_1');
      assert.equal(claimed, false);
    });

    it('returns false when discussion frame has no claimIntent', () => {
      sessionManager._frameManager.addFrame({
        id:       'frm_disc1',
        type:     'discussion',
        authorID: 'agt_1',
        content:  { text: 'Just discussing' },
      });

      let claimed = orchestrator._checkClaim('ses_1', 'agt_1');
      assert.equal(claimed, false);
    });

    it('ignores discussion frames from other agents', () => {
      sessionManager._frameManager.addFrame({
        id:       'frm_disc1',
        type:     'discussion',
        authorID: 'agt_2',
        content:  { text: 'I claim it', claimIntent: true },
      });

      let claimed = orchestrator._checkClaim('ses_1', 'agt_1');
      assert.equal(claimed, false);
    });

    it('only checks the most recent discussion frame from the agent', () => {
      // Older frame with claimIntent
      sessionManager._frameManager.addFrame({
        id:       'frm_disc1',
        type:     'discussion',
        authorID: 'agt_1',
        content:  { text: 'I claim', claimIntent: true },
      });

      // Newer frame without claimIntent
      sessionManager._frameManager.addFrame({
        id:       'frm_disc2',
        type:     'discussion',
        authorID: 'agt_1',
        content:  { text: 'Actually, nevermind' },
      });

      let claimed = orchestrator._checkClaim('ses_1', 'agt_1');
      assert.equal(claimed, false);
    });
  });

  // ---------------------------------------------------------------------------
  // _handleClaim
  // ---------------------------------------------------------------------------

  describe('_handleClaim', () => {
    it('emits discussion:claim and discussion:end events', async () => {
      let claimEvents = [];
      let endEvents   = [];
      orchestrator.on('discussion:claim', (e) => claimEvents.push(e));
      orchestrator.on('discussion:end', (e) => endEvents.push(e));

      // Set up a discussion state manually
      orchestrator._sessions.set('ses_1', {
        state:            'discussing',
        coordinators:     createCoordinators(),
        round:            2,
        currentIndex:     0,
        claimedByAgentID: null,
        commit:           createUserCommit(),
      });

      await orchestrator._handleClaim('ses_1', 'agt_1');

      assert.equal(claimEvents.length, 1);
      assert.equal(claimEvents[0].sessionID, 'ses_1');
      assert.equal(claimEvents[0].agentID, 'agt_1');
      assert.equal(claimEvents[0].round, 2);

      assert.equal(endEvents.length, 1);
      assert.equal(endEvents[0].claimedByAgentID, 'agt_1');
    });

    it('cleans up session state after claim', async () => {
      orchestrator._sessions.set('ses_1', {
        state:            'discussing',
        coordinators:     createCoordinators(),
        round:            1,
        currentIndex:     0,
        claimedByAgentID: null,
        commit:           createUserCommit(),
      });

      await orchestrator._handleClaim('ses_1', 'agt_1');
      assert.equal(orchestrator.getState('ses_1'), 'idle');
    });

    it('does nothing when discussion does not exist', async () => {
      let events = [];
      orchestrator.on('discussion:claim', (e) => events.push(e));

      await orchestrator._handleClaim('ses_nonexistent', 'agt_1');
      assert.equal(events.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // @mention bypass
  // ---------------------------------------------------------------------------

  describe('@mention bypass', () => {
    it('bypasses discussion when user message contains @AgentName', async () => {
      let bypassEvents = [];
      orchestrator.on('discussion:bypass', (e) => bypassEvents.push(e));

      // Add the user message frame to the mock frame manager
      sessionManager._frameManager.addFrame({
        id:      'frm_user1',
        type:    'user-message',
        content: { text: 'Hey @Agent2, what do you think?' },
      });

      let coordinators = createCoordinators();
      let result = await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());

      assert.equal(result.bypassed, true);
      assert.equal(result.targetAgentID, 'agt_2');
      assert.equal(bypassEvents.length, 1);
      assert.equal(bypassEvents[0].reason, 'mention');
    });

    it('returns first matching coordinator on @mention', async () => {
      sessionManager._frameManager.addFrame({
        id:      'frm_user1',
        type:    'user-message',
        content: { text: '@Agent1 please respond' },
      });

      let coordinators = createCoordinators();
      let result = await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());

      assert.equal(result.bypassed, true);
      assert.equal(result.targetAgentID, 'agt_1');
    });

    it('does not bypass when no @mention is found', async () => {
      sessionManager._frameManager.addFrame({
        id:      'frm_user1',
        type:    'user-message',
        content: { text: 'Hello everyone' },
      });

      let coordinators = createCoordinators();
      let result = await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());

      assert.equal(result.bypassed, false);
    });

    it('does not bypass when @mention targets a non-coordinator', async () => {
      sessionManager._frameManager.addFrame({
        id:      'frm_user1',
        type:    'user-message',
        content: { text: '@SomeOtherAgent do something' },
      });

      let coordinators = createCoordinators();
      let result = await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());

      assert.equal(result.bypassed, false);
    });

    it('handles commit with no changes gracefully', async () => {
      let coordinators = createCoordinators();
      let result = await orchestrator.startDiscussion('ses_1', coordinators, { authorType: 'user' });

      // No changes → no frames to check → no bypass
      assert.equal(result.bypassed, false);
    });

    it('falls back to agentID when agentName is missing', async () => {
      sessionManager._frameManager.addFrame({
        id:      'frm_user1',
        type:    'user-message',
        content: { text: '@agt_1 handle this' },
      });

      let coordinators = [
        { agentID: 'agt_1', participantID: 'prt_1' }, // no agentName
        { agentID: 'agt_2', participantID: 'prt_2', agentName: 'Agent2' },
      ];

      let result = await orchestrator.startDiscussion('ses_1', coordinators, createUserCommit());
      assert.equal(result.bypassed, true);
      assert.equal(result.targetAgentID, 'agt_1');
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-claim on max rounds
  // ---------------------------------------------------------------------------

  describe('auto-claim', () => {
    it('auto-claims first coordinator when max rounds exceeded', async () => {
      let endEvents = [];
      orchestrator.on('discussion:end', (e) => endEvents.push(e));

      // Set up discussion already past max rounds
      orchestrator._sessions.set('ses_1', {
        state:            'discussing',
        coordinators:     createCoordinators(),
        round:            4, // > maxRounds (3)
        currentIndex:     0,
        claimedByAgentID: null,
        commit:           createUserCommit(),
      });

      await orchestrator._nextTurn('ses_1');

      assert.equal(endEvents.length, 1);
      assert.equal(endEvents[0].claimedByAgentID, 'agt_1');
    });

    it('auto-claims on error during _runDiscussionTurn', async () => {
      let endEvents = [];
      orchestrator.on('discussion:end', (e) => endEvents.push(e));

      // Make agentResolver.resolve throw
      agentResolver.resolve = async () => { throw new Error('resolve failed'); };

      let coordinators = createCoordinators();

      // Manually set up state so _runDiscussionTurn is reached
      orchestrator._sessions.set('ses_1', {
        state:            'discussing',
        coordinators,
        round:            1,
        currentIndex:     0,
        claimedByAgentID: null,
        commit:           createUserCommit(),
      });

      await orchestrator._runDiscussionTurn('ses_1', coordinators[0], 1);

      assert.equal(endEvents.length, 1);
      assert.equal(endEvents[0].claimedByAgentID, 'agt_1');
    });

    it('cleans up session state when coordinators list is empty on auto-claim', async () => {
      orchestrator._sessions.set('ses_1', {
        state:            'discussing',
        coordinators:     [],
        round:            4,
        currentIndex:     0,
        claimedByAgentID: null,
        commit:           createUserCommit(),
      });

      await orchestrator._autoClaim('ses_1');
      assert.equal(orchestrator.getState('ses_1'), 'idle');
    });
  });

  // ---------------------------------------------------------------------------
  // cancelDiscussion
  // ---------------------------------------------------------------------------

  describe('cancelDiscussion', () => {
    it('removes the discussion state', () => {
      orchestrator._sessions.set('ses_1', {
        state:        'discussing',
        coordinators: createCoordinators(),
        round:        1,
      });

      orchestrator.cancelDiscussion('ses_1');
      assert.equal(orchestrator.getState('ses_1'), 'idle');
    });

    it('is safe to call for non-existent session', () => {
      orchestrator.cancelDiscussion('ses_nonexistent');
      assert.equal(orchestrator.getState('ses_nonexistent'), 'idle');
    });
  });

  // ---------------------------------------------------------------------------
  // isDiscussing
  // ---------------------------------------------------------------------------

  describe('isDiscussing', () => {
    it('returns true when session is in DISCUSSING state', () => {
      orchestrator._sessions.set('ses_1', { state: 'discussing' });
      assert.equal(orchestrator.isDiscussing('ses_1'), true);
    });

    it('returns false when session is in CLAIMED state', () => {
      orchestrator._sessions.set('ses_1', { state: 'claimed' });
      assert.equal(orchestrator.isDiscussing('ses_1'), false);
    });

    it('returns false when session is in RESPONDING state', () => {
      orchestrator._sessions.set('ses_1', { state: 'responding' });
      assert.equal(orchestrator.isDiscussing('ses_1'), false);
    });

    it('returns false when session has no discussion', () => {
      assert.equal(orchestrator.isDiscussing('ses_1'), false);
    });
  });

  // ---------------------------------------------------------------------------
  // getState
  // ---------------------------------------------------------------------------

  describe('getState', () => {
    it('returns idle for unknown sessions', () => {
      assert.equal(orchestrator.getState('ses_unknown'), 'idle');
    });

    it('returns current state for active discussions', () => {
      orchestrator._sessions.set('ses_1', { state: 'discussing' });
      assert.equal(orchestrator.getState('ses_1'), 'discussing');

      orchestrator._sessions.set('ses_1', { state: 'claimed' });
      assert.equal(orchestrator.getState('ses_1'), 'claimed');

      orchestrator._sessions.set('ses_1', { state: 'responding' });
      assert.equal(orchestrator.getState('ses_1'), 'responding');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('_nextTurn does nothing when session does not exist', async () => {
      // Should not throw
      await orchestrator._nextTurn('ses_nonexistent');
    });

    it('_nextTurn does nothing when state is not DISCUSSING', async () => {
      orchestrator._sessions.set('ses_1', { state: 'claimed' });
      // Should not throw or change state
      await orchestrator._nextTurn('ses_1');
      assert.equal(orchestrator.getState('ses_1'), 'claimed');
    });

    it('_runDiscussionTurn throws without agentResolver', async () => {
      let orch = new DiscussionOrchestrator({ sessionManager, interactionLoop });
      orch._sessions.set('ses_1', {
        state:        'discussing',
        coordinators: createCoordinators(),
      });

      await assert.rejects(
        () => orch._runDiscussionTurn('ses_1', { agentID: 'agt_1' }, 1),
        { message: /requires agentResolver/ },
      );
    });

    it('_runDiscussionTurn does nothing when session was cancelled mid-turn', async () => {
      // Session does not exist — should return early
      await orchestrator._runDiscussionTurn('ses_nonexistent', { agentID: 'agt_1' }, 1);
      assert.equal(interactionLoop._interactions.length, 0);
    });

    it('multiple discussions in different sessions are independent', async () => {
      // Prevent auto-advance
      interactionLoop.startInteraction = async function (sessionID, params) {
        this._interactions.push({ sessionID, params });
      };

      let coords1 = createCoordinators();
      let coords2 = createCoordinators();

      await orchestrator.startDiscussion('ses_1', coords1, createUserCommit());
      await orchestrator.startDiscussion('ses_2', coords2, createUserCommit());

      assert.equal(orchestrator.isDiscussing('ses_1'), true);
      assert.equal(orchestrator.isDiscussing('ses_2'), true);

      orchestrator.cancelDiscussion('ses_1');
      assert.equal(orchestrator.isDiscussing('ses_1'), false);
      assert.equal(orchestrator.isDiscussing('ses_2'), true);
    });

    it('_checkMention handles non-user-message frames gracefully', () => {
      sessionManager._frameManager.addFrame({
        id:      'frm_user1',
        type:    'message', // not user-message
        content: { text: '@Agent1 hey' },
      });

      let result = orchestrator._checkMention('ses_1', createUserCommit(), createCoordinators());
      assert.equal(result, null);
    });

    it('_checkMention handles frame with no content gracefully', () => {
      sessionManager._frameManager.addFrame({
        id:   'frm_user1',
        type: 'user-message',
        // no content
      });

      let result = orchestrator._checkMention('ses_1', createUserCommit(), createCoordinators());
      assert.equal(result, null);
    });
  });
});
