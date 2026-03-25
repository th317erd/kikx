'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }   from '../../../src/core/index.mjs';
import { InteractionLoop }  from '../../../src/core/interaction/index.mjs';
import { SessionManager }   from '../../../src/core/session/index.mjs';
import { FramePersistence }  from '../../../src/core/frames/index.mjs';
import { ContentSanitizer }  from '../../../src/core/lib/content-sanitizer.mjs';
import { PluginInterface }   from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }    from '../../../src/core/plugin-loader/registry.mjs';
import { AgentInterface }          from '../../../src/core/plugins/agent-interface.mjs';
import { PermissionRequiredError } from '../../../src/core/permissions/permission-required-error.mjs';
import { setup as setupCrossSession } from '../../../src/core/internal-plugins/cross-session/index.mjs';

// =============================================================================
// Step 9: Child Session Deliberation — Integration Test
// =============================================================================
// Full end-to-end scenarios combining:
//   - Child session creation with roles and constraints
//   - Per-agent interaction loops (concurrent agents)
//   - Cross-session postToSession
//   - Permission handling across sessions
//   - Session ancestry and permission walk-up
// =============================================================================

// Mock agent that yields configurable blocks
class MockAgent extends AgentInterface {
  static pluginID    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for integration testing';
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

describe('Child Session Deliberation — Integration', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let interactionLoop;
  let registry;
  let org;

  let CreateSessionTool;
  let PostToSessionTool;

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

    // Register cross-session plugin
    registry = new PluginRegistry();
    setupCrossSession({
      registerTool: (name, cls) => registry.registerTool(name, cls),
      PluginInterface,
      context,
    });

    CreateSessionTool = registry.getTool('cross-session:createSession');
    PostToSessionTool = registry.getTool('cross-session:postToSession');

    // Create test org
    org = await models.Organization.create({ name: 'Deliberation Integration Org' });
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // Helpers
  async function createAgent(name) {
    return models.Agent.create({ organizationID: org.id, name, pluginID: 'mock-agent' });
  }

  function defaultParams(agentPlugin, overrides = {}) {
    return {
      agentPlugin,
      agent:       overrides.agent || { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: overrides.userMessage !== undefined ? overrides.userMessage : 'Hello',
      authorType:  overrides.authorType || 'user',
      authorID:    overrides.authorID || 'user_123',
      ...overrides,
    };
  }

  // ===========================================================================
  // 1. Full lifecycle: create child → add participants → interaction → frames
  // ===========================================================================

  describe('full child session lifecycle', () => {
    it('should create child session with coordinator and member, run interaction, produce frames', async () => {
      let agentA = await createAgent(`test-delib-a-${Date.now()}`);
      let agentB = await createAgent(`test-delib-b-${Date.now()}`);

      // Create parent session with a user message
      let parentSession = await sessionManager.createSession(org.id, { name: 'Deliberation Parent' });
      let parentFM = sessionManager.getFrameManager(parentSession.id);
      await framePersistence.loadFramesInto(parentFM, parentSession.id);

      // User sends a message in parent
      await interactionLoop.postMessage(parentSession.id, {
        text:       'What should we do about the bug?',
        authorType: 'user',
        authorID:   'user_123',
      });

      // Agent A creates a child session for deliberation
      let createTool = new CreateSessionTool(context);
      let createResult = await createTool._execute({
        title:           'Bug Discussion',
        participants:    [agentA.name, agentB.name],
        agentID:         agentA.id,
        parentSessionID: parentSession.id,
        initialMessage:  'Let me discuss this bug with agent B.',
        constraints:     { maxInteractions: 10 },
      });

      let childSessionID = createResult.sessionID;

      // Verify child session structure
      let childSession = await sessionManager.getSession(childSessionID);
      assert.equal(childSession.parentSessionID, parentSession.id, 'Child should reference parent');
      assert.equal(childSession.maxInteractions, 10, 'Constraints should be applied');

      // Verify participant roles
      let participants = await sessionManager.getParticipants(childSessionID);
      let coordinatorA = participants.find((p) => p.agentID === agentA.id);
      let memberB      = participants.find((p) => p.agentID === agentB.id);
      assert.equal(coordinatorA.role, 'coordinator');
      assert.equal(memberB.role, 'member');

      // Verify initial message frame exists
      let childFM = await framePersistence.loadFrames(childSessionID);
      let childFrames = childFM.toArray();
      let messageFrames = childFrames.filter((f) => f.type === 'Message');
      assert.ok(messageFrames.some((f) => f.content && f.content.text === 'Let me discuss this bug with agent B.'));

      // Run an interaction in the child session
      let agentBlocks = [
        { type: 'Message', content: { html: '<p>I think the bug is in the parser.</p>' }, authorType: 'agent', authorID: agentA.id },
      ];
      let mockAgent = new MockAgent(context, agentBlocks);

      await interactionLoop.startInteraction(childSessionID, defaultParams(mockAgent, {
        agent:       agentA,
        authorType:  'agent',
        authorID:    agentA.id,
        userMessage: null,
      }));

      // Verify interaction produced frames in child
      let updatedChildFM = await framePersistence.loadFrames(childSessionID);
      let allChildFrames = updatedChildFM.toArray();
      let agentMessages  = allChildFrames.filter((f) => f.type === 'Message' && f.authorID === agentA.id);
      assert.ok(agentMessages.length >= 1, 'Child should have agent message frames');
    });
  });

  // ===========================================================================
  // 2. Concurrent agent interactions in child session
  // ===========================================================================

  describe('concurrent agent interactions', () => {
    it('should allow two agents to interact concurrently in same session', async () => {
      let agentX = await createAgent(`test-conc-x-${Date.now()}`);
      let agentY = await createAgent(`test-conc-y-${Date.now()}`);

      let session = await sessionManager.createSession(org.id, { name: 'Concurrent Agents' });
      await sessionManager.addParticipant(session.id, agentX.id);
      await sessionManager.addParticipant(session.id, agentY.id);

      // Both agents produce messages
      let blocksX = [
        { type: 'Message', content: { html: '<p>Agent X response</p>' }, authorType: 'agent', authorID: agentX.id },
      ];
      let blocksY = [
        { type: 'Message', content: { html: '<p>Agent Y response</p>' }, authorType: 'agent', authorID: agentY.id },
      ];

      let agentMockX = new MockAgent(context, blocksX);
      let agentMockY = new MockAgent(context, blocksY);

      // Start both concurrently
      let [interactionX, interactionY] = await Promise.all([
        interactionLoop.startInteraction(session.id, defaultParams(agentMockX, {
          agent:       agentX,
          authorType:  'agent',
          authorID:    agentX.id,
          userMessage: null,
        })),
        interactionLoop.startInteraction(session.id, defaultParams(agentMockY, {
          agent:       agentY,
          authorType:  'agent',
          authorID:    agentY.id,
          userMessage: null,
        })),
      ]);

      assert.ok(interactionX, 'Agent X interaction should start');
      assert.ok(interactionY, 'Agent Y interaction should start');

      // Both agents' frames should be in the session
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let xMsgs  = frames.filter((f) => f.type === 'Message' && f.authorID === agentX.id);
      let yMsgs  = frames.filter((f) => f.type === 'Message' && f.authorID === agentY.id);

      assert.ok(xMsgs.length >= 1, 'Agent X should have messages');
      assert.ok(yMsgs.length >= 1, 'Agent Y should have messages');
    });
  });

  // ===========================================================================
  // 3. Permission in child session routes to parent with user
  // ===========================================================================

  describe('cross-session permission routing', () => {
    it('should route permission-request from child to parent when child has no user', async () => {
      let agent = await createAgent(`test-perm-route-${Date.now()}`);

      // Parent session with user
      let parentSession = await sessionManager.createSession(org.id, { name: 'Permission Parent' });
      await interactionLoop.postMessage(parentSession.id, {
        text:       'User message in parent',
        authorType: 'user',
        authorID:   'user_123',
      });

      // Child session (agent-only)
      let childSession = await sessionManager.createSession(org.id, {
        name:            'Permission Child',
        parentSessionID: parentSession.id,
      });

      // Agent tries to use a tool that needs permission
      let blocks = [
        { type: 'ToolCall', content: { toolName: 'dangerous-tool', arguments: {}, toolUseID: 'tu_int_1' }, authorType: 'agent', authorID: agent.id },
      ];
      let mockAgent = new MockAgent(context, blocks);

      await interactionLoop.startInteraction(childSession.id, defaultParams(mockAgent, {
        agent:           agent,
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        agent.id,
        userMessage:     null,
      }));

      // Permission-request should be in parent
      let parentFM     = await framePersistence.loadFrames(parentSession.id);
      let parentFrames = parentFM.toArray();
      let parentRequests = parentFrames.filter((f) => f.type === 'PermissionRequest');
      assert.ok(parentRequests.length >= 1, 'Parent should have the permission-request');

      // Pending-action should be in child
      let childFM     = await framePersistence.loadFrames(childSession.id);
      let childFrames = childFM.toArray();
      let childPending = childFrames.filter((f) => f.type === 'PendingAction');
      assert.ok(childPending.length >= 1, 'Child should have the pending-action');

      // Interaction should have ended (hardBreak cleans up active state)
      assert.equal(interactionLoop.isActive(childSession.id), false);
    });
  });

  // ===========================================================================
  // 4. Permission walk-up through ancestry chain
  // ===========================================================================

  describe('permission walk-up through ancestry', () => {
    it('should walk up grandparent → parent → child to find user session', async () => {
      let agent = await createAgent(`test-walkup-${Date.now()}`);

      // Grandparent with user
      let grandparent = await sessionManager.createSession(org.id, { name: 'Grandparent' });
      await interactionLoop.postMessage(grandparent.id, {
        text:       'User in grandparent',
        authorType: 'user',
        authorID:   'user_123',
      });

      // Parent (no user)
      let parent = await sessionManager.createSession(org.id, {
        name:            'Parent',
        parentSessionID: grandparent.id,
      });

      // Child (no user)
      let child = await sessionManager.createSession(org.id, {
        name:            'Child',
        parentSessionID: parent.id,
      });

      // Agent in child needs permission
      let blocks = [
        { type: 'ToolCall', content: { toolName: 'risky-op', arguments: {}, toolUseID: 'tu_int_2' }, authorType: 'agent', authorID: agent.id },
      ];
      let mockAgent = new MockAgent(context, blocks);

      await interactionLoop.startInteraction(child.id, defaultParams(mockAgent, {
        agent:           agent,
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        agent.id,
        userMessage:     null,
      }));

      // Permission-request should be in grandparent (nearest user ancestor)
      let gpFM = await framePersistence.loadFrames(grandparent.id);
      let gpRequests = gpFM.toArray().filter((f) => f.type === 'PermissionRequest');
      assert.ok(gpRequests.length >= 1, 'Grandparent should have the permission-request');

      // Not in parent or child
      let parentFM = await framePersistence.loadFrames(parent.id);
      assert.equal(parentFM.toArray().filter((f) => f.type === 'PermissionRequest').length, 0);
    });
  });

  // ===========================================================================
  // 5. Orphan session with no user → immediate denial
  // ===========================================================================

  describe('orphan agent-only session', () => {
    it('should deny immediately when no user exists in ancestry', async () => {
      let agent = await createAgent(`test-orphan-${Date.now()}`);

      let session = await sessionManager.createSession(org.id, { name: 'Orphan Agent Session' });

      let blocks = [
        { type: 'ToolCall', content: { toolName: 'rm-rf', arguments: { path: '/' }, toolUseID: 'tu_int_3' }, authorType: 'agent', authorID: agent.id },
      ];
      let mockAgent = new MockAgent(context, blocks);

      await interactionLoop.startInteraction(session.id, defaultParams(mockAgent, {
        agent:           agent,
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        agent.id,
        userMessage:     null,
      }));

      // Should NOT be active — denied immediately
      assert.equal(interactionLoop.isActive(session.id), false);

      // Should have denial tool-result
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let denialResults = frames.filter((f) =>
        f.type === 'ToolResult' && f.content && f.content.output && f.content.output.includes('denied'),
      );
      assert.ok(denialResults.length >= 1, 'Should have a denial tool-result');
    });
  });

  // ===========================================================================
  // 6. Session constraints enforcement
  // ===========================================================================

  describe('session constraints in child', () => {
    it('should enforce maxInteractions on a constrained child session', async () => {
      let agent = await createAgent(`test-constrained-${Date.now()}`);

      let parentSession = await sessionManager.createSession(org.id, { name: 'Constraint Parent' });

      // Create child with maxInteractions = 2
      let createTool = new CreateSessionTool(context);
      let result = await createTool._execute({
        title:           'Constrained Child',
        participants:    [agent.name],
        agentID:         agent.id,
        parentSessionID: parentSession.id,
        constraints:     { maxInteractions: 2 },
      });

      let childSession = await sessionManager.getSession(result.sessionID);
      assert.equal(childSession.maxInteractions, 2, 'Child should have maxInteractions = 2');
    });
  });

  // ===========================================================================
  // 7. Ancestry chain integrity
  // ===========================================================================

  describe('ancestry chain integrity', () => {
    it('should maintain correct ancestry from child to grandparent', async () => {
      let grandparent = await sessionManager.createSession(org.id, { name: 'Ancestry GP' });
      let parent = await sessionManager.createSession(org.id, {
        name:            'Ancestry Parent',
        parentSessionID: grandparent.id,
      });
      let child = await sessionManager.createSession(org.id, {
        name:            'Ancestry Child',
        parentSessionID: parent.id,
      });

      let chain = await sessionManager.getAncestryChain(child.id);
      assert.equal(chain.length, 3);
      assert.equal(chain[0], child.id);
      assert.equal(chain[1], parent.id);
      assert.equal(chain[2], grandparent.id);
    });
  });

  // ===========================================================================
  // 8. Cross-session permissions class integration
  // ===========================================================================

  describe('CrossSessionPermissions integration', () => {
    it('should auto-approve postToSession for session participants', async () => {
      let agent = await createAgent(`test-auto-approve-${Date.now()}`);

      let session = await sessionManager.createSession(org.id, { name: 'Auto Approve Session' });
      await sessionManager.addParticipant(session.id, agent.id);

      // Create a PostToSessionTool and check its permissions
      let postTool = new PostToSessionTool(context);
      let PermClass = postTool.getPermissionsClass();
      let perms = new PermClass(context);

      let result = await perms.checkPermission(
        'cross-session:postToSession',
        { sessionID: session.id, message: 'test', agentID: agent.id },
        {},
      );

      assert.equal(result, false, 'Participant should be auto-approved');
    });
  });
});
