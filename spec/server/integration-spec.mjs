'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { KikxCore }         from '../../src/core/kikx-core.mjs';
import { Keystore }         from '../../src/core/crypto/keystore.mjs';
import { AuthService }      from '../../src/server/auth/index.mjs';
import { SessionManager }   from '../../src/core/session/index.mjs';
import { FramePersistence } from '../../src/core/frames/index.mjs';
import { InteractionLoop }  from '../../src/core/interaction/index.mjs';
import { ContentSanitizer } from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }   from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// MockAgent — controllable agent plugin for integration tests
// =============================================================================

class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static agentType   = 'mock';

  constructor(context, blocks) {
    super(context);
    this._blocks         = blocks || [];
    this._lastToolResult = null;
  }

  async *_createGenerator(_params) {
    for (let block of this._blocks) {
      if (block.type === 'tool-call') {
        let result = yield block;
        this._lastToolResult = result;
      } else {
        yield block;
      }
    }

    yield { type: 'done', content: {} };
  }

  getCapabilities() {
    return { streaming: true, toolCalls: true, reflection: true, images: false };
  }
}

// =============================================================================
// SlowMockAgent — yields blocks with a delay (for queue testing)
// =============================================================================

class SlowMockAgent extends AgentInterface {
  static pluginID    = 'slow-mock-agent';
  static featureName = 'slow-mock';
  static agentType   = 'slow-mock';

  constructor(context, blocks, delayMs) {
    super(context);
    this._blocks  = blocks || [];
    this._delayMs = delayMs || 50;
  }

  async *_createGenerator(_params) {
    for (let block of this._blocks) {
      await new Promise((resolve) => setTimeout(resolve, this._delayMs));
      yield block;
    }

    yield { type: 'done', content: {} };
  }

  getCapabilities() {
    return { streaming: true, toolCalls: false, reflection: false, images: false };
  }
}

// =============================================================================
// Shared setup
// =============================================================================

let core, keystore, authService, sessionManager, framePersistence, interactionLoop, sanitizer;

before(async () => {
  core = new KikxCore({ database: { filename: ':memory:' } });
  await core.start();

  keystore = new Keystore({ devMode: true, devSeed: 'test-integration-seed' });
  keystore.initialize();
  core.getContext().setProperty('keystore', keystore);

  authService = new AuthService({ context: core.getContext(), keystore });

  sessionManager = new SessionManager(core.getContext());
  core.getContext().setProperty('sessionManager', sessionManager);

  framePersistence = new FramePersistence(core.getContext());
  core.getContext().setProperty('framePersistence', framePersistence);

  sanitizer = new ContentSanitizer();
  core.getContext().setProperty('contentSanitizer', sanitizer);

  interactionLoop = new InteractionLoop(core.getContext());
  core.getContext().setProperty('interactionLoop', interactionLoop);
});

after(async () => {
  keystore.destroy();
  await core.stop();
});

// =============================================================================
// Helper: register a user and return { user, token, organization, umk }
// =============================================================================

async function createTestUser(email, password) {
  let result  = await authService.register(email, password || 'testpassword123');
  let decoded = authService.verifyToken(result.token);
  let umk     = authService.getUMK(decoded);

  return { ...result, umk, decoded };
}

// =============================================================================
// Helper: create session + agent + participant for interaction tests
// =============================================================================

async function setupInteraction(orgID) {
  let models  = core.getModels();
  let session = await sessionManager.createSession(orgID, { name: 'Test Session' });

  let agent = await models.Agent.create({
    organizationID: orgID,
    name:           'test-mock-agent',
    pluginID:       'mock-agent',
    instructions:   'You are a test agent.',
  });

  let participant = await sessionManager.addParticipant(session.id, agent.id);

  return { session, agent, participant };
}

// =============================================================================
// 1. User Registration -> Login Flow
// =============================================================================

