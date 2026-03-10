'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }   from '../../src/core/index.mjs';
import { SessionManager }   from '../../src/core/session/index.mjs';
import { FramePersistence } from '../../src/core/frames/index.mjs';
import { InteractionLoop }  from '../../src/core/interaction/index.mjs';
import { ContentSanitizer } from '../../src/core/lib/content-sanitizer.mjs';
import { AgentInterface }   from '../../src/core/plugins/agent-interface.mjs';

// =============================================================================
// Helpers
// =============================================================================

function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

// =============================================================================
// MockAgent — yields configurable blocks, then done
// =============================================================================

class MockAgent extends AgentInterface {
  static pluginId    = 'mock-agent';
  static featureName = 'mock';
  static displayName = 'Mock Agent';
  static description = 'Mock agent for thread testing';
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
// Thread Support Tests (TDD Red Phase)
// =============================================================================
// These tests define the expected behavior for parentId-based thread support.
// They are expected to FAIL until the implementation is added.
// =============================================================================

describe('Thread Support', () => {
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
  async function createTestSession() {
    let org     = await models.Organization.create({ name: 'Thread Test Org' });
    let session = await sessionManager.createSession(org.id, { name: 'Thread Test Session' });
    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  function defaultParams(agentPlugin, overrides = {}) {
    return {
      agentPlugin,
      agent:       { name: 'test-mock', pluginID: 'mock-agent' },
      userMessage: 'Hello, thread!',
      authorType:  'user',
      authorID:    'user_thread_test',
      ...overrides,
    };
  }

  // ===========================================================================
  // Happy Path Tests
  // ===========================================================================

  // ---- Test 1 ----
  // Frame with parentId created correctly — persist and round-trip
  describe('frame with parentId persists correctly', () => {
    it('should save a frame with parentID and load it back with parentId', async () => {
      let session  = await createTestSession();
      let parentID = generateID('frm_');
      let childID  = generateID('frm_');
      let now      = Date.now();

      // Create the "parent" frame (a normal top-level message)
      await framePersistence.saveFrames(session.id, [
        {
          id:         parentID,
          type:       'user-message',
          content:    { text: 'This is the parent message' },
          order:      1,
          timestamp:  now,
          authorType: 'user',
          authorID:   'user_1',
          hidden:     false,
          deleted:    false,
          processed:  false,
        },
      ]);

      // Create a reply frame with parentId pointing to the parent
      await framePersistence.saveFrames(session.id, [
        {
          id:         childID,
          type:       'user-message',
          content:    { text: 'This is a reply' },
          parentId:   parentID,
          order:      2,
          timestamp:  now + 1,
          authorType: 'user',
          authorID:   'user_2',
          hidden:     false,
          deleted:    false,
          processed:  false,
        },
      ]);

      // Load all frames and verify the child has parentId set
      let frameManager = await framePersistence.loadFrames(session.id);
      let frames       = frameManager.toArray();
      let child        = frames.find((f) => f.id === childID);

      assert.ok(child, 'child frame should exist');
      assert.equal(child.parentId, parentID, 'child.parentId should reference the parent');
    });
  });

  // ---- Test 2 ----
  // Query by parentId returns only thread replies
  describe('query frames by parentId', () => {
    it('should return only frames matching the given parentId', async () => {
      let session  = await createTestSession();
      let parentID = generateID('frm_');
      let replyA   = generateID('frm_');
      let replyB   = generateID('frm_');
      let topLevel = generateID('frm_');
      let now      = Date.now();

      // Parent frame (top-level)
      await framePersistence.saveFrames(session.id, [
        { id: parentID, type: 'user-message', content: { text: 'Parent' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      // Two replies to the parent
      await framePersistence.saveFrames(session.id, [
        { id: replyA, type: 'message', content: { html: '<p>Reply A</p>' }, parentId: parentID, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
        { id: replyB, type: 'message', content: { html: '<p>Reply B</p>' }, parentId: parentID, order: 3, timestamp: now + 2, hidden: false, deleted: false, processed: false },
      ]);

      // Another top-level frame (no parentId)
      await framePersistence.saveFrames(session.id, [
        { id: topLevel, type: 'user-message', content: { text: 'Unrelated' }, order: 4, timestamp: now + 3, hidden: false, deleted: false, processed: false },
      ]);

      // Load with parentId filter — should return only the two replies
      let frameManager = await framePersistence.loadFrames(session.id, { parentId: parentID });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 2, 'should return exactly 2 thread replies');

      let ids = frames.map((f) => f.id);
      assert.ok(ids.includes(replyA), 'should include replyA');
      assert.ok(ids.includes(replyB), 'should include replyB');
      assert.ok(!ids.includes(parentID), 'should NOT include the parent itself');
      assert.ok(!ids.includes(topLevel), 'should NOT include unrelated top-level frames');
    });
  });

  // ---- Test 3 ----
  // Thread replies have correct session order (monotonic within thread)
  describe('thread reply ordering', () => {
    it('should return thread replies in monotonic order', async () => {
      let session  = await createTestSession();
      let parentID = generateID('frm_');
      let now      = Date.now();

      // Parent
      await framePersistence.saveFrames(session.id, [
        { id: parentID, type: 'user-message', content: { text: 'Parent' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      // Create replies out of insertion order but with ascending order values
      let reply1 = generateID('frm_');
      let reply2 = generateID('frm_');
      let reply3 = generateID('frm_');

      await framePersistence.saveFrames(session.id, [
        { id: reply3, type: 'message', content: { html: '<p>Third</p>' }, parentId: parentID, order: 10, timestamp: now + 3, hidden: false, deleted: false, processed: false },
        { id: reply1, type: 'message', content: { html: '<p>First</p>' }, parentId: parentID, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
        { id: reply2, type: 'message', content: { html: '<p>Second</p>' }, parentId: parentID, order: 5, timestamp: now + 2, hidden: false, deleted: false, processed: false },
      ]);

      // Load thread — should be sorted by order ascending
      let frameManager = await framePersistence.loadFrames(session.id, { parentId: parentID });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 3);

      for (let i = 1; i < frames.length; i++)
        assert.ok(frames[i].order > frames[i - 1].order, `frame[${i}].order (${frames[i].order}) should be > frame[${i - 1}].order (${frames[i - 1].order})`);
    });
  });

  // ---- Test 4 ----
  // InteractionLoop with parentId — user message frame gets parentId set
  describe('InteractionLoop parentId pass-through', () => {
    it('should set parentID on user-message frame when params.parentId is provided', async () => {
      let session  = await createTestSession();
      let parentID = generateID('frm_');
      let now      = Date.now();

      // Create a parent message frame first (so parentId references something real)
      await framePersistence.saveFrames(session.id, [
        { id: parentID, type: 'user-message', content: { text: 'Thread starter' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      let agent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>Thread reply from agent</p>' }, authorType: 'agent', authorID: 'agent_1' },
      ]);
      let loop = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        parentId:    parentID,
        userMessage: 'Reply in thread',
      }));

      // Reload all frames and check the user-message created by startInteraction
      let frameManager = await framePersistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      // Find the user-message frame that was created by startInteraction (order > 1)
      let userMessages = frames.filter((f) => f.type === 'user-message' && f.order > 1);
      assert.ok(userMessages.length >= 1, 'should have created a user-message frame');
      assert.equal(userMessages[0].parentId, parentID, 'user-message frame should have parentId set');

      // Agent response frames should also get parentId
      let agentMessages = frames.filter((f) => f.type === 'message');
      assert.ok(agentMessages.length >= 1, 'should have created an agent message frame');
      assert.equal(agentMessages[0].parentId, parentID, 'agent message frame should have parentId set');
    });
  });

  // ---- Test 5 ----
  // Multiple threads on different parent messages (isolation)
  describe('multiple threads isolation', () => {
    it('should keep frames from different threads isolated when querying by parentId', async () => {
      let session = await createTestSession();
      let now     = Date.now();

      let parentA = generateID('frm_');
      let parentB = generateID('frm_');

      // Create two parent frames
      await framePersistence.saveFrames(session.id, [
        { id: parentA, type: 'user-message', content: { text: 'Thread A root' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
        { id: parentB, type: 'user-message', content: { text: 'Thread B root' }, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
      ]);

      // Replies in thread A
      let replyA1 = generateID('frm_');
      let replyA2 = generateID('frm_');
      await framePersistence.saveFrames(session.id, [
        { id: replyA1, type: 'message', content: { html: '<p>A reply 1</p>' }, parentId: parentA, order: 3, timestamp: now + 2, hidden: false, deleted: false, processed: false },
        { id: replyA2, type: 'message', content: { html: '<p>A reply 2</p>' }, parentId: parentA, order: 4, timestamp: now + 3, hidden: false, deleted: false, processed: false },
      ]);

      // Replies in thread B
      let replyB1 = generateID('frm_');
      await framePersistence.saveFrames(session.id, [
        { id: replyB1, type: 'message', content: { html: '<p>B reply 1</p>' }, parentId: parentB, order: 5, timestamp: now + 4, hidden: false, deleted: false, processed: false },
      ]);

      // Query thread A — should get 2 replies
      let fmA    = await framePersistence.loadFrames(session.id, { parentId: parentA });
      let threadA = fmA.toArray();
      assert.equal(threadA.length, 2, 'thread A should have 2 replies');
      assert.ok(threadA.every((f) => f.parentId === parentA), 'all thread A replies should reference parentA');

      // Query thread B — should get 1 reply
      let fmB    = await framePersistence.loadFrames(session.id, { parentId: parentB });
      let threadB = fmB.toArray();
      assert.equal(threadB.length, 1, 'thread B should have 1 reply');
      assert.equal(threadB[0].parentId, parentB, 'thread B reply should reference parentB');

      // No cross-contamination
      let threadAIds = threadA.map((f) => f.id);
      let threadBIds = threadB.map((f) => f.id);
      assert.ok(!threadAIds.includes(replyB1), 'thread A should not contain thread B replies');
      assert.ok(!threadBIds.includes(replyA1), 'thread B should not contain thread A replies');
      assert.ok(!threadBIds.includes(replyA2), 'thread B should not contain thread A replies');
    });
  });

  // ===========================================================================
  // Failure Path Tests
  // ===========================================================================

  // ---- Test 6 ----
  // parentId referencing frame in different session — should return empty
  describe('parentId cross-session isolation', () => {
    it('should return empty when parentId belongs to a frame in a different session', async () => {
      let sessionA = await createTestSession();
      let sessionB = await createTestSession();
      let now      = Date.now();

      let parentInA = generateID('frm_');
      let replyInA  = generateID('frm_');

      // Create parent and reply in session A
      await framePersistence.saveFrames(sessionA.id, [
        { id: parentInA, type: 'user-message', content: { text: 'Session A parent' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
        { id: replyInA, type: 'message', content: { html: '<p>Reply in A</p>' }, parentId: parentInA, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
      ]);

      // Query session B with parentId from session A — should return nothing
      let frameManager = await framePersistence.loadFrames(sessionB.id, { parentId: parentInA });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 0, 'should return no frames when parentId is from a different session');
    });
  });

  // ---- Test 7 ----
  // parentId that does not exist — should return empty (no crash)
  describe('parentId referencing nonexistent frame', () => {
    it('should return empty when parentId references a frame that does not exist', async () => {
      let session     = await createTestSession();
      let fakeParent  = generateID('frm_');

      // Query with a parentId that has no matching frames
      let frameManager = await framePersistence.loadFrames(session.id, { parentId: fakeParent });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 0, 'should return empty for nonexistent parentId');
    });
  });

  // ===========================================================================
  // Edge Case Tests
  // ===========================================================================

  // ---- Test 8 ----
  // Nested threads — reply to a reply (frame whose parent is itself a reply)
  describe('nested threads (reply to a reply)', () => {
    it('should support frames whose parentId references another reply', async () => {
      let session = await createTestSession();
      let now     = Date.now();

      let rootID    = generateID('frm_');
      let replyID   = generateID('frm_');
      let nestedID  = generateID('frm_');

      // Root message
      await framePersistence.saveFrames(session.id, [
        { id: rootID, type: 'user-message', content: { text: 'Root' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      // First-level reply
      await framePersistence.saveFrames(session.id, [
        { id: replyID, type: 'message', content: { html: '<p>Reply to root</p>' }, parentId: rootID, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
      ]);

      // Nested reply (reply to the reply)
      await framePersistence.saveFrames(session.id, [
        { id: nestedID, type: 'message', content: { html: '<p>Reply to reply</p>' }, parentId: replyID, order: 3, timestamp: now + 2, hidden: false, deleted: false, processed: false },
      ]);

      // Query for replies to the root — should only get the first-level reply
      let fmRoot    = await framePersistence.loadFrames(session.id, { parentId: rootID });
      let rootReplies = fmRoot.toArray();
      assert.equal(rootReplies.length, 1, 'root thread should have 1 direct reply');
      assert.equal(rootReplies[0].id, replyID);

      // Query for replies to the first-level reply — should get the nested reply
      let fmReply      = await framePersistence.loadFrames(session.id, { parentId: replyID });
      let nestedReplies = fmReply.toArray();
      assert.equal(nestedReplies.length, 1, 'reply thread should have 1 nested reply');
      assert.equal(nestedReplies[0].id, nestedID);
      assert.equal(nestedReplies[0].parentId, replyID, 'nested reply should reference the first-level reply as parent');
    });
  });

  // ---- Test 9 ----
  // Thread on hidden frame — parentId points to a hidden frame, replies still work
  describe('thread on hidden frame', () => {
    it('should return replies even when the parent frame is hidden', async () => {
      let session = await createTestSession();
      let now     = Date.now();

      let hiddenParent = generateID('frm_');
      let replyID      = generateID('frm_');

      // Hidden parent frame
      await framePersistence.saveFrames(session.id, [
        { id: hiddenParent, type: 'reflection', content: { text: 'Hidden thinking' }, order: 1, timestamp: now, hidden: true, deleted: false, processed: false },
      ]);

      // Reply to the hidden frame
      await framePersistence.saveFrames(session.id, [
        { id: replyID, type: 'message', content: { html: '<p>Replying to hidden</p>' }, parentId: hiddenParent, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
      ]);

      // Query for thread replies — should still return the reply
      let frameManager = await framePersistence.loadFrames(session.id, { parentId: hiddenParent });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 1, 'should return reply even when parent is hidden');
      assert.equal(frames[0].id, replyID);
      assert.equal(frames[0].parentId, hiddenParent);
    });
  });

  // ---- Test 10 ----
  // Thread on a session-link type frame — parentId on a special frame type
  describe('thread on session-link frame', () => {
    it('should support thread replies to a session-link frame', async () => {
      let session = await createTestSession();
      let now     = Date.now();

      let linkFrameID = generateID('frm_');
      let replyID     = generateID('frm_');

      // Session-link frame (a special non-standard type)
      await framePersistence.saveFrames(session.id, [
        { id: linkFrameID, type: 'session-link', content: { sessionID: 'ses_other', name: 'Linked session' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      // Reply to the session-link frame
      await framePersistence.saveFrames(session.id, [
        { id: replyID, type: 'user-message', content: { text: 'Comment on the link' }, parentId: linkFrameID, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
      ]);

      // Query thread — should return the reply
      let frameManager = await framePersistence.loadFrames(session.id, { parentId: linkFrameID });
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 1, 'should return reply to session-link frame');
      assert.equal(frames[0].id, replyID);
      assert.equal(frames[0].parentId, linkFrameID);
    });
  });

  // ---- Test 11 ----
  // Loading all frames (no parentId filter) still returns everything
  describe('no parentId filter returns all frames', () => {
    it('should return all frames including threaded and non-threaded when no parentId filter', async () => {
      let session = await createTestSession();
      let now     = Date.now();

      let parentID = generateID('frm_');
      let replyID  = generateID('frm_');
      let topLevel = generateID('frm_');

      await framePersistence.saveFrames(session.id, [
        { id: parentID, type: 'user-message', content: { text: 'Parent' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
        { id: replyID, type: 'message', content: { html: '<p>Reply</p>' }, parentId: parentID, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
        { id: topLevel, type: 'user-message', content: { text: 'Top level' }, order: 3, timestamp: now + 2, hidden: false, deleted: false, processed: false },
      ]);

      // Load without parentId filter — all 3 should come back
      let frameManager = await framePersistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      assert.equal(frames.length, 3, 'should return all frames when no parentId filter');

      let ids = frames.map((f) => f.id);
      assert.ok(ids.includes(parentID));
      assert.ok(ids.includes(replyID));
      assert.ok(ids.includes(topLevel));
    });
  });

  // ---- Test 12 ----
  // InteractionLoop parentId — agent response frames also inherit parentId
  describe('InteractionLoop agent responses inherit parentId', () => {
    it('should set parentID on agent message frames when interaction has parentId', async () => {
      let session  = await createTestSession();
      let parentID = generateID('frm_');
      let now      = Date.now();

      // Create parent message
      await framePersistence.saveFrames(session.id, [
        { id: parentID, type: 'user-message', content: { text: 'Original message' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      // Agent that replies with a message and a tool call
      let agent = new MockAgent(context, [
        { type: 'message', content: { html: '<p>Agent reply</p>' }, authorType: 'agent', authorID: 'agent_1' },
      ]);
      let loop = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        parentId:    parentID,
        userMessage: 'Thread reply from user',
      }));

      let frameManager = await framePersistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      // All frames created during this interaction (order > 1) should have parentId
      let interactionFrames = frames.filter((f) => f.order > 1);
      assert.ok(interactionFrames.length >= 2, 'should have at least user-message + agent message');

      for (let frame of interactionFrames)
        assert.equal(frame.parentId, parentID, `frame ${frame.id} (type: ${frame.type}) should have parentId set`);
    });
  });

  // ---- Test 13 ----
  // InteractionLoop tool-call and tool-result frames get parentId
  describe('InteractionLoop tool frames inherit parentId', () => {
    it('should set parentID on tool-call and tool-result frames in a thread', async () => {
      let session  = await createTestSession();
      let parentID = generateID('frm_');
      let now      = Date.now();

      // Create parent message
      await framePersistence.saveFrames(session.id, [
        { id: parentID, type: 'user-message', content: { text: 'Original' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      let agent = new MockAgent(context, [
        { type: 'tool-call', content: { toolName: 'echo', arguments: { text: 'hi' }, toolUseId: 'toolu_test' }, authorType: 'agent', authorID: 'agent_1' },
        { type: 'message', content: { html: '<p>Done</p>' }, authorType: 'agent', authorID: 'agent_1' },
      ]);
      let loop = createLoop();

      await loop.startInteraction(session.id, defaultParams(agent, {
        parentId:        parentID,
        userMessage:     'Thread with tool use',
        checkPermission: () => false,
        executeTool:     () => 'tool output',
      }));

      let frameManager = await framePersistence.loadFrames(session.id);
      let frames       = frameManager.toArray();

      let toolCallFrames  = frames.filter((f) => f.type === 'tool-call');
      let toolResultFrames = frames.filter((f) => f.type === 'tool-result');

      assert.ok(toolCallFrames.length >= 1, 'should have tool-call frame');
      assert.equal(toolCallFrames[0].parentId, parentID, 'tool-call frame should have parentId');

      assert.ok(toolResultFrames.length >= 1, 'should have tool-result frame');
      assert.equal(toolResultFrames[0].parentId, parentID, 'tool-result frame should have parentId');
    });
  });

  // ---- Test 14 ----
  // parentId filter combined with other query options (afterOrder)
  describe('parentId filter combined with afterOrder', () => {
    it('should support parentId + afterOrder together', async () => {
      let session  = await createTestSession();
      let parentID = generateID('frm_');
      let now      = Date.now();

      // Parent
      await framePersistence.saveFrames(session.id, [
        { id: parentID, type: 'user-message', content: { text: 'Parent' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      // Three replies with different orders
      let reply1 = generateID('frm_');
      let reply2 = generateID('frm_');
      let reply3 = generateID('frm_');

      await framePersistence.saveFrames(session.id, [
        { id: reply1, type: 'message', content: { html: '<p>R1</p>' }, parentId: parentID, order: 2, timestamp: now + 1, hidden: false, deleted: false, processed: false },
        { id: reply2, type: 'message', content: { html: '<p>R2</p>' }, parentId: parentID, order: 5, timestamp: now + 2, hidden: false, deleted: false, processed: false },
        { id: reply3, type: 'message', content: { html: '<p>R3</p>' }, parentId: parentID, order: 8, timestamp: now + 3, hidden: false, deleted: false, processed: false },
      ]);

      // Load with parentId + afterOrder=4 — should return only reply2 and reply3
      let frameManager = await framePersistence.loadFrames(session.id, {
        parentId:   parentID,
        afterOrder: 4,
      });
      let frames = frameManager.toArray();

      assert.equal(frames.length, 2, 'should return only replies after order 4');
      assert.equal(frames[0].id, reply2);
      assert.equal(frames[1].id, reply3);
    });
  });

  // ---- Test 15 ----
  // parentId filter combined with limit
  describe('parentId filter combined with limit', () => {
    it('should support parentId + limit together', async () => {
      let session  = await createTestSession();
      let parentID = generateID('frm_');
      let now      = Date.now();

      // Parent
      await framePersistence.saveFrames(session.id, [
        { id: parentID, type: 'user-message', content: { text: 'Parent' }, order: 1, timestamp: now, hidden: false, deleted: false, processed: false },
      ]);

      // Five replies
      let replyIds = [];
      for (let i = 0; i < 5; i++) {
        let id = generateID('frm_');
        replyIds.push(id);
        await framePersistence.saveFrames(session.id, [
          { id, type: 'message', content: { html: `<p>Reply ${i}</p>` }, parentId: parentID, order: 2 + i, timestamp: now + 1 + i, hidden: false, deleted: false, processed: false },
        ]);
      }

      // Load with parentId + limit=3 — should return only the first 3 replies
      let frameManager = await framePersistence.loadFrames(session.id, {
        parentId: parentID,
        limit:    3,
      });
      let frames = frameManager.toArray();

      assert.equal(frames.length, 3, 'should respect limit within parentId filter');
    });
  });
});
