'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../src/core/index.mjs';
import { InteractionLoop }    from '../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../src/core/session/index.mjs';
import { FramePersistence }   from '../../src/core/frames/index.mjs';
import { ContentSanitizer }   from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }     from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Phase B3 — Frame Creation Through FrameManager
// =============================================================================
// Verifies that every frame created during an interaction produces a commit
// in the FrameManager, with proper authorType/authorID metadata.
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
      if (block.type === 'tool-call') {
        let result = yield block;
        block._receivedResult = result;
      } else {
        yield block;
      }
    }

    yield { type: 'done', content: {} };
  }
}

describe('Frame creation through FrameManager (B3)', () => {
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
    let session = await sessionManager.createSession(org.id, { name: 'B3 Test' });
    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  // ---------------------------------------------------------------------------
  // Commit creation tests
  // ---------------------------------------------------------------------------

  it('should create commits for user-message frames', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'message', content: { html: '<p>Hello</p>' }, authorType: 'agent', authorID: 'agt_1' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Hi there',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let commits      = [];
    let current      = frameManager.getLatestCommit();

    // Walk commit chain
    while (current) {
      commits.unshift(current);
      current = (current.parentOrder !== null) ? frameManager.getCommit(current.parentOrder) : null;
    }

    // Should have commits: bulk-load + user-message + agent-message (at minimum)
    assert.ok(commits.length >= 2, `Expected at least 2 commits, got ${commits.length}`);

    // Find a commit with authorType 'user'
    let userCommit = commits.find((c) => c.authorType === 'user');
    assert.ok(userCommit, 'Should have a commit with authorType=user');
  });

  it('should create commits for agent message frames', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'message', content: { html: '<p>Response</p>' }, authorType: 'agent', authorID: 'agt_1' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Hello',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let latest       = frameManager.getLatestCommit();

    // Latest commit should be the agent message
    assert.ok(latest);
    assert.equal(latest.authorType, 'agent');
  });

  it('should create commits for tool-result frames with authorType=system', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      {
        type:    'tool-call',
        content: { toolName: 'test:echo', arguments: { text: 'hello' }, toolUseID: 'tu_1' },
        authorType: 'agent',
        authorID:   'agt_1',
      },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Use the echo tool',
      authorType:  'user',
      authorID:    'usr_1',
      executeTool: async () => 'echoed',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let latest       = frameManager.getLatestCommit();

    assert.ok(latest);
    assert.equal(latest.authorType, 'system');
  });

  it('should have sequential orders for frames created during interaction', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'message', content: { html: '<p>One</p>' }, authorType: 'agent', authorID: 'agt_1' },
      { type: 'message', content: { html: '<p>Two</p>' }, authorType: 'agent', authorID: 'agt_1' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Give me two messages',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let allFrames    = frameManager.toArray();

    // Verify frames are in sequential order
    for (let i = 1; i < allFrames.length; i++)
      assert.ok(allFrames[i].order > allFrames[i - 1].order, `Frame ${i} order ${allFrames[i].order} should be > ${allFrames[i - 1].order}`);
  });

  it('should make diff work for frames created in an interaction', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'message', content: { html: '<p>Reply</p>' }, authorType: 'agent', authorID: 'agt_1' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Hello agent',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);

    // diff from 0 (before any commits) to heads/main should return all frames
    let changes = frameManager.diff(0, 'heads/main');
    assert.ok(changes.length >= 2, `Expected at least 2 diff changes, got ${changes.length}`);

    // All changes should be 'create' operations
    for (let change of changes)
      assert.equal(change.operation, 'create');
  });

  it('should preserve authorType and authorID on Frame objects in FrameManager', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'message', content: { html: '<p>Test</p>' }, authorType: 'agent', authorID: 'agt_test' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Check author fields',
      authorType:  'user',
      authorID:    'usr_test',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let allFrames    = frameManager.toArray();

    // Find the user-message frame
    let userFrame = allFrames.find((f) => f.type === 'user-message');
    assert.ok(userFrame);
    assert.equal(userFrame.authorType, 'user');
    assert.equal(userFrame.authorID, 'usr_test');

    // Find the agent message frame
    let agentFrame = allFrames.find((f) => f.type === 'message');
    assert.ok(agentFrame);
    assert.equal(agentFrame.authorType, 'agent');
    assert.equal(agentFrame.authorID, 'agt_test');
  });

  it('should have heads/main ref pointing to latest commit', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, [
      { type: 'message', content: { html: '<p>OK</p>' }, authorType: 'agent', authorID: 'agt_1' },
    ]);

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Test refs',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let headsMain    = frameManager.getRef('heads/main');
    let latest       = frameManager.getLatestCommit();

    assert.ok(headsMain !== undefined);
    assert.ok(latest);
    assert.equal(headsMain, latest.order);
  });

  it('should include the _createFrame helper on InteractionLoop', () => {
    let loop = createLoop();
    assert.equal(typeof loop._createFrame, 'function');
  });

  it('should create error commits with authorType=system', async () => {
    let session = await createTestSession();
    let loop    = createLoop();
    let agent   = new MockAgent(context, []);

    // Override execute to throw
    agent.execute = async () => {
      return (async function* () {
        throw new Error('test explosion');
      })();
    };

    await loop.startInteraction(session.id, {
      agentPlugin: agent,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Trigger error',
      authorType:  'user',
      authorID:    'usr_1',
    });

    let frameManager = sessionManager.getFrameManager(session.id);
    let latest       = frameManager.getLatestCommit();

    assert.ok(latest);
    assert.equal(latest.authorType, 'system');
  });
});