describe('Integration: User Registration -> Login Flow', () => {
  it('should register a new user and return user, token, and organization', async () => {
    let result = await authService.register('integ-reg@example.com', 'securepass123');

    assert.ok(result.user);
    assert.ok(result.token);
    assert.ok(result.organization);
    assert.ok(result.user.id.startsWith('usr_'));
    assert.ok(result.organization.id.startsWith('org_'));
  });

  it('should persist user to database', async () => {
    let models = core.getModels();
    let result = await authService.register('integ-persist@example.com', 'securepass123');
    let found  = await models.User.where.id.EQ(result.user.id).first();

    assert.ok(found);
    assert.equal(found.email, 'integ-persist@example.com');
  });

  it('should login with same credentials after registration', async () => {
    await authService.register('integ-login@example.com', 'securepass123');
    let loginResult = await authService.login('integ-login@example.com', 'securepass123');

    assert.ok(loginResult.user);
    assert.ok(loginResult.token);
    assert.equal(loginResult.user.email, 'integ-login@example.com');
  });

  it('should produce valid tokens on login', async () => {
    await authService.register('integ-token@example.com', 'securepass123');
    let loginResult = await authService.login('integ-token@example.com', 'securepass123');
    let decoded     = authService.verifyToken(loginResult.token);

    assert.equal(decoded.sub, loginResult.user.id);
    assert.ok(decoded.vault);
  });

  it('should produce same UMK from registration and login', async () => {
    let regResult   = await authService.register('integ-umk@example.com', 'securepass123');
    let regDecoded  = authService.verifyToken(regResult.token);
    let regUMK      = authService.getUMK(regDecoded);

    let loginResult  = await authService.login('integ-umk@example.com', 'securepass123');
    let loginDecoded = authService.verifyToken(loginResult.token);
    let loginUMK     = authService.getUMK(loginDecoded);

    assert.deepEqual(loginUMK, regUMK);
  });
});

// =============================================================================
// 2. Session Lifecycle
// =============================================================================

describe('Integration: Session Lifecycle', () => {
  let testUser;

  before(async () => {
    testUser = await createTestUser('session-lifecycle@example.com');
  });

  it('should create a session for an organization', async () => {
    let session = await sessionManager.createSession(testUser.organization.id, { name: 'Lifecycle Test' });

    assert.ok(session);
    assert.ok(session.id);
    assert.equal(session.organizationID, testUser.organization.id);
    assert.equal(session.name, 'Lifecycle Test');
  });

  it('should retrieve a session by ID', async () => {
    let session = await sessionManager.createSession(testUser.organization.id, { name: 'Retrieve Test' });
    let found   = await sessionManager.getSession(session.id);

    assert.ok(found);
    assert.equal(found.id, session.id);
    assert.equal(found.name, 'Retrieve Test');
  });

  it('should list sessions for an organization', async () => {
    let sessions = await sessionManager.getSessions(testUser.organization.id);

    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length >= 2); // created 2 above
  });

  it('should create an agent and add as participant', async () => {
    let models  = core.getModels();
    let session = await sessionManager.createSession(testUser.organization.id);

    let agent = await models.Agent.create({
      organizationID: testUser.organization.id,
      name:           'test-lifecycle-agent',
      pluginID:       'mock-agent',
    });

    let participant = await sessionManager.addParticipant(session.id, agent.id);

    assert.ok(participant);
    assert.equal(participant.sessionID, session.id);
    assert.equal(participant.agentID, agent.id);
  });

  it('should list participants for a session', async () => {
    let models  = core.getModels();
    let session = await sessionManager.createSession(testUser.organization.id);

    let agent = await models.Agent.create({
      organizationID: testUser.organization.id,
      name:           'test-participant-agent',
      pluginID:       'mock-agent',
    });

    await sessionManager.addParticipant(session.id, agent.id);
    let participants = await sessionManager.getParticipants(session.id);

    assert.equal(participants.length, 1);
    assert.equal(participants[0].agentID, agent.id);
  });
});

// =============================================================================
// 3. Simple Interaction
// =============================================================================

