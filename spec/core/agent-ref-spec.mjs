'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../src/core/index.mjs';
import { InteractionLoop }    from '../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../src/core/session/index.mjs';
import { FramePersistence }   from '../../src/core/frames/index.mjs';
import { ContentSanitizer }   from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }     from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Phase B4 — Per-Agent Refs
// =============================================================================

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for testing';
  static agentType   = 'mock';

  constructor(context, blocks) {
    super(context);
    this._blocks = blocks || [];
  }

  async *_createGenerator(_params) {
    for (let block of this._blocks) {
      if (block.type === 'ToolCall') {
        let result = yield block;
        block._receivedResult = result;
      } else {
        yield block;
      }
    }

    yield { type: 'Done', content: {} };
  }
}

describe('Per-agent refs (B4)', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', new ContentSanitizer());
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestSession() {
    let org     = await models.Organization.create({ name: 'Test Org' });
    let session = await sessionManager.createSession(org.id, { name: 'B4 Test' });
    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  it('should create agent ref on first interaction', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>Hi</p>' }, authorType: 'agent', authorID: 'agt_b4' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { id: 'agt_b4', name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Hello',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let agentRef     = frameManager.getRef('processed/agent-agt_b4');

    assert.ok(agentRef !== undefined, 'Agent ref should exist after interaction');
  });

  it('should advance agent ref to heads/main after interaction', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>Reply</p>' }, authorType: 'agent', authorID: 'agt_adv' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { id: 'agt_adv', name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Message 1',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let agentRef     = frameManager.getRef('processed/agent-agt_adv');
    let headsMain    = frameManager.getRef('heads/main');

    assert.equal(agentRef, headsMain, 'Agent ref should match heads/main after interaction');
  });

  it('should not recreate existing ref on second interaction', async () => {
    let session = await createTestSession();
    let loop    = createLoop();

    // First interaction
    let agent1 = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>First</p>' }, authorType: 'agent', authorID: 'agt_nr' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent1,
      agent:       { id: 'agt_nr', name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'First message',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let refAfterFirst = frameManager.getRef('processed/agent-agt_nr');

    // Second interaction — ref should already exist, not recreated
    let agent2 = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>Second</p>' }, authorType: 'agent', authorID: 'agt_nr' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent2,
      agent:       { id: 'agt_nr', name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Second message',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let refAfterSecond = frameManager.getRef('processed/agent-agt_nr');

    // Ref should have advanced past first interaction
    assert.ok(refAfterSecond >= refAfterFirst, 'Ref should advance or stay same');
  });

  it('should advance ref after error (agent saw the error)', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, []);

    agent.execute = async () => {
      return (async function* () {
        throw new Error('B4 test error');
      })();
    };

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { id: 'agt_err', name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Trigger error',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let agentRef     = frameManager.getRef('processed/agent-agt_err');
    let headsMain    = frameManager.getRef('heads/main');

    assert.equal(agentRef, headsMain, 'Agent ref should advance even after error');
  });

  it('should show new frames via diff when user sends message after agent processed', async () => {
    let session = await createTestSession();
    let loop    = createLoop();

    // First interaction — agent processes everything
    let agent1 = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>Got it</p>' }, authorType: 'agent', authorID: 'agt_diff' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent1,
      agent:       { id: 'agt_diff', name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'First',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let refBefore    = frameManager.getRef('processed/agent-agt_diff');

    // Simulate a new user message by creating it directly through FrameManager
    // (normally the scheduler would trigger agent on this)
    frameManager.merge([{
      id:         'frm_new_user_msg',
      type:       'UserMessage',
      content:    { text: 'Second message' },
      authorType: 'user',
      authorID:   'usr_1',
    }], { authorType: 'user', authorID: 'usr_1' });

    // diff from agent's ref to heads/main should show the new user message
    let changes = frameManager.diff(`processed/agent-agt_diff`, 'heads/main');
    assert.ok(changes.length > 0, 'Should have new frames since agent last processed');

    let hasUserMessage = changes.some((c) => c.frame.type === 'UserMessage');
    assert.ok(hasUserMessage, 'Diff should include the new user message');
  });

  it('should support multiple agent refs coexisting', async () => {
    let session = await createTestSession();
    let loop    = createLoop();

    // Agent A interaction
    let agentA = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>A says hi</p>' }, authorType: 'agent', authorID: 'agt_A' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agentA,
      agent:       { id: 'agt_A', name: 'test-agent-a', pluginID: 'mock-agent' },
      userMessage: 'Hello A',
      authorType:  'user',
      authorID:    'usr_1',
    });

    // Agent B interaction
    let agentB = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>B says hi</p>' }, authorType: 'agent', authorID: 'agt_B' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agentB,
      agent:       { id: 'agt_B', name: 'test-agent-b', pluginID: 'mock-agent' },
      userMessage: 'Hello B',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);

    // Both refs should exist
    let refA = frameManager.getRef('processed/agent-agt_A');
    let refB = frameManager.getRef('processed/agent-agt_B');

    assert.ok(refA !== undefined, 'Agent A ref should exist');
    assert.ok(refB !== undefined, 'Agent B ref should exist');

    // listRefs with prefix should return both
    let agentRefs = frameManager.listRefs('processed/');
    assert.ok(agentRefs.size >= 2, 'Should have at least 2 agent refs');
  });

  it('should skip ref creation when agent has no id', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'Message', content: { html: '<p>No id</p>' }, authorType: 'agent', authorID: null },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' }, // no id
      userMessage: 'Hello',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let agentRefs    = frameManager.listRefs('processed/agent-');

    assert.equal(agentRefs.size, 0, 'Should not create ref for agent without id');
  });
});
