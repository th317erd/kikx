'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }  from '../../src/core/index.mjs';
import { SessionManager }  from '../../src/core/session/index.mjs';
import { FrameManager }    from '../../src/shared/frame-manager/frame-manager.mjs';
import { FramePersistence } from '../../src/core/frames/index.mjs';

// =============================================================================
// Thread Integration Tests
// =============================================================================
// TDD red-phase tests for thread flow using parentID on frames.
// Threads are formed by setting parentId on reply frames, pointing back to
// the original message they respond to. FrameManager tracks these via its
// internal _children map and exposes them via getChildren(parentId).
//
// Tests verify:
//   1. User message -> reply with parentId -> chain is correct
//   2. Multiple replies to the same parent
//   3. Thread isolation — different threads don't interfere
//   4. Nested threads — reply to a reply
//
// All tests are expected to FAIL until the thread implementation is complete.
// =============================================================================

describe('Thread Integration', () => {
  let core;
  let models;
  let manager;
  let persistence;
  let org;
  let session;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models      = core.getModels();
    persistence = new FramePersistence(core.getContext());
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    manager = new SessionManager(core.getContext());
    org     = await models.Organization.create({ name: 'Thread Integration Org' });
    session = await manager.createSession(org.id, { name: 'Thread Test Session' });
  });

  // ===========================================================================
  // Helper: generate a frame ID
  // ===========================================================================
  function generateFrameID() {
    return 'frm_' + XID.next();
  }

  // ---- Test 1 ----
  // User message -> user reply (parentId) -> verify parentId chain
  it('reply frame has correct parentId linking to the main message', async () => {
    let frameManager = manager.getFrameManager(session.id);

    // Create a main message frame (no parent)
    let mainID = generateFrameID();
    frameManager.merge([
      {
        id:         mainID,
        type:       'message',
        content:    { text: 'This is the main message' },
        parentId:   null,
        authorType: 'user',
        authorID:   'usr_thread_test',
        hidden:     false,
      },
    ]);

    // Create a reply frame with parentId pointing to the main message
    let replyID = generateFrameID();
    frameManager.merge([
      {
        id:         replyID,
        type:       'message',
        content:    { text: 'This is a reply' },
        parentId:   mainID,
        authorType: 'user',
        authorID:   'usr_thread_test',
        hidden:     false,
      },
    ]);

    // Verify the reply's parentId is set correctly
    let replyFrame = frameManager.get(replyID);
    assert.ok(replyFrame, 'Reply frame should exist');
    assert.equal(replyFrame.parentId, mainID, 'Reply parentId should point to main message');

    // Load all frames, verify both exist
    let allFrames = frameManager.toArray();
    assert.equal(allFrames.length, 2, 'Should have exactly 2 frames');

    let allIDs = allFrames.map((frame) => frame.id);
    assert.ok(allIDs.includes(mainID));
    assert.ok(allIDs.includes(replyID));

    // Filter by parentId of main message — verify only the reply is returned
    let children = frameManager.getChildren(mainID);
    assert.equal(children.length, 1, 'Main message should have exactly 1 child');
    assert.equal(children[0].id, replyID);
  });

  // ---- Test 2 ----
  // Multiple replies to same parent
  it('multiple replies to the same parent are all returned by getChildren', async () => {
    let frameManager = manager.getFrameManager(session.id);

    // Create main frame
    let mainID = generateFrameID();
    frameManager.merge([
      {
        id:         mainID,
        type:       'message',
        content:    { text: 'Root message' },
        parentId:   null,
        authorType: 'user',
        authorID:   'usr_multi_reply',
        hidden:     false,
      },
    ]);

    // Create 3 reply frames with parentId = main frame's id
    let replyIDs = [];
    for (let index = 0; index < 3; index++) {
      let replyID = generateFrameID();
      replyIDs.push(replyID);

      frameManager.merge([
        {
          id:         replyID,
          type:       'message',
          content:    { text: `Reply #${index + 1}` },
          parentId:   mainID,
          authorType: 'user',
          authorID:   'usr_multi_reply',
          hidden:     false,
        },
      ]);
    }

    // Load with parentId filter, verify all 3 returned
    let children = frameManager.getChildren(mainID);
    assert.equal(children.length, 3, 'Should have exactly 3 children');

    let childIDs = children.map((frame) => frame.id);
    for (let replyID of replyIDs) {
      assert.ok(childIDs.includes(replyID), `Child list should include ${replyID}`);
    }

    // Verify ordering is monotonic (each order > previous)
    for (let index = 1; index < children.length; index++) {
      assert.ok(
        children[index - 1].order < children[index].order,
        `Child order at index ${index - 1} (${children[index - 1].order}) should be less than at index ${index} (${children[index].order})`,
      );
    }
  });

  // ---- Test 3 ----
  // Thread isolation — different threads don't interfere
  it('different threads are isolated — children of A exclude children of B', async () => {
    let frameManager = manager.getFrameManager(session.id);

    // Create two main frames (thread roots)
    let mainA = generateFrameID();
    let mainB = generateFrameID();

    frameManager.merge([
      {
        id:         mainA,
        type:       'message',
        content:    { text: 'Thread A root' },
        parentId:   null,
        authorType: 'user',
        authorID:   'usr_isolation',
        hidden:     false,
      },
    ]);

    frameManager.merge([
      {
        id:         mainB,
        type:       'message',
        content:    { text: 'Thread B root' },
        parentId:   null,
        authorType: 'user',
        authorID:   'usr_isolation',
        hidden:     false,
      },
    ]);

    // Create replies to thread A
    let replyA1 = generateFrameID();
    let replyA2 = generateFrameID();
    frameManager.merge([
      {
        id:         replyA1,
        type:       'message',
        content:    { text: 'Reply A1' },
        parentId:   mainA,
        authorType: 'user',
        authorID:   'usr_isolation',
        hidden:     false,
      },
    ]);
    frameManager.merge([
      {
        id:         replyA2,
        type:       'message',
        content:    { text: 'Reply A2' },
        parentId:   mainA,
        authorType: 'user',
        authorID:   'usr_isolation',
        hidden:     false,
      },
    ]);

    // Create replies to thread B
    let replyB1 = generateFrameID();
    frameManager.merge([
      {
        id:         replyB1,
        type:       'message',
        content:    { text: 'Reply B1' },
        parentId:   mainB,
        authorType: 'user',
        authorID:   'usr_isolation',
        hidden:     false,
      },
    ]);

    // Filter by A's id -> only A's replies
    let childrenA    = frameManager.getChildren(mainA);
    let childrenAIDs = childrenA.map((frame) => frame.id);
    assert.equal(childrenA.length, 2, 'Thread A should have 2 replies');
    assert.ok(childrenAIDs.includes(replyA1));
    assert.ok(childrenAIDs.includes(replyA2));
    assert.ok(!childrenAIDs.includes(replyB1), 'Thread A children must not include thread B replies');

    // Filter by B's id -> only B's replies
    let childrenB    = frameManager.getChildren(mainB);
    let childrenBIDs = childrenB.map((frame) => frame.id);
    assert.equal(childrenB.length, 1, 'Thread B should have 1 reply');
    assert.ok(childrenBIDs.includes(replyB1));
    assert.ok(!childrenBIDs.includes(replyA1), 'Thread B children must not include thread A replies');
    assert.ok(!childrenBIDs.includes(replyA2), 'Thread B children must not include thread A replies');
  });

  // ---- Test 4 ----
  // Nested thread — reply to a reply
  it('nested thread: reply to a reply forms a correct chain', async () => {
    let frameManager = manager.getFrameManager(session.id);

    // Create: main -> reply1 -> reply2 (reply to reply1)
    let mainID   = generateFrameID();
    let reply1ID = generateFrameID();
    let reply2ID = generateFrameID();

    frameManager.merge([
      {
        id:         mainID,
        type:       'message',
        content:    { text: 'Main message' },
        parentId:   null,
        authorType: 'user',
        authorID:   'usr_nested',
        hidden:     false,
      },
    ]);

    frameManager.merge([
      {
        id:         reply1ID,
        type:       'message',
        content:    { text: 'First reply (to main)' },
        parentId:   mainID,
        authorType: 'user',
        authorID:   'usr_nested',
        hidden:     false,
      },
    ]);

    frameManager.merge([
      {
        id:         reply2ID,
        type:       'message',
        content:    { text: 'Second reply (to reply1)' },
        parentId:   reply1ID,
        authorType: 'user',
        authorID:   'usr_nested',
        hidden:     false,
      },
    ]);

    // Filter by main's id -> only reply1
    let mainChildren = frameManager.getChildren(mainID);
    assert.equal(mainChildren.length, 1, 'Main should have exactly 1 direct child');
    assert.equal(mainChildren[0].id, reply1ID);

    // Filter by reply1's id -> only reply2
    let reply1Children = frameManager.getChildren(reply1ID);
    assert.equal(reply1Children.length, 1, 'Reply1 should have exactly 1 direct child');
    assert.equal(reply1Children[0].id, reply2ID);

    // All frames visible when no filter (toArray)
    let allFrames = frameManager.toArray();
    assert.equal(allFrames.length, 3, 'Should have 3 total frames');

    let allIDs = allFrames.map((frame) => frame.id);
    assert.ok(allIDs.includes(mainID));
    assert.ok(allIDs.includes(reply1ID));
    assert.ok(allIDs.includes(reply2ID));

    // Verify the chain: reply2.parentId -> reply1, reply1.parentId -> main
    let reply2Frame = frameManager.get(reply2ID);
    assert.equal(reply2Frame.parentId, reply1ID);

    let reply1Frame = frameManager.get(reply1ID);
    assert.equal(reply1Frame.parentId, mainID);

    let mainFrame = frameManager.get(mainID);
    assert.equal(mainFrame.parentId, null);
  });
});
