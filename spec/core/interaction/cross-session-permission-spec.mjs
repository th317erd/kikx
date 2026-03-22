'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }     from '../../../src/core/index.mjs';
import { InteractionLoop }    from '../../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../../src/core/session/index.mjs';
import { FramePersistence }   from '../../../src/core/frames/index.mjs';
import { ContentSanitizer }   from '../../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }          from '../../../src/core/plugins/agent-interface.mjs';
import { PermissionRequiredError } from '../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// Mock Agent
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

// =============================================================================
// Cross-Session Permission Tests
// =============================================================================

describe('Cross-Session Permission Approval', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let sanitizer;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);
    sanitizer        = new ContentSanitizer();

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', sanitizer);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // Helpers
  async function createTestSession(options = {}) {
    let org     = await models.Organization.create({ name: 'Test Org' });
    let session = await sessionManager.createSession(org.id, { name: 'Test Session', ...options });
    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  function defaultParams(agentPlugin, overrides = {}) {
    return {
      agentPlugin,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Hello, agent!',
      authorType:  'user',
      authorID:    'user_123',
      ...overrides,
    };
  }

  // Helper: create a user-message frame in a session so getNearestUserAncestor finds it
  let _orderCounter = 0;

  async function addUserFrame(sessionID) {
    _orderCounter++;
    await framePersistence.saveFrames(sessionID, [{
      id:            `frm_${XID.next()}`,
      type:          'user-message',
      content:       { text: 'I am a user' },
      timestamp:     Date.now(),
      order:         _orderCounter,
      interactionID: `int_${XID.next()}`,
      authorType:    'user',
      authorID:      'user_123',
      hidden:        false,
      deleted:       false,
      processed:     false,
    }]);
  }

  // ===========================================================================
  // 1. Permission request in child session with no user → appears in parent
  // ===========================================================================

  describe('child session with no user — permission request in parent', () => {
    it('should create permission-request frame in the parent session', async () => {
      // Create parent session with a user frame
      let parentSession = await createTestSession();
      await addUserFrame(parentSession.id);

      // Create child session (no user frames)
      let childSession = await createTestSession({ parentSessionID: parentSession.id });

      let blocks = [
        { type: 'tool-call', content: { toolName: 'dangerous-tool', arguments: { x: 1 }, toolUseID: 'tu_1' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(childSession.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      // Permission-request should be in PARENT session
      let parentFM     = await framePersistence.loadFrames(parentSession.id);
      let parentFrames = parentFM.toArray();
      let parentRequests = parentFrames.filter((f) => f.type === 'permission-request');
      assert.equal(parentRequests.length, 1, 'parent should have 1 permission-request frame');
      assert.equal(parentRequests[0].content.toolName, 'dangerous-tool');

      // Permission-request should NOT be in child session
      let childFM     = await framePersistence.loadFrames(childSession.id);
      let childFrames = childFM.toArray();
      let childRequests = childFrames.filter((f) => f.type === 'permission-request');
      assert.equal(childRequests.length, 0, 'child should have 0 permission-request frames');
    });
  });

  // ===========================================================================
  // 2. Permission request walks up multiple levels to find user session
  // ===========================================================================

  describe('multi-level ancestry walk', () => {
    it('should walk up multiple levels to find a user session', async () => {
      // grandparent (has user) → parent (no user) → child (no user)
      let grandparent = await createTestSession();
      await addUserFrame(grandparent.id);

      let parent = await createTestSession({ parentSessionID: grandparent.id });
      let child  = await createTestSession({ parentSessionID: parent.id });

      let blocks = [
        { type: 'tool-call', content: { toolName: 'risky-op', arguments: {}, toolUseID: 'tu_2' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(child.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      // Permission-request should be in GRANDPARENT session
      let gpFM     = await framePersistence.loadFrames(grandparent.id);
      let gpFrames = gpFM.toArray();
      let gpRequests = gpFrames.filter((f) => f.type === 'permission-request');
      assert.equal(gpRequests.length, 1, 'grandparent should have 1 permission-request frame');

      // Not in parent or child
      let parentFM = await framePersistence.loadFrames(parent.id);
      assert.equal(parentFM.toArray().filter((f) => f.type === 'permission-request').length, 0);

      let childFM = await framePersistence.loadFrames(child.id);
      assert.equal(childFM.toArray().filter((f) => f.type === 'permission-request').length, 0);
    });
  });

  // ===========================================================================
  // 3. No user in ancestry → immediate denial
  // ===========================================================================

  describe('no user in ancestry — immediate denial', () => {
    it('should deny immediately when no user session exists in ancestry', async () => {
      // Orphan session (no parent, no user frames — agent-only interaction)
      let session = await createTestSession();

      let blocks = [
        { type: 'tool-call', content: { toolName: 'rm', arguments: { path: '/' }, toolUseID: 'tu_3' }, authorType: 'agent', authorID: 'a1' },
        { type: 'message', content: { html: '<p>After denial</p>' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      // Should NOT be waiting for permission (denied immediately)
      assert.equal(loop.isWaitingForPermission(session.id), false);

      // Should have a tool-result with denial message
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();

      let toolResults = frames.filter((f) => f.type === 'tool-result');
      assert.ok(toolResults.length >= 1, 'should have at least one tool-result frame');

      let denialResult = toolResults.find((f) => f.content && f.content.output && f.content.output.includes('denied'));
      assert.ok(denialResult, 'should have a denial tool-result');
    });
  });

  // ===========================================================================
  // 4. Approval in parent routes tool-result to child session's FrameManager
  // ===========================================================================

  describe('approval routes tool-result to child session', () => {
    it('should commit tool-result to the child (requesting) session on approval', async () => {
      let parentSession = await createTestSession();
      await addUserFrame(parentSession.id);

      let childSession = await createTestSession({ parentSessionID: parentSession.id });

      let interactionCount = 0;
      let toolExecuted     = false;

      class PermissionAgent extends AgentInterface {
        static pluginID    = 'perm-agent';
        static featureName = 'perm';
        static agentType   = 'perm';

        async *_createGenerator(_params) {
          interactionCount++;
          if (interactionCount === 1)
            yield { type: 'tool-call', content: { toolName: 'rm', arguments: { path: '/' }, toolUseID: 'tu_4' }, authorType: 'agent', authorID: 'a1' };

          yield { type: 'message', content: { html: '<p>Continued</p>' }, authorType: 'agent', authorID: 'a1' };
          yield { type: 'done', content: {} };
        }
      }

      let agent = new PermissionAgent(context);
      let loop  = createLoop();

      let callCount = 0;

      await loop.startInteraction(childSession.id, defaultParams(agent, {
        agentPlugin: agent,
        executeTool: (name) => {
          callCount++;
          if (callCount === 1 && name === 'rm')
            throw new PermissionRequiredError(name, { title: name });

          toolExecuted = true;
          return 'deleted';
        },
        authorType:  'agent',
        authorID:    'a1',
        userMessage: null,
      }));

      assert.ok(loop.isWaitingForPermission(childSession.id), 'child should be waiting for permission');

      // Approve via the CHILD session ID (that's where the waiting state is keyed)
      await loop.approvePermission(childSession.id);

      assert.ok(toolExecuted, 'tool should have been executed');
      assert.equal(interactionCount, 2, 'should have started a new interaction');

      // Tool-result should be in CHILD session, not parent
      let childFM     = await framePersistence.loadFrames(childSession.id);
      let childFrames = childFM.toArray();
      let toolResults = childFrames.filter((f) => f.type === 'tool-result');
      assert.ok(toolResults.length >= 1, 'child session should have tool-result frames');

      let approvalResult = toolResults.find((f) => f.content && f.content.output === 'deleted');
      assert.ok(approvalResult, 'child session should have the tool execution result');
    });
  });

  // ===========================================================================
  // 5. Denial in parent routes denial to child session
  // ===========================================================================

  describe('denial routes frames to child session', () => {
    it('should commit denial frames to the child (requesting) session', async () => {
      let parentSession = await createTestSession();
      await addUserFrame(parentSession.id);

      let childSession = await createTestSession({ parentSessionID: parentSession.id });

      let blocks = [
        { type: 'tool-call', content: { toolName: 'sudo', arguments: {}, toolUseID: 'tu_5' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(childSession.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      assert.ok(loop.isWaitingForPermission(childSession.id));

      await loop.denyPermission(childSession.id);

      // Denial frames should be in CHILD session
      let childFM     = await framePersistence.loadFrames(childSession.id);
      let childFrames = childFM.toArray();

      let denialFrames = childFrames.filter((f) => f.type === 'permission-denied');
      assert.ok(denialFrames.length >= 1, 'child session should have permission-denied frame');

      let denialResults = childFrames.filter((f) => f.type === 'tool-result' && f.content && f.content.output && f.content.output.includes('denied'));
      assert.ok(denialResults.length >= 1, 'child session should have denial tool-result frame');
    });
  });

  // ===========================================================================
  // 6. Child session retains pending-action frame locally
  // ===========================================================================

  describe('pending-action stays in child session', () => {
    it('should keep the pending-action frame in the child session', async () => {
      let parentSession = await createTestSession();
      await addUserFrame(parentSession.id);

      let childSession = await createTestSession({ parentSessionID: parentSession.id });

      let blocks = [
        { type: 'tool-call', content: { toolName: 'exec', arguments: { cmd: 'ls' }, toolUseID: 'tu_6' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(childSession.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      // Pending-action should be in CHILD session
      let childFM     = await framePersistence.loadFrames(childSession.id);
      let childFrames = childFM.toArray();
      let pendingFrames = childFrames.filter((f) => f.type === 'pending-action');
      assert.equal(pendingFrames.length, 1, 'child should have 1 pending-action frame');
      assert.equal(pendingFrames[0].content.toolName, 'exec');

      // Pending-action should NOT be in parent session
      let parentFM     = await framePersistence.loadFrames(parentSession.id);
      let parentFrames = parentFM.toArray();
      let parentPending = parentFrames.filter((f) => f.type === 'pending-action');
      assert.equal(parentPending.length, 0, 'parent should have 0 pending-action frames');
    });
  });

  // ===========================================================================
  // 7. Permission request in session WITH a user → same session (backward compat)
  // ===========================================================================

  describe('session with user — backward compatibility', () => {
    it('should keep permission-request in the same session when user is present', async () => {
      let session = await createTestSession();

      let blocks = [
        { type: 'tool-call', content: { toolName: 'sudo', arguments: {}, toolUseID: 'tu_7' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      // This interaction sends a userMessage, which creates a user-authored frame
      await loop.startInteraction(session.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
      }));

      // Permission-request should be in same session
      let fm     = await framePersistence.loadFrames(session.id);
      let frames = fm.toArray();
      let requestFrames = frames.filter((f) => f.type === 'permission-request');
      assert.equal(requestFrames.length, 1, 'session should have 1 permission-request frame');

      // Pending-action should also be in same session
      let pendingFrames = frames.filter((f) => f.type === 'pending-action');
      assert.equal(pendingFrames.length, 1, 'session should have 1 pending-action frame');

      // Should be waiting for permission
      assert.ok(loop.isWaitingForPermission(session.id));
    });
  });

  // ===========================================================================
  // 8. Edge case: parent session FrameManager not loaded
  // ===========================================================================

  describe('parent session FrameManager not loaded', () => {
    it('should load/create parent FrameManager when not already cached', async () => {
      let parentSession = await createTestSession();
      await addUserFrame(parentSession.id);

      let childSession = await createTestSession({ parentSessionID: parentSession.id });

      // Ensure parent FrameManager is NOT cached by clearing it
      sessionManager._frameManagers.delete(parentSession.id);

      let blocks = [
        { type: 'tool-call', content: { toolName: 'install', arguments: {}, toolUseID: 'tu_8' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(childSession.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      // Permission-request should still appear in parent despite uncached FrameManager
      let parentFM     = await framePersistence.loadFrames(parentSession.id);
      let parentFrames = parentFM.toArray();
      let parentRequests = parentFrames.filter((f) => f.type === 'permission-request');
      assert.equal(parentRequests.length, 1, 'parent should have 1 permission-request frame even when FrameManager was uncached');
    });
  });

  // ===========================================================================
  // 9. requestingSessionID is stored in waiting state
  // ===========================================================================

  describe('requestingSessionID stored in waiting state', () => {
    it('should store requestingSessionID in the permission-waiting entry', async () => {
      let parentSession = await createTestSession();
      await addUserFrame(parentSession.id);

      let childSession = await createTestSession({ parentSessionID: parentSession.id });

      let blocks = [
        { type: 'tool-call', content: { toolName: 'deploy', arguments: {}, toolUseID: 'tu_9' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(childSession.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      assert.ok(loop.isWaitingForPermission(childSession.id));

      // Inspect the internal permission-waiting state
      let waiting = loop._permissionHandler._findWaiting(childSession.id);
      assert.ok(waiting, 'should have a waiting entry');
      assert.equal(waiting.requestingSessionID, childSession.id, 'requestingSessionID should be the child session');
    });
  });

  // ===========================================================================
  // 10. permission:request event includes correct sessionIDs
  // ===========================================================================

  describe('permission:request event for cross-session', () => {
    it('should emit permission:request with the child sessionID', async () => {
      let parentSession = await createTestSession();
      await addUserFrame(parentSession.id);

      let childSession = await createTestSession({ parentSessionID: parentSession.id });

      let blocks = [
        { type: 'tool-call', content: { toolName: 'nuke', arguments: {}, toolUseID: 'tu_10' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent  = new MockAgent(context, blocks);
      let loop   = createLoop();
      let events = [];

      loop.on('permission:request', (event) => events.push(event));

      await loop.startInteraction(childSession.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      assert.equal(events.length, 1, 'should emit exactly 1 permission:request event');
      // The event sessionID should be the child (requesting) session
      assert.equal(events[0].sessionID, childSession.id);
    });
  });

  // ===========================================================================
  // 11. Child with parent that has user (parent IS the user session)
  // ===========================================================================

  describe('parent session IS the nearest user ancestor (self)', () => {
    it('should find user in current session and keep request local when user frames exist', async () => {
      // Session that has user frames already (from the user-message in defaultParams)
      let session = await createTestSession();
      await addUserFrame(session.id);

      let childSession = await createTestSession({ parentSessionID: session.id });
      // Child has NO user, but parent does. Create a separate child interaction without user message.
      let blocks = [
        { type: 'tool-call', content: { toolName: 'build', arguments: {}, toolUseID: 'tu_11' }, authorType: 'agent', authorID: 'a1' },
      ];
      let agent = new MockAgent(context, blocks);
      let loop  = createLoop();

      await loop.startInteraction(childSession.id, defaultParams(agent, {
        executeTool: (toolName) => { throw new PermissionRequiredError(toolName, { title: toolName }); },
        authorType:      'agent',
        authorID:        'a1',
        userMessage:     null,
      }));

      // Permission-request in parent (which is the nearest user ancestor)
      let parentFM = await framePersistence.loadFrames(session.id);
      let parentRequests = parentFM.toArray().filter((f) => f.type === 'permission-request');
      assert.equal(parentRequests.length, 1, 'parent should have the permission-request');

      // Pending-action in child
      let childFM = await framePersistence.loadFrames(childSession.id);
      let childPending = childFM.toArray().filter((f) => f.type === 'pending-action');
      assert.equal(childPending.length, 1, 'child should have the pending-action');
    });
  });
});
