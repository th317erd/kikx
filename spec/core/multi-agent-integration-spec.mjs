'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }      from '../../src/core/index.mjs';
import { InteractionLoop }     from '../../src/core/interaction/index.mjs';
import { SessionManager }      from '../../src/core/session/index.mjs';
import { FramePersistence }    from '../../src/core/frames/index.mjs';
import { ContentSanitizer }    from '../../src/core/lib/content-sanitizer.mjs';
import { SessionScheduler }    from '../../src/core/scheduling/session-scheduler.mjs';
import { AgentInterface }      from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Multi-Agent Integration Tests
// =============================================================================
// Comprehensive tests for multi-agent interactions — the pieces were tested
// individually in B1-B8; these tests verify they compose correctly.
//
// Sections:
//   1. Two-agent full cycle
//   2. Three-agent coordination
//   3. Agent crash resilience
//   4. Selective cancellation
//   5. Scheduler + ref advancement loop
// =============================================================================

// -----------------------------------------------------------------------------
// Mock Agents
// -----------------------------------------------------------------------------
// MockAgent: yields configurable blocks. Each block's authorID is set from
// the agent record passed to execute().

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-multi';
  static featureName = 'mock-multi';
  static displayName = 'Mock Multi Agent';
  static description = 'Mock agent for multi-agent tests';
  static agentType   = 'mock-multi';

  constructor(context, blockFactory) {
    super(context);
    this._blockFactory = blockFactory; // (params) => blocks[]
    this.executedWith   = null;        // capture for assertions
  }

  async *_createGenerator(params) {
    this.executedWith = params;

    let blocks = (typeof this._blockFactory === 'function')
      ? this._blockFactory(params)
      : (this._blockFactory || []);

    for (let block of blocks)
      yield block;

    yield { type: 'done', content: {} };
  }
}

// CrashingAgent: yields some blocks then throws
class CrashingAgent extends AgentInterface {
  static pluginID    = 'crashing-agent';
  static featureName = 'crashing';
  static displayName = 'Crashing Agent';
  static description = 'Agent that crashes for testing';
  static agentType   = 'crashing';

  constructor(context, errorMessage) {
    super(context);
    this._errorMessage = errorMessage || 'Agent crashed!';
  }

  async *_createGenerator(params) {
    yield {
      type:       'message',
      content:    { html: '<p>Starting before crash...</p>' },
      authorType: 'agent',
      authorID:   params.agent.id,
    };

    throw new Error(this._errorMessage);
  }
}

// -----------------------------------------------------------------------------
// Test Suite
// -----------------------------------------------------------------------------

