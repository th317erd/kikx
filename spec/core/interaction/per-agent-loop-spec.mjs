'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../../src/core/index.mjs';
import { InteractionLoop }    from '../../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../../src/core/session/index.mjs';
import { FramePersistence }   from '../../../src/core/frames/index.mjs';
import { AgentInterface }     from '../../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Per-Agent Interaction Loop Tests
// =============================================================================
// Verifies that InteractionLoop._active keys by ${sessionID}:${agentID},
// allowing concurrent agent interactions in the same session while preventing
// duplicate interactions for the same agent.
// =============================================================================

// ---------------------------------------------------------------------------
// Mock agent that yields configurable blocks. Can be made to "hang" by
// yielding a promise that never resolves (simulating a long-running agent).
// ---------------------------------------------------------------------------

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for per-agent loop tests';
  static agentType   = 'mock';

  constructor(context, blocks, options = {}) {
    super(context);
    this._blocks    = blocks || [];
    this._onStarted = options.onStarted || null;
    this._hangUntil = options.hangUntil || null;
  }

  async *_createGenerator(_params) {
    if (this._onStarted)
      this._onStarted();

    if (this._hangUntil) {
      await this._hangUntil;
    }

    for (let block of this._blocks)
      yield block;

    yield { type: 'done', content: {} };
  }
}