describe('Integration: Simple Interaction', () => {
  let testUser, session, agent;

  before(async () => {
    testUser = await createTestUser('simple-interaction@example.com');
    let setup = await setupInteraction(testUser.organization.id);
    session = setup.session;
    agent   = setup.agent;
  });

  it('should create user-message and agent-message frames', async () => {
    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Hello!</p>' } },
    ]);

    let interactionID = await interactionLoop.startInteraction(session.id, {
      agentPlugin: mockAgent,
      agent,
      userMessage: 'Hi there',
    });

    assert.ok(interactionID);

    let frameManager = await framePersistence.loadFrames(session.id);
    let frames       = frameManager.toArray();

    // Should have at least a user-message and an agent message
    let userFrame  = frames.find((f) => f.type === 'user-message');
    let agentFrame = frames.find((f) => f.type === 'message');

    assert.ok(userFrame, 'should have a user-message frame');
    assert.ok(agentFrame, 'should have an agent message frame');
    assert.equal(userFrame.content.text, 'Hi there');
    assert.equal(agentFrame.content.html, '<p>Hello!</p>');
  });

  it('should persist frames with correct order (monotonic)', async () => {
    let testUser2 = await createTestUser('order-test@example.com');
    let setup     = await setupInteraction(testUser2.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>First</p>' } },
      { type: 'message', content: { html: '<p>Second</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Test order',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();

    // Verify order is monotonically increasing
    for (let i = 1; i < frames.length; i++)
      assert.ok(frames[i].order > frames[i - 1].order, `frame ${i} order should be > frame ${i - 1} order`);
  });

  it('should assign correct interactionID to all frames', async () => {
    let testUser2 = await createTestUser('intid-test@example.com');
    let setup     = await setupInteraction(testUser2.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Same interaction</p>' } },
    ]);

    let interactionID = await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Check interaction ID',
    });

    // Load frames from DB (exclude participant lifecycle frames which have their own IDs)
    let models   = core.getModels();
    let dbFrames = await models.Frame.where.sessionID.EQ(setup.session.id).all();
    let interactionFrames = dbFrames.filter((f) => f.type !== 'participant-joined' && f.type !== 'participant-left');

    for (let frame of interactionFrames)
      assert.equal(frame.interactionID, interactionID, 'All frames should have same interactionID');
  });

  it('should set authorType correctly on user and agent frames', async () => {
    let testUser2 = await createTestUser('author-test@example.com');
    let setup     = await setupInteraction(testUser2.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Agent reply</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Who am I?',
      authorType:  'user',
      authorID:    testUser2.user.id,
    });

    let models   = core.getModels();
    let dbFrames = await models.Frame.where.sessionID.EQ(setup.session.id).ORDER('+Frame:order').all();

    let userFrame  = dbFrames.find((f) => f.type === 'user-message');
    let agentFrame = dbFrames.find((f) => f.type === 'message');

    assert.equal(userFrame.authorType, 'user');
    assert.equal(userFrame.authorID, testUser2.user.id);
    assert.equal(agentFrame.authorType, 'agent');
  });

  it('should sanitize HTML content in agent messages', async () => {
    let testUser2 = await createTestUser('sanitize-simple@example.com');
    let setup     = await setupInteraction(testUser2.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Safe</p><script>alert("xss")</script>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Sanitize me',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();
    let agentFrame   = frames.find((f) => f.type === 'message');

    assert.ok(agentFrame);
    assert.ok(!agentFrame.content.html.includes('<script>'), 'script tag should be stripped');
    assert.ok(agentFrame.content.html.includes('<p>Safe</p>'), 'safe HTML should be preserved');
  });
});

// =============================================================================
// 4. Multi-Message Interaction
// =============================================================================