describe('Multi-Agent Integration', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let interactionLoop;
  let scheduler;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);
    interactionLoop  = new InteractionLoop(context);

    scheduler = new SessionScheduler({
      sessionManager,
      interactionLoop,
    });

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', new ContentSanitizer());
    context.setProperty('interactionLoop', interactionLoop);
    context.setProperty('sessionScheduler', scheduler);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // Helper: create org + agents + session with all participants added
  async function setupSession(agentDefs) {
    let org     = await models.Organization.create({ name: `Multi-Agent Org ${Date.now()}` });
    let agents  = [];

    for (let def of agentDefs) {
      let agent = await models.Agent.create({
        organizationID: org.id,
        name:           def.name,
        pluginID:       def.pluginID || 'mock-multi',
      });

      agents.push(agent);
    }

    let session = await sessionManager.createSession(org.id, { name: `Multi Test ${Date.now()}` });

    for (let agent of agents)
      await sessionManager.addParticipant(session.id, agent.id);

    return { org, agents, session };
  }

  // Helper: run an interaction for an agent and return the frameManager state
  async function runInteraction(sessionID, agent, plugin, userMessage, options = {}) {
    await interactionLoop.startInteraction(sessionID, {
      agentPlugin: plugin,
      agent:       { id: agent.id, name: agent.name, pluginID: agent.pluginID },
      userMessage,
      authorType:  options.authorType || 'user',
      authorID:    options.authorID || 'usr_test',
      ...options,
    });

    return sessionManager.getFrameManager(sessionID);
  }

  // ===========================================================================
  // 1. Two-agent full cycle
  // ===========================================================================

  describe('two-agent full cycle', () => {
    it('should run agent A then agent B, both producing frames in same session', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
        { name: 'test-beta' },
      ]);

      let [agentA, agentB] = agents;

      let pluginA = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Alpha responds</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let pluginB = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Beta responds</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      // Agent A runs first
      await runInteraction(session.id, agentA, pluginA, 'Hello both agents');

      // Agent B runs second (same session, no new user message)
      await runInteraction(session.id, agentB, pluginB, null, { replayFromPermission: true });

      let frameManager = sessionManager.getFrameManager(session.id);
      let allFrames    = frameManager.toArray();

      let userFrames  = allFrames.filter((f) => f.type === 'user-message');
      let agentFrames = allFrames.filter((f) => f.type === 'message');

      assert.equal(userFrames.length, 1, 'Should have one user message');
      assert.equal(agentFrames.length, 2, 'Should have two agent messages');

      // Verify authorship
      let alphaFrame = agentFrames.find((f) => f.authorID === agentA.id);
      let betaFrame  = agentFrames.find((f) => f.authorID === agentB.id);

      assert.ok(alphaFrame, 'Alpha should have a message');
      assert.ok(betaFrame, 'Beta should have a message');
    });

    it('agent B should see agent A messages as role:user with attribution', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
        { name: 'test-beta' },
      ]);

      let [agentA, agentB] = agents;

      let pluginA = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Alpha says hello</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      // Agent B's factory captures the messages it was given
      let capturedMessages = null;
      let pluginB = new MockAgent(context, (params) => {
        capturedMessages = params.messages;
        return [
          { type: 'message', content: { html: '<p>Beta acknowledges</p>' }, authorType: 'agent', authorID: params.agent.id },
        ];
      });

      // Agent A runs
      await runInteraction(session.id, agentA, pluginA, 'Hello agents');

      // Agent B runs — should see agent A's message in its context
      await runInteraction(session.id, agentB, pluginB, null, { replayFromPermission: true });

      assert.ok(capturedMessages, 'Beta should have received messages');

      // Find agent A's message in beta's context
      let alphaMsg = capturedMessages.find((m) =>
        m.sourceAgentID === agentA.id ||
        (m.content && m.content.includes && m.content.includes('agent-message')),
      );

      assert.ok(alphaMsg, 'Beta should see Alpha\'s message');
      assert.equal(alphaMsg.role, 'user', 'Other agent messages should be role:user');
      assert.ok(alphaMsg.content.includes(`source="${agentA.id}"`), 'Should include agent attribution');
      assert.ok(alphaMsg.content.includes('Alpha says hello'), 'Should include Alpha\'s content');
    });

    it('agent A should see its own messages as role:assistant on second interaction', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
        { name: 'test-beta' },
      ]);

      let [agentA, agentB] = agents;

      let pluginA1 = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Alpha first</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      // Agent B responds
      let pluginB = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Beta responds</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      // Agent A runs again — should see its own message as assistant and beta's as user
      let capturedMessages = null;
      let pluginA2 = new MockAgent(context, (params) => {
        capturedMessages = params.messages;
        return [
          { type: 'message', content: { html: '<p>Alpha second</p>' }, authorType: 'agent', authorID: params.agent.id },
        ];
      });

      await runInteraction(session.id, agentA, pluginA1, 'Round 1');
      await runInteraction(session.id, agentB, pluginB, null, { replayFromPermission: true });
      await runInteraction(session.id, agentA, pluginA2, 'Round 2');

      assert.ok(capturedMessages, 'Alpha should have received messages on second run');

      // Alpha's own first message should be role:assistant
      let ownMsg = capturedMessages.find((m) => m.role === 'assistant' && m.content && m.content.includes('Alpha first'));
      assert.ok(ownMsg, 'Alpha should see its own message as role:assistant');

      // Beta's message should be role:user with wrapper
      let betaMsg = capturedMessages.find((m) => m.sourceAgentID === agentB.id);
      assert.ok(betaMsg, 'Alpha should see Beta\'s message');
      assert.equal(betaMsg.role, 'user', 'Beta\'s message should be role:user for Alpha');
    });

    it('per-agent refs should both advance after interactions', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
        { name: 'test-beta' },
      ]);

      let [agentA, agentB] = agents;

      let pluginA = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>A</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let pluginB = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>B</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      await runInteraction(session.id, agentA, pluginA, 'Test refs');
      await runInteraction(session.id, agentB, pluginB, null, { replayFromPermission: true });

      let frameManager = sessionManager.getFrameManager(session.id);
      let headsMain    = frameManager.getRef('heads/main');
      let refA         = frameManager.getRef(`processed/agent-${agentA.id}`);
      let refB         = frameManager.getRef(`processed/agent-${agentB.id}`);

      assert.ok(refA !== undefined, 'Agent A ref should exist');
      assert.ok(refB !== undefined, 'Agent B ref should exist');
      assert.equal(refB, headsMain, 'Agent B (last to run) should be at heads/main');
    });
  });

  // ===========================================================================
  // 2. Three-agent coordination
  // ===========================================================================

  describe('three-agent coordination', () => {
    it('should handle three agents in one session sequentially', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alice' },
        { name: 'test-bob' },
        { name: 'test-carol' },
      ]);

      let [alice, bob, carol] = agents;

      let pluginAlice = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Alice here</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let pluginBob = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Bob here</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let capturedCarolMessages = null;
      let pluginCarol = new MockAgent(context, (params) => {
        capturedCarolMessages = params.messages;
        return [
          { type: 'message', content: { html: '<p>Carol here</p>' }, authorType: 'agent', authorID: params.agent.id },
        ];
      });

      await runInteraction(session.id, alice, pluginAlice, 'Hello team');
      await runInteraction(session.id, bob, pluginBob, null, { replayFromPermission: true });
      await runInteraction(session.id, carol, pluginCarol, null, { replayFromPermission: true });

      // Carol should see messages from Alice AND Bob
      assert.ok(capturedCarolMessages, 'Carol should have received messages');

      let aliceMsg = capturedCarolMessages.find((m) => m.sourceAgentID === alice.id);
      let bobMsg   = capturedCarolMessages.find((m) => m.sourceAgentID === bob.id);

      assert.ok(aliceMsg, 'Carol should see Alice\'s message');
      assert.ok(bobMsg, 'Carol should see Bob\'s message');
      assert.equal(aliceMsg.role, 'user', 'Alice\'s message should be role:user for Carol');
      assert.equal(bobMsg.role, 'user', 'Bob\'s message should be role:user for Carol');

      // All frames present
      let frameManager = sessionManager.getFrameManager(session.id);
      let allFrames    = frameManager.toArray();
      let agentFrames  = allFrames.filter((f) => f.type === 'message');

      assert.equal(agentFrames.length, 3, 'Should have three agent messages');
    });

    it('each agent should see only others as role:user, own as role:assistant', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alice' },
        { name: 'test-bob' },
        { name: 'test-carol' },
      ]);

      let [alice, bob, carol] = agents;

      // All three run, then we check message assembly from each perspective
      let pluginAlice = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Alice</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let pluginBob = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Bob</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let pluginCarol = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Carol</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      await runInteraction(session.id, alice, pluginAlice, 'Check perspectives');
      await runInteraction(session.id, bob, pluginBob, null, { replayFromPermission: true });
      await runInteraction(session.id, carol, pluginCarol, null, { replayFromPermission: true });

      let frameManager = sessionManager.getFrameManager(session.id);
      let allFrames    = frameManager.toArray();

      // From Alice's perspective
      let aliceView = interactionLoop._buildMessages(allFrames, alice.id);
      let aliceOwn  = aliceView.filter((m) => m.role === 'assistant');
      let aliceOther = aliceView.filter((m) => m.sourceAgentID);

      assert.equal(aliceOwn.length, 1, 'Alice should see 1 own message');
      assert.equal(aliceOther.length, 2, 'Alice should see 2 other-agent messages');

      // From Bob's perspective
      let bobView  = interactionLoop._buildMessages(allFrames, bob.id);
      let bobOwn   = bobView.filter((m) => m.role === 'assistant');
      let bobOther = bobView.filter((m) => m.sourceAgentID);

      assert.equal(bobOwn.length, 1, 'Bob should see 1 own message');
      assert.equal(bobOther.length, 2, 'Bob should see 2 other-agent messages');

      // From Carol's perspective
      let carolView  = interactionLoop._buildMessages(allFrames, carol.id);
      let carolOwn   = carolView.filter((m) => m.role === 'assistant');
      let carolOther = carolView.filter((m) => m.sourceAgentID);

      assert.equal(carolOwn.length, 1, 'Carol should see 1 own message');
      assert.equal(carolOther.length, 2, 'Carol should see 2 other-agent messages');
    });

    it('three agent refs should coexist and advance independently', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alice' },
        { name: 'test-bob' },
        { name: 'test-carol' },
      ]);

      let [alice, bob, carol] = agents;

      let pluginAlice = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>A</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let pluginBob = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>B</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      // Run only Alice and Bob — Carol hasn't run yet
      await runInteraction(session.id, alice, pluginAlice, 'Ref test');
      await runInteraction(session.id, bob, pluginBob, null, { replayFromPermission: true });

      let frameManager = sessionManager.getFrameManager(session.id);
      let headsMain    = frameManager.getRef('heads/main');
      let refAlice     = frameManager.getRef(`processed/agent-${alice.id}`);
      let refBob       = frameManager.getRef(`processed/agent-${bob.id}`);
      let refCarol     = frameManager.getRef(`processed/agent-${carol.id}`);

      assert.ok(refAlice !== undefined, 'Alice ref should exist');
      assert.ok(refBob !== undefined, 'Bob ref should exist');
      assert.equal(refCarol, undefined, 'Carol ref should not exist yet (never ran)');

      // Bob is at heads/main (last to run)
      assert.equal(refBob, headsMain, 'Bob should be at heads/main');

      // Alice's ref should be behind — she hasn't seen Bob's messages
      assert.ok(refAlice < headsMain, 'Alice should be behind heads/main');

      // Now run Carol
      let pluginCarol = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>C</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      await runInteraction(session.id, carol, pluginCarol, null, { replayFromPermission: true });

      // Refresh refs
      let newHeadsMain = frameManager.getRef('heads/main');
      let newRefCarol  = frameManager.getRef(`processed/agent-${carol.id}`);

      assert.equal(newRefCarol, newHeadsMain, 'Carol should now be at heads/main');

      // List all processed refs (listRefs returns a Map)
      let processedRefs = frameManager.listRefs('processed/');
      assert.equal(processedRefs.size, 3, 'Should have 3 processed refs');
    });

    it('scheduler should detect all three agents need triggering on user message', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alice' },
        { name: 'test-bob' },
        { name: 'test-carol' },
      ]);

      let frameManager = sessionManager.getFrameManager(session.id);

      // Create a user message
      frameManager.merge([{
        id:         `frm_3party_${Date.now()}`,
        type:       'user-message',
        content:    { text: 'Hello team' },
        authorType: 'user',
        authorID:   'usr_test',
      }], { authorType: 'user', authorID: 'usr_test' });

      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.equal(scheduled.length, 3, 'All three agents should be scheduled');

      let scheduledIDs = scheduled.map((s) => s.agentID).sort();
      let agentIDs     = agents.map((a) => a.id).sort();

      assert.deepEqual(scheduledIDs, agentIDs, 'Scheduled IDs should match all agent IDs');
    });
  });

  // ===========================================================================
  // 3. Agent crash resilience
  // ===========================================================================

  describe('agent crash resilience', () => {
    it('agent A crash should not prevent agent B from running', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-crasher' },
        { name: 'test-survivor' },
      ]);

      let [crasher, survivor] = agents;

      let crashPlugin = new CrashingAgent(context, 'Deliberate crash');
      let survivorPlugin = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Survivor persists</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      // Crasher runs — should produce error frame but not throw to caller
      await runInteraction(session.id, crasher, crashPlugin, 'Trigger crash');

      // Survivor runs — should work fine
      await runInteraction(session.id, survivor, survivorPlugin, null, { replayFromPermission: true });

      let frameManager = sessionManager.getFrameManager(session.id);
      let allFrames    = frameManager.toArray();

      // Crasher should have produced a partial message + error frame
      let errorFrame = allFrames.find((f) => f.type === 'error');
      assert.ok(errorFrame, 'Should have an error frame from crasher');
      assert.ok(errorFrame.content.message.includes('Deliberate crash'), 'Error should contain crash message');

      // Survivor should have produced its message
      let survivorMsg = allFrames.find((f) => f.type === 'message' && f.authorID === survivor.id);
      assert.ok(survivorMsg, 'Survivor should have produced a message');
    });

    it('crashed agent ref should still advance (agent saw the error)', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-crasher' },
      ]);

      let [crasher] = agents;
      let crashPlugin = new CrashingAgent(context, 'Ref test crash');

      await runInteraction(session.id, crasher, crashPlugin, 'Crash for ref test');

      let frameManager = sessionManager.getFrameManager(session.id);
      let headsMain    = frameManager.getRef('heads/main');
      let crasherRef   = frameManager.getRef(`processed/agent-${crasher.id}`);

      assert.ok(crasherRef !== undefined, 'Crasher ref should exist');
      assert.equal(crasherRef, headsMain, 'Crasher ref should advance to heads/main even after crash');
    });

    it('survivor should see crashed agent error frame in its context', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-crasher' },
        { name: 'test-survivor' },
      ]);

      let [crasher, survivor] = agents;

      let crashPlugin = new CrashingAgent(context, 'Visible crash');

      let capturedMessages = null;
      let survivorPlugin = new MockAgent(context, (params) => {
        capturedMessages = params.messages;
        return [
          { type: 'message', content: { html: '<p>I saw the crash</p>' }, authorType: 'agent', authorID: params.agent.id },
        ];
      });

      await runInteraction(session.id, crasher, crashPlugin, 'Watch the crash');
      await runInteraction(session.id, survivor, survivorPlugin, null, { replayFromPermission: true });

      assert.ok(capturedMessages, 'Survivor should have received messages');

      // Error frames are excluded from _buildMessages (they're in excludedTypes)
      // But the crasher's partial message ("Starting before crash...") should be visible
      let crasherPartial = capturedMessages.find((m) =>
        m.sourceAgentID === crasher.id ||
        (m.content && m.content.includes && m.content.includes('Starting before crash')),
      );

      assert.ok(crasherPartial, 'Survivor should see crasher\'s partial message');
    });

    it('scheduler should not trigger crashed agent as already-active', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-crasher' },
        { name: 'test-healthy' },
      ]);

      let [crasher, healthy] = agents;
      let crashPlugin = new CrashingAgent(context, 'Scheduler crash test');

      // Run and crash
      await runInteraction(session.id, crasher, crashPlugin, 'Crash test');

      // Verify the loop cleaned up (no stuck active state)
      assert.ok(!interactionLoop.isActive(session.id), 'Session should not be active after crash');

      // Create a new user message to trigger scheduling
      let frameManager = sessionManager.getFrameManager(session.id);
      frameManager.merge([{
        id:         `frm_postcrash_${Date.now()}`,
        type:       'user-message',
        content:    { text: 'After crash' },
        authorType: 'user',
        authorID:   'usr_test',
      }], { authorType: 'user', authorID: 'usr_test' });

      // Scheduler should offer to trigger the crashed agent again (it's not stuck "active")
      let scheduled = await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      // Crasher should be schedulable again (not stuck)
      let crasherScheduled = scheduled.find((s) => s.agentID === crasher.id);
      assert.ok(crasherScheduled, 'Crashed agent should be re-schedulable (not stuck active)');
    });

    it('crash in three-agent session should not block other two agents', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alice' },
        { name: 'test-crasher' },
        { name: 'test-carol' },
      ]);

      let [alice, crasher, carol] = agents;

      let pluginAlice = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Alice OK</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let crashPlugin = new CrashingAgent(context, 'Mid-session crash');

      let pluginCarol = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Carol OK</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      await runInteraction(session.id, alice, pluginAlice, 'Three-agent crash test');
      await runInteraction(session.id, crasher, crashPlugin, null, { replayFromPermission: true });
      await runInteraction(session.id, carol, pluginCarol, null, { replayFromPermission: true });

      let frameManager = sessionManager.getFrameManager(session.id);
      let allFrames    = frameManager.toArray();

      let aliceMsg = allFrames.find((f) => f.type === 'message' && f.authorID === alice.id);
      let carolMsg = allFrames.find((f) => f.type === 'message' && f.authorID === carol.id);
      let errorFrame = allFrames.find((f) => f.type === 'error');

      assert.ok(aliceMsg, 'Alice should have produced a message');
      assert.ok(carolMsg, 'Carol should have produced a message despite crasher');
      assert.ok(errorFrame, 'Should have an error frame from crasher');
    });
  });

  // ===========================================================================
  // 4. Selective cancellation
  // ===========================================================================

  describe('selective cancellation', () => {
    it('should cancel targeted agent while others remain schedulable', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
        { name: 'test-beta' },
        { name: 'test-gamma' },
      ]);

      let [alpha, beta, gamma] = agents;

      // Mark all three as active in scheduler
      scheduler._activeAgents.set(`${session.id}:${alpha.id}`, true);
      scheduler._activeAgents.set(`${session.id}:${beta.id}`, true);
      scheduler._activeAgents.set(`${session.id}:${gamma.id}`, true);

      // Create stop frame targeting only beta
      let frameManager = sessionManager.getFrameManager(session.id);
      frameManager.merge([{
        id:         `frm_sel_cancel_${Date.now()}`,
        type:       'stop',
        content:    { targetAgentID: beta.id },
        authorType: 'user',
        authorID:   'usr_test',
      }], { authorType: 'user', authorID: 'usr_test' });

      await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.ok(scheduler.isAgentActive(session.id, alpha.id), 'Alpha should still be active');
      assert.ok(!scheduler.isAgentActive(session.id, beta.id), 'Beta should be cancelled');
      assert.ok(scheduler.isAgentActive(session.id, gamma.id), 'Gamma should still be active');

      // Clean up
      scheduler._activeAgents.delete(`${session.id}:${alpha.id}`);
      scheduler._activeAgents.delete(`${session.id}:${gamma.id}`);
    });

    it('should cancel all agents when no targetAgentID in three-agent session', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
        { name: 'test-beta' },
        { name: 'test-gamma' },
      ]);

      let [alpha, beta, gamma] = agents;

      scheduler._activeAgents.set(`${session.id}:${alpha.id}`, true);
      scheduler._activeAgents.set(`${session.id}:${beta.id}`, true);
      scheduler._activeAgents.set(`${session.id}:${gamma.id}`, true);

      let frameManager = sessionManager.getFrameManager(session.id);
      frameManager.merge([{
        id:         `frm_cancel_all_${Date.now()}`,
        type:       'stop',
        content:    { targetAgentID: null },
        authorType: 'user',
        authorID:   'usr_test',
      }], { authorType: 'user', authorID: 'usr_test' });

      let events = [];
      let cancelHandler = (data) => events.push(data);
      scheduler.on('schedule:cancel', cancelHandler);

      await scheduler.onCommit(session.id, frameManager.getLatestCommit());

      assert.ok(!scheduler.isAgentActive(session.id, alpha.id), 'Alpha should be cancelled');
      assert.ok(!scheduler.isAgentActive(session.id, beta.id), 'Beta should be cancelled');
      assert.ok(!scheduler.isAgentActive(session.id, gamma.id), 'Gamma should be cancelled');
      assert.equal(events.length, 3, 'Should emit cancel for all three');

      scheduler.off('schedule:cancel', cancelHandler);
    });
  });

  // ===========================================================================
  // 5. Scheduler + ref advancement full loop
  // ===========================================================================

  describe('scheduler + ref advancement loop', () => {
    it('scheduler should not re-trigger agent after it has caught up', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
      ]);

      let [alpha] = agents;

      let pluginA = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Done</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      // Run interaction — this advances alpha's ref to heads/main
      await runInteraction(session.id, alpha, pluginA, 'Test catch-up');

      let frameManager = sessionManager.getFrameManager(session.id);
      let latestCommit = frameManager.getLatestCommit();

      // Scheduler should NOT trigger alpha (already caught up)
      let scheduled = await scheduler.onCommit(session.id, latestCommit);
      assert.equal(scheduled.length, 0, 'Should not re-trigger caught-up agent');
    });

    it('full cycle: user → scheduler detects → agents run → refs advance → no re-trigger', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
        { name: 'test-beta' },
      ]);

      let [alpha, beta] = agents;

      // Step 1: User message creates a commit
      let frameManager = sessionManager.getFrameManager(session.id);
      frameManager.merge([{
        id:         `frm_cycle_${Date.now()}`,
        type:       'user-message',
        content:    { text: 'Start the cycle' },
        authorType: 'user',
        authorID:   'usr_test',
      }], { authorType: 'user', authorID: 'usr_test' });

      let userCommit = frameManager.getLatestCommit();

      // Step 2: Scheduler detects both agents need triggering
      let scheduled = await scheduler.onCommit(session.id, userCommit);
      assert.equal(scheduled.length, 2, 'Both agents should be scheduled');

      // Step 3: Agent A runs
      let pluginA = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Alpha done</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      scheduler.markComplete(session.id, alpha.id);
      await runInteraction(session.id, alpha, pluginA, null, { replayFromPermission: true });

      // Step 4: Agent B runs
      let pluginB = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>Beta done</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      scheduler.markComplete(session.id, beta.id);
      await runInteraction(session.id, beta, pluginB, null, { replayFromPermission: true });

      // Step 5: Agent A's commit should NOT re-trigger Alpha (self-authored)
      let alphaCommit = frameManager.getCommits().find((c) => c.authorID === alpha.id);
      if (alphaCommit) {
        let reScheduled = await scheduler.onCommit(session.id, alphaCommit);
        let alphaSelf = reScheduled.find((s) => s.agentID === alpha.id);
        assert.ok(!alphaSelf, 'Alpha should NOT be triggered on its own commit');
      }

      // Step 6: After both have run, neither should be re-triggered on latest
      let finalCommit = frameManager.getLatestCommit();
      let finalScheduled = await scheduler.onCommit(session.id, finalCommit);

      // Beta wrote the last commit — beta shouldn't self-trigger
      let betaSelf = finalScheduled.find((s) => s.agentID === beta.id);
      assert.ok(!betaSelf, 'Beta should NOT be triggered on its own commit');
    });

    it('new user message after full cycle should re-trigger all agents', async () => {
      let { agents, session } = await setupSession([
        { name: 'test-alpha' },
        { name: 'test-beta' },
      ]);

      let [alpha, beta] = agents;

      // First cycle: user → both agents respond
      let pluginA1 = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>A1</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      let pluginB1 = new MockAgent(context, (params) => [
        { type: 'message', content: { html: '<p>B1</p>' }, authorType: 'agent', authorID: params.agent.id },
      ]);

      await runInteraction(session.id, alpha, pluginA1, 'First message');
      await runInteraction(session.id, beta, pluginB1, null, { replayFromPermission: true });

      // Second user message
      let frameManager = sessionManager.getFrameManager(session.id);
      frameManager.merge([{
        id:         `frm_round2_${Date.now()}`,
        type:       'user-message',
        content:    { text: 'Second message' },
        authorType: 'user',
        authorID:   'usr_test',
      }], { authorType: 'user', authorID: 'usr_test' });

      let newCommit  = frameManager.getLatestCommit();
      let scheduled  = await scheduler.onCommit(session.id, newCommit);

      // Both agents should be scheduled again
      assert.equal(scheduled.length, 2, 'Both agents should be re-triggered on new user message');
    });
  });
});