describe('Per-Agent Interaction Loop', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let interactionLoop;
  let organization;
  let session;

  before(async () => {
    core             = createKikxCore();
    await core.start();
    models           = core.getModels();
    context          = core.getContext();
    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    interactionLoop = new InteractionLoop(context);
    organization    = await models.Organization.create({ name: 'Per-Agent Org' });
    session         = await sessionManager.createSession(organization.id);
  });

  // ---------------------------------------------------------------------------
  // Two agents can have concurrent interactions in the same session
  // ---------------------------------------------------------------------------

  describe('concurrent agent interactions', () => {
    it('should allow two agents to run concurrently in the same session', async () => {
      let agentA = await models.Agent.create({ organizationID: organization.id, name: 'test-agent-a', pluginID: 'mock-agent' });
      let agentB = await models.Agent.create({ organizationID: organization.id, name: 'test-agent-b', pluginID: 'mock-agent' });

      let resolveA;
      let hangA = new Promise((resolve) => { resolveA = resolve; });
      let resolveB;
      let hangB = new Promise((resolve) => { resolveB = resolve; });

      let agentAStarted = false;
      let agentBStarted = false;

      let mockAgentA = new MockAgent(context, [
        { type: 'message', content: { html: '<p>from A</p>' }, authorType: 'agent', authorID: agentA.id },
      ], {
        onStarted: () => { agentAStarted = true; },
        hangUntil: hangA,
      });

      let mockAgentB = new MockAgent(context, [
        { type: 'message', content: { html: '<p>from B</p>' }, authorType: 'agent', authorID: agentB.id },
      ], {
        onStarted: () => { agentBStarted = true; },
        hangUntil: hangB,
      });

      // Start both interactions concurrently (don't await)
      let promiseA = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgentA,
        agent:       { id: agentA.id, name: agentA.name },
        userMessage: 'hello from user to A',
      });

      // Give A a moment to start and register in _active
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(agentAStarted, 'Agent A should have started');

      let promiseB = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgentB,
        agent:       { id: agentB.id, name: agentB.name },
        userMessage: 'hello from user to B',
      });

      // Give B a moment to start
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(agentBStarted, 'Agent B should have started (concurrent)');

      // Both should be active simultaneously
      assert.ok(interactionLoop.isActive(session.id, agentA.id), 'Agent A should be active');
      assert.ok(interactionLoop.isActive(session.id, agentB.id), 'Agent B should be active');
      assert.ok(interactionLoop.isActive(session.id), 'Session should show active (any agent)');

      // Resolve both to let them finish
      resolveA();
      resolveB();

      await promiseA;
      await promiseB;

      // Both should now be inactive
      assert.ok(!interactionLoop.isActive(session.id, agentA.id), 'Agent A should be inactive after completion');
      assert.ok(!interactionLoop.isActive(session.id, agentB.id), 'Agent B should be inactive after completion');
      assert.ok(!interactionLoop.isActive(session.id), 'Session should show inactive');
    });
  });

  // ---------------------------------------------------------------------------
  // Same agent cannot have two concurrent interactions in the same session
  // ---------------------------------------------------------------------------

  describe('duplicate agent prevention', () => {
    it('should reject duplicate interaction for same agent in same session', async () => {
      let agent = await models.Agent.create({ organizationID: organization.id, name: 'test-dup-agent', pluginID: 'mock-agent' });

      let resolveHang;
      let hang = new Promise((resolve) => { resolveHang = resolve; });

      let startCount = 0;

      let mockAgent1 = new MockAgent(context, [
        { type: 'message', content: { html: '<p>first</p>' }, authorType: 'agent', authorID: agent.id },
      ], {
        onStarted: () => { startCount++; },
        hangUntil: hang,
      });

      let mockAgent2 = new MockAgent(context, [
        { type: 'message', content: { html: '<p>second</p>' }, authorType: 'agent', authorID: agent.id },
      ], {
        onStarted: () => { startCount++; },
      });

      // Start first interaction
      let promise1 = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent1,
        agent:       { id: agent.id, name: agent.name },
        userMessage: 'first message',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Try to start a second interaction for the same agent — should return null (queued)
      let result = await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent2,
        agent:       { id: agent.id, name: agent.name },
        userMessage: 'second message',
      });

      assert.equal(result, null, 'Second interaction for same agent should return null');
      assert.equal(startCount, 1, 'Only one agent generator should have started');

      resolveHang();
      await promise1;
    });

    it('should queue the message when duplicate agent interaction attempted', async () => {
      let agent = await models.Agent.create({ organizationID: organization.id, name: 'test-queue-agent', pluginID: 'mock-agent' });

      let resolveHang;
      let hang = new Promise((resolve) => { resolveHang = resolve; });

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>reply</p>' }, authorType: 'agent', authorID: agent.id },
      ], { hangUntil: hang });

      // Start first interaction
      let promise = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: agent.id, name: agent.name },
        userMessage: 'first',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Second attempt should queue the message
      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: agent.id, name: agent.name },
        userMessage: 'queued message',
      });

      let queued = interactionLoop.getQueuedMessages(session.id, agent.id);
      assert.ok(queued.length > 0, 'Message should be queued for the agent');
      assert.ok(queued.includes('queued message'), 'Queued message content should match');

      resolveHang();
      await promise;
    });
  });

  // ---------------------------------------------------------------------------
  // isActive() — session-level and agent-level
  // ---------------------------------------------------------------------------

  describe('isActive()', () => {
    it('isActive(sessionID) returns true if ANY agent is active', async () => {
      let agent = await models.Agent.create({ organizationID: organization.id, name: 'test-active-any', pluginID: 'mock-agent' });

      let resolveHang;
      let hang = new Promise((resolve) => { resolveHang = resolve; });

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>hi</p>' }, authorType: 'agent', authorID: agent.id },
      ], { hangUntil: hang });

      assert.equal(interactionLoop.isActive(session.id), false, 'Session should be inactive initially');

      let promise = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        agent:       { id: agent.id, name: agent.name },
        userMessage: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(interactionLoop.isActive(session.id), true, 'Session should be active when agent is running');

      resolveHang();
      await promise;

      assert.equal(interactionLoop.isActive(session.id), false, 'Session should be inactive after completion');
    });

    it('isActive(sessionID, agentID) returns true only for specific active agent', async () => {
      let agentA = await models.Agent.create({ organizationID: organization.id, name: 'test-active-a', pluginID: 'mock-agent' });
      let agentB = await models.Agent.create({ organizationID: organization.id, name: 'test-active-b', pluginID: 'mock-agent' });

      let resolveA;
      let hangA = new Promise((resolve) => { resolveA = resolve; });

      let mockAgentA = new MockAgent(context, [
        { type: 'message', content: { html: '<p>A</p>' }, authorType: 'agent', authorID: agentA.id },
      ], { hangUntil: hangA });

      let promise = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgentA,
        agent:       { id: agentA.id, name: agentA.name },
        userMessage: 'hello A',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(interactionLoop.isActive(session.id, agentA.id), true, 'Agent A should be active');
      assert.equal(interactionLoop.isActive(session.id, agentB.id), false, 'Agent B should NOT be active');

      resolveA();
      await promise;
    });

    it('isActive(sessionID) returns false when no agents are active', () => {
      assert.equal(interactionLoop.isActive('ses_nonexistent'), false);
    });

    it('isActive(sessionID, agentID) returns false for non-active agent', () => {
      assert.equal(interactionLoop.isActive(session.id, 'agt_nonexistent'), false);
    });
  });

  // ---------------------------------------------------------------------------
  // Cancelling one agent doesn't affect the other
  // ---------------------------------------------------------------------------

  describe('cancel isolation', () => {
    it('cancelling one agent does not affect another agent in the same session', async () => {
      let agentA = await models.Agent.create({ organizationID: organization.id, name: 'test-cancel-a', pluginID: 'mock-agent' });
      let agentB = await models.Agent.create({ organizationID: organization.id, name: 'test-cancel-b', pluginID: 'mock-agent' });

      let resolveA;
      let hangA = new Promise((resolve) => { resolveA = resolve; });
      let resolveB;
      let hangB = new Promise((resolve) => { resolveB = resolve; });

      let mockAgentA = new MockAgent(context, [
        { type: 'message', content: { html: '<p>A</p>' }, authorType: 'agent', authorID: agentA.id },
      ], { hangUntil: hangA });

      let mockAgentB = new MockAgent(context, [
        { type: 'message', content: { html: '<p>B</p>' }, authorType: 'agent', authorID: agentB.id },
      ], { hangUntil: hangB });

      // Start both agents
      let promiseA = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgentA,
        agent:       { id: agentA.id, name: agentA.name },
        userMessage: 'hello A',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      let promiseB = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgentB,
        agent:       { id: agentB.id, name: agentB.name },
        userMessage: 'hello B',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.ok(interactionLoop.isActive(session.id, agentA.id), 'Agent A active before cancel');
      assert.ok(interactionLoop.isActive(session.id, agentB.id), 'Agent B active before cancel');

      // Cancel agent A
      await interactionLoop.cancelInteraction(session.id, { targetAgentID: agentA.id });

      assert.ok(!interactionLoop.isActive(session.id, agentA.id), 'Agent A should be inactive after cancel');
      assert.ok(interactionLoop.isActive(session.id, agentB.id), 'Agent B should still be active after A cancelled');
      assert.ok(interactionLoop.isActive(session.id), 'Session should still be active (B still running)');

      // Clean up
      resolveA();
      resolveB();
      await promiseA.catch(() => {});
      await promiseB;
    });
  });

  // ---------------------------------------------------------------------------
  // Interaction end for one agent doesn't block the other
  // ---------------------------------------------------------------------------

  describe('independent completion', () => {
    it('one agent completing does not block the other', async () => {
      let agentA = await models.Agent.create({ organizationID: organization.id, name: 'test-indep-a', pluginID: 'mock-agent' });
      let agentB = await models.Agent.create({ organizationID: organization.id, name: 'test-indep-b', pluginID: 'mock-agent' });

      let resolveB;
      let hangB = new Promise((resolve) => { resolveB = resolve; });

      let endEvents = [];
      interactionLoop.on('interaction:end', (event) => {
        endEvents.push(event);
      });

      // Agent A completes immediately
      let mockAgentA = new MockAgent(context, [
        { type: 'message', content: { html: '<p>fast A</p>' }, authorType: 'agent', authorID: agentA.id },
      ]);

      // Agent B hangs
      let mockAgentB = new MockAgent(context, [
        { type: 'message', content: { html: '<p>slow B</p>' }, authorType: 'agent', authorID: agentB.id },
      ], { hangUntil: hangB });

      let promiseB = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgentB,
        agent:       { id: agentB.id, name: agentB.name },
        userMessage: 'hello B',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Start A after B is running — A should complete without affecting B
      await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgentA,
        agent:       { id: agentA.id, name: agentA.name },
        userMessage: 'hello A',
      });

      // A should have completed, B should still be running
      assert.ok(!interactionLoop.isActive(session.id, agentA.id), 'Agent A should have completed');
      assert.ok(interactionLoop.isActive(session.id, agentB.id), 'Agent B should still be running');

      // Verify A's end event was emitted
      let endA = endEvents.find((e) => e.agentID === agentA.id);
      assert.ok(endA, 'interaction:end should have been emitted for agent A');

      resolveB();
      await promiseB;

      let endB = endEvents.find((e) => e.agentID === agentB.id);
      assert.ok(endB, 'interaction:end should have been emitted for agent B');
    });
  });

  // ---------------------------------------------------------------------------
  // Backward compat: interactions without agent context still work
  // ---------------------------------------------------------------------------

  describe('backward compatibility', () => {
    it('interaction without agent context uses sessionID as key', async () => {
      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>no agent</p>' } },
      ]);

      let interactionID = await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        userMessage: 'test without agent',
      });

      assert.ok(interactionID, 'Should return an interaction ID');
      assert.ok(!interactionLoop.isActive(session.id), 'Should be inactive after completion');
    });

    it('isActive(sessionID) detects agent-less interaction', async () => {
      let resolveHang;
      let hang = new Promise((resolve) => { resolveHang = resolve; });

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>agentless</p>' } },
      ], { hangUntil: hang });

      let promise = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        userMessage: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.ok(interactionLoop.isActive(session.id), 'isActive(sessionID) should detect agent-less interaction');

      resolveHang();
      await promise;
    });

    it('duplicate agent-less interaction for same session is rejected', async () => {
      let resolveHang;
      let hang = new Promise((resolve) => { resolveHang = resolve; });

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>first</p>' } },
      ], { hangUntil: hang });

      let promise = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        userMessage: 'first',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      let result = await interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        userMessage: 'second',
      });

      assert.equal(result, null, 'Second agent-less interaction should be rejected');

      resolveHang();
      await promise;
    });
  });

  // isWaitingForPermission tests removed — permission waiting state is now
  // entirely frame-based (handled by PermissionApprovalPlugin via FrameRouter).

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('cancelInteraction with no active interaction returns null', async () => {
      let result = await interactionLoop.cancelInteraction(session.id, { targetAgentID: 'agt_nonexistent' });
      assert.equal(result, null);
    });

    it('cancelInteraction without targetAgentID cancels agent-less interaction', async () => {
      let resolveHang;
      let hang = new Promise((resolve) => { resolveHang = resolve; });

      let mockAgent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>cancel me</p>' } },
      ], { hangUntil: hang });

      let promise = interactionLoop.startInteraction(session.id, {
        agentPlugin: mockAgent,
        userMessage: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(interactionLoop.isActive(session.id));

      let queued = await interactionLoop.cancelInteraction(session.id);
      assert.ok(!interactionLoop.isActive(session.id), 'Should be inactive after cancel');

      resolveHang();
      await promise.catch(() => {});
    });
  });
});