describe('Integration: Multi-Message Interaction', () => {
  it('should persist all agent message frames in correct order', async () => {
    let testUser = await createTestUser('multi-msg@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>First reply</p>' } },
      { type: 'message', content: { html: '<p>Second reply</p>' } },
      { type: 'message', content: { html: '<p>Third reply</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Multi message test',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();
    let agentFrames  = frames.filter((f) => f.type === 'message');

    assert.equal(agentFrames.length, 3, 'should have 3 agent message frames');
    assert.equal(agentFrames[0].content.html, '<p>First reply</p>');
    assert.equal(agentFrames[1].content.html, '<p>Second reply</p>');
    assert.equal(agentFrames[2].content.html, '<p>Third reply</p>');
  });

  it('should have correct frame type for each block', async () => {
    let testUser = await createTestUser('multi-type@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'reflection', content: { text: 'Thinking...' } },
      { type: 'message', content: { html: '<p>Answer</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Think then answer',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();

    let reflectionFrame = frames.find((f) => f.type === 'reflection');
    let messageFrame    = frames.find((f) => f.type === 'message');

    assert.ok(reflectionFrame, 'should have a reflection frame');
    assert.ok(messageFrame, 'should have a message frame');
    assert.equal(reflectionFrame.content.text, 'Thinking...');
    assert.equal(reflectionFrame.hidden, true, 'reflection frames should be hidden');
  });

  it('should maintain monotonic order across user + multiple agent frames', async () => {
    let testUser = await createTestUser('multi-order@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>A</p>' } },
      { type: 'message', content: { html: '<p>B</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Order check',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();

    for (let i = 1; i < frames.length; i++)
      assert.ok(frames[i].order > frames[i - 1].order, `Frame order must increase monotonically`);
  });
});

// =============================================================================
// 5. Tool Call Interaction
// =============================================================================

describe('Integration: Tool Call Interaction', () => {
  it('should persist tool-call and tool-result frames', async () => {
    let testUser = await createTestUser('tool-call@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'calculator', arguments: { expr: '2+2' } } },
      { type: 'message', content: { html: '<p>The answer is 4</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'What is 2+2?',
      executeTool: async (toolName, args) => {
        if (toolName === 'calculator')
          return '4';

        return 'unknown tool';
      },
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();

    let toolCallFrame   = frames.find((f) => f.type === 'tool-call');
    let toolResultFrame = frames.find((f) => f.type === 'tool-result');
    let messageFrame    = frames.filter((f) => f.type === 'message');

    assert.ok(toolCallFrame, 'should have a tool-call frame');
    assert.ok(toolResultFrame, 'should have a tool-result frame');
    assert.equal(toolCallFrame.content.toolName, 'calculator');
    assert.deepEqual(toolCallFrame.content.arguments, { expr: '2+2' });
    assert.equal(toolResultFrame.content.output, '4');
    assert.ok(messageFrame.length >= 1, 'should have at least one agent message');
  });

  it('should pass tool result back to the agent generator', async () => {
    let testUser = await createTestUser('tool-result@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'lookup', arguments: { key: 'foo' } } },
      { type: 'message', content: { html: '<p>Got the result</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Look up foo',
      executeTool: async () => 'bar',
    });

    // Verify the agent received the tool result
    assert.ok(mockAgent._lastToolResult);
    assert.equal(mockAgent._lastToolResult.type, 'tool-result');
    assert.equal(mockAgent._lastToolResult.content.output, 'bar');
  });

  it('should persist frames in correct order: user -> tool-call -> tool-result -> message', async () => {
    let testUser = await createTestUser('tool-order@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'search', arguments: { q: 'test' } } },
      { type: 'message', content: { html: '<p>Found it</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Search for test',
      executeTool: async () => 'result',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let allFrames    = frameManager.toArray();

    // Filter out participant lifecycle frames (created by addParticipant in setup)
    let frames = allFrames.filter((f) => f.type !== 'participant-joined' && f.type !== 'participant-left');

    assert.equal(frames[0].type, 'user-message');
    assert.equal(frames[1].type, 'tool-call');
    assert.equal(frames[2].type, 'tool-result');
    assert.equal(frames[3].type, 'message');
  });
});

// =============================================================================
// 6. Permission Hard-Break Flow
// =============================================================================

describe('Integration: Permission Hard-Break Flow', () => {
  it('should create pending-action and permission-request frames when permission needed', async () => {
    let testUser = await createTestUser('perm-break@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'danger', arguments: { action: 'delete' } } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin:     mockAgent,
      agent:           setup.agent,
      userMessage:     'Do something dangerous',
      checkPermission: async () => true, // always needs permission
      executeTool:     async () => 'done',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();

    let pendingFrame    = frames.find((f) => f.type === 'pending-action');
    let permissionFrame = frames.find((f) => f.type === 'permission-request');

    assert.ok(pendingFrame, 'should have a pending-action frame');
    assert.ok(permissionFrame, 'should have a permission-request frame');
    assert.equal(pendingFrame.content.toolName, 'danger');
  });

  it('should end the interaction on permission hard-break', async () => {
    let testUser = await createTestUser('perm-end@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'risky', arguments: {} } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin:     mockAgent,
      agent:           setup.agent,
      userMessage:     'Risky op',
      checkPermission: async () => true,
      executeTool:     async () => 'done',
    });

    assert.equal(interactionLoop.isActive(setup.session.id), false, 'interaction should not be active');
    assert.equal(interactionLoop.isWaitingForPermission(setup.session.id), true, 'should be waiting for permission');
  });

  it('should execute tool and create new interaction on approval', async () => {
    let testUser = await createTestUser('perm-approve@example.com');
    let setup    = await setupInteraction(testUser.organization.id);
    let toolExecuted = false;

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'deploy', arguments: { env: 'prod' } } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin:     mockAgent,
      agent:           setup.agent,
      userMessage:     'Deploy to prod',
      checkPermission: async () => true,
      executeTool:     async (toolName) => {
        toolExecuted = true;
        return `deployed to ${toolName}`;
      },
    });

    // Now approve
    await interactionLoop.approvePermission(setup.session.id);

    assert.ok(toolExecuted, 'tool should have been executed after approval');

    // Should have tool-result frame from approval
    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();
    let toolResult   = frames.find((f) => f.type === 'tool-result');

    assert.ok(toolResult, 'should have a tool-result frame after approval');
  });

  it('should create permission-denied frame on denial and replay', async () => {
    let testUser = await createTestUser('perm-deny@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'nuke', arguments: {} } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin:     mockAgent,
      agent:           setup.agent,
      userMessage:     'Launch nukes',
      checkPermission: async () => true,
      executeTool:     async () => 'boom',
    });

    // Deny — now triggers a replay interaction
    await interactionLoop.denyPermission(setup.session.id);

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();
    let denialFrame  = frames.find((f) => f.type === 'permission-denied');

    assert.ok(denialFrame, 'should have a permission-denied frame');

    // After deny-with-replay, the mock agent re-yields the same tool-call
    // and hits permission-waiting again. In production the agent sees the
    // denial in history and adjusts; mock agents don't, so permission-waiting
    // returns to true.
    assert.equal(interactionLoop.isWaitingForPermission(setup.session.id), true,
      'replay agent re-yields tool-call, so permission-waiting again');
  });

  it('should mark pending-action and permission-request as processed on approval', async () => {
    let testUser = await createTestUser('perm-processed@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'update', arguments: {} } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin:     mockAgent,
      agent:           setup.agent,
      userMessage:     'Update something',
      checkPermission: async () => true,
      executeTool:     async () => 'updated',
    });

    await interactionLoop.approvePermission(setup.session.id);

    let models   = core.getModels();
    let dbFrames = await models.Frame.where.sessionID.EQ(setup.session.id).ORDER('+Frame:order').all();

    let pendingFrame = dbFrames.find((f) => f.type === 'pending-action');
    let requestFrame = dbFrames.find((f) => f.type === 'permission-request');

    assert.ok(pendingFrame.processed, 'pending-action should be marked processed');
    assert.ok(requestFrame.processed, 'permission-request should be marked processed');
  });
});

// =============================================================================
// 7. Message Queue Flow
// =============================================================================

describe('Integration: Message Queue Flow', () => {
  it('should queue messages while interaction is active', async () => {
    let testUser = await createTestUser('queue-basic@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    // Use slow agent to give us time to queue
    let slowAgent = new SlowMockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Slow reply</p>' } },
    ], 100);

    // Start interaction (don't await — it runs async)
    let interactionPromise = interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: slowAgent,
      agent:       setup.agent,
      userMessage: 'First message',
    });

    // Wait a tick for the interaction to start
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Queue a message while busy
    interactionLoop.queueMessage(setup.session.id, 'Queued message');

    let queued = interactionLoop.getQueuedMessages(setup.session.id);
    assert.equal(queued.length, 1);
    assert.equal(queued[0], 'Queued message');

    // Wait for the interaction to finish
    await interactionPromise;
  });

  it('should auto-send queued message after first interaction completes', async () => {
    let testUser = await createTestUser('queue-drain@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    // Use slow agent with blocks
    let slowAgent = new SlowMockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>First response</p>' } },
    ], 50);

    // Start the first interaction
    let interactionPromise = interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: slowAgent,
      agent:       setup.agent,
      userMessage: 'First',
    });

    // Wait for the interaction to be tracked
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Queue via startInteraction (which internally calls queueMessage when active)
    interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: slowAgent,
      agent:       setup.agent,
      userMessage: 'Second',
    });

    // Wait for everything to finish (first interaction + queued drain)
    await interactionPromise;

    // Small extra wait for the queue drain
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify both user messages are in the frames
    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();
    let userFrames   = frames.filter((f) => f.type === 'user-message');

    assert.ok(userFrames.length >= 2, 'should have at least 2 user-message frames');
  });

  it('should combine multiple queued messages', async () => {
    let testUser = await createTestUser('queue-combine@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let slowAgent = new SlowMockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Response</p>' } },
    ], 100);

    let interactionPromise = interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: slowAgent,
      agent:       setup.agent,
      userMessage: 'First',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    interactionLoop.queueMessage(setup.session.id, 'Queued A');
    interactionLoop.queueMessage(setup.session.id, 'Queued B');

    let queued = interactionLoop.getQueuedMessages(setup.session.id);
    assert.equal(queued.length, 2);

    await interactionPromise;
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});

// =============================================================================
// 8. Agent API Key Encryption
// =============================================================================

describe('Integration: Agent API Key Encryption', () => {
  it('should encrypt and store API key on agent record', async () => {
    let testUser = await createTestUser('encrypt-key@example.com');
    let userKey  = keystore.deriveUserKey(testUser.umk, testUser.user.id);
    let models   = core.getModels();

    // Encrypt the API key
    let apiKey       = 'sk-test-12345-abcdef';
    let encryptedKey = keystore.encrypt(apiKey, userKey);

    let agent = await models.Agent.create({
      organizationID:  testUser.organization.id,
      name:            'test-encrypted-agent',
      pluginID:        'mock-agent',
      encryptedAPIKey: JSON.stringify(encryptedKey),
    });

    assert.ok(agent.encryptedAPIKey);
    assert.ok(agent.encryptedAPIKey.includes('ciphertext'));
  });

  it('should decrypt API key to original value', async () => {
    let testUser = await createTestUser('decrypt-key@example.com');
    let userKey  = keystore.deriveUserKey(testUser.umk, testUser.user.id);
    let models   = core.getModels();

    let apiKey       = 'sk-anthropic-secret-key-xyz';
    let encryptedKey = keystore.encrypt(apiKey, userKey);

    let agent = await models.Agent.create({
      organizationID:  testUser.organization.id,
      name:            'test-decrypt-agent',
      pluginID:        'mock-agent',
      encryptedAPIKey: JSON.stringify(encryptedKey),
    });

    // Decrypt
    let storedEncrypted = JSON.parse(agent.encryptedAPIKey);
    let decrypted       = keystore.decrypt(storedEncrypted, userKey);

    assert.equal(decrypted.toString('utf8'), apiKey);
  });

  it('should fail decryption with wrong user key', async () => {
    let testUser1 = await createTestUser('wrong-key-1@example.com');
    let testUser2 = await createTestUser('wrong-key-2@example.com');
    let userKey1  = keystore.deriveUserKey(testUser1.umk, testUser1.user.id);
    let userKey2  = keystore.deriveUserKey(testUser2.umk, testUser2.user.id);
    let models    = core.getModels();

    let apiKey       = 'sk-secret-key';
    let encryptedKey = keystore.encrypt(apiKey, userKey1);

    let agent = await models.Agent.create({
      organizationID:  testUser1.organization.id,
      name:            'test-wrong-key-agent',
      pluginID:        'mock-agent',
      encryptedAPIKey: JSON.stringify(encryptedKey),
    });

    let storedEncrypted = JSON.parse(agent.encryptedAPIKey);

    assert.throws(
      () => keystore.decrypt(storedEncrypted, userKey2),
      'decrypting with wrong key should throw',
    );
  });
});

// =============================================================================
// 9. Content Sanitization in Interaction
// =============================================================================

describe('Integration: Content Sanitization in Interaction', () => {
  it('should strip script tags from persisted agent message frames', async () => {
    let testUser = await createTestUser('sanitize-script@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Hello</p><script>alert("xss")</script><b>World</b>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Test XSS',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();
    let agentFrame   = frames.find((f) => f.type === 'message');

    assert.ok(agentFrame);
    assert.ok(!agentFrame.content.html.includes('script'), 'should not contain script');
    assert.ok(!agentFrame.content.html.includes('alert'), 'should not contain alert');
    assert.ok(agentFrame.content.html.includes('<p>Hello</p>'), 'should preserve safe <p>');
    assert.ok(agentFrame.content.html.includes('<b>World</b>'), 'should preserve safe <b>');
  });

  it('should strip iframe and style tags while preserving safe content', async () => {
    let testUser = await createTestUser('sanitize-iframe@example.com');
    let setup    = await setupInteraction(testUser.organization.id);

    let mockAgent = new MockAgent(core.getContext(), [
      {
        type:    'message',
        content: {
          html: '<h1>Title</h1><iframe src="evil.com"></iframe><style>body{display:none}</style><p>Content</p>',
        },
      },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Test iframe/style',
    });

    let frameManager = await framePersistence.loadFrames(setup.session.id);
    let frames       = frameManager.toArray();
    let agentFrame   = frames.find((f) => f.type === 'message');

    assert.ok(agentFrame);
    assert.ok(!agentFrame.content.html.includes('iframe'), 'should not contain iframe');
    assert.ok(!agentFrame.content.html.includes('style'), 'should not contain style');
    assert.ok(agentFrame.content.html.includes('<h1>Title</h1>'), 'should preserve <h1>');
    assert.ok(agentFrame.content.html.includes('<p>Content</p>'), 'should preserve <p>');
  });
});

// =============================================================================
// 10. Event Emission
// =============================================================================

describe('Integration: Event Emission', () => {
  it('should emit interaction:start and interaction:end events', async () => {
    let testUser = await createTestUser('events-start-end@example.com');
    let setup    = await setupInteraction(testUser.organization.id);
    let events   = [];

    interactionLoop.on('interaction:start', (ev) => events.push({ type: 'start', ...ev }));
    interactionLoop.on('interaction:end', (ev) => events.push({ type: 'end', ...ev }));

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Event test</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Emit events',
    });

    let starts = events.filter((e) => e.type === 'start' && e.sessionID === setup.session.id);
    let ends   = events.filter((e) => e.type === 'end' && e.sessionID === setup.session.id);

    assert.ok(starts.length >= 1, 'should have at least one interaction:start event');
    assert.ok(ends.length >= 1, 'should have at least one interaction:end event');
    assert.ok(starts[0].interactionID, 'start event should have interactionID');
    assert.equal(starts[0].interactionID, ends[0].interactionID, 'start and end should have same interactionID');

    // Clean up listeners
    interactionLoop.removeAllListeners('interaction:start');
    interactionLoop.removeAllListeners('interaction:end');
  });

  it('should emit frame events for each persisted frame', async () => {
    let testUser    = await createTestUser('events-frame@example.com');
    let setup       = await setupInteraction(testUser.organization.id);
    let frameEvents = [];

    let listener = (ev) => {
      if (ev.sessionID === setup.session.id)
        frameEvents.push(ev);
    };

    interactionLoop.on('frame', listener);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'message', content: { html: '<p>Frame 1</p>' } },
      { type: 'message', content: { html: '<p>Frame 2</p>' } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin: mockAgent,
      agent:       setup.agent,
      userMessage: 'Emit frame events',
    });

    // Should have: user-message frame + 2 agent message frames = 3 frame events
    assert.ok(frameEvents.length >= 3, `should have at least 3 frame events, got ${frameEvents.length}`);

    let types = frameEvents.map((e) => e.frame.type);
    assert.ok(types.includes('user-message'), 'should have user-message frame event');
    assert.ok(types.includes('message'), 'should have message frame event');

    interactionLoop.removeListener('frame', listener);
  });

  it('should emit permission:request event on hard-break', async () => {
    let testUser         = await createTestUser('events-perm@example.com');
    let setup            = await setupInteraction(testUser.organization.id);
    let permissionEvents = [];

    let listener = (ev) => {
      if (ev.sessionID === setup.session.id)
        permissionEvents.push(ev);
    };

    interactionLoop.on('permission:request', listener);

    let mockAgent = new MockAgent(core.getContext(), [
      { type: 'tool-call', content: { toolName: 'danger', arguments: {} } },
    ]);

    await interactionLoop.startInteraction(setup.session.id, {
      agentPlugin:     mockAgent,
      agent:           setup.agent,
      userMessage:     'Permission event test',
      checkPermission: async () => true,
      executeTool:     async () => 'done',
    });

    assert.equal(permissionEvents.length, 1, 'should have exactly 1 permission:request event');
    assert.equal(permissionEvents[0].toolName, 'danger');
    assert.ok(permissionEvents[0].frameID);
    assert.ok(permissionEvents[0].requestFrameID);

    interactionLoop.removeListener('permission:request', listener);

    // Clean up waiting state
    await interactionLoop.denyPermission(setup.session.id);
  });
});
