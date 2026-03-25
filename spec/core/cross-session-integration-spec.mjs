'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import XID from 'xid-js';

import { createKikxCore }  from '../../src/core/index.mjs';
import { SessionManager }  from '../../src/core/session/index.mjs';
import { FrameManager }    from '../../src/shared/frame-manager/frame-manager.mjs';
import { FramePersistence } from '../../src/core/frames/index.mjs';

// =============================================================================
// Cross-Session Integration Tests
// =============================================================================
// TDD red-phase tests for cross-session posting flow.
// Since the cross-session plugin does not exist yet, these tests work at the
// SessionManager + FrameManager + FramePersistence level to verify the
// infrastructure supports cross-session operations.
//
// Tests verify:
//   1. Agent posts from session A to session B - frames appear correctly
//   2. Round-trip: tool-call in A -> message in B -> tool-result back in A
//   3. Session isolation - loading frames from one session excludes another
//
// All tests are expected to FAIL until the cross-session implementation lands.
// =============================================================================

describe('Cross-Session Integration', () => {
  let core;
  let models;
  let manager;
  let persistence;
  let org;

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
    org     = await models.Organization.create({ name: 'Cross-Session Integration Org' });
  });

  // ===========================================================================
  // Helper: create an agent with test- prefix
  // ===========================================================================
  async function createTestAgent(name) {
    return models.Agent.create({
      organizationID: org.id,
      name:           name,
      pluginID:       'claude-agent',
    });
  }

  // ---- Test 1 ----
  // Agent posts from session A to session B -- frames appear in correct sessions
  it('agent posts from session A to session B — frames appear in correct sessions', async () => {
    let agent    = await createTestAgent('test-cross-poster');
    let sessionA = await manager.createSession(org.id, { name: 'Session A' });
    let sessionB = await manager.createSession(org.id, { name: 'Session B' });

    // Add agent as participant in both sessions
    await manager.addParticipant(sessionA.id, agent.id);
    await manager.addParticipant(sessionB.id, agent.id);

    let now = Date.now();

    // Create a "tool-call" frame in session A (describing the cross-post intent)
    let toolCallID = 'frm_' + XID.next();
    await persistence.saveFrames(sessionA.id, [
      {
        id:         toolCallID,
        type:       'ToolCall',
        content:    {
          name:            'cross_session_post',
          targetSessionID: sessionB.id,
          message:         'Hello from session A!',
        },
        authorType: 'agent',
        authorID:   agent.id,
        order:      1,
        timestamp:  now,
      },
    ]);

    // Create a "message" frame in session B (authored by the agent)
    let messageID = 'frm_' + XID.next();
    await persistence.saveFrames(sessionB.id, [
      {
        id:         messageID,
        type: 'Message',
        content:    { text: 'Hello from session A!' },
        authorType: 'agent',
        authorID:   agent.id,
        order:      1,
        timestamp:  now + 1,
      },
    ]);

    // Load frames from each session
    let framesA = (await persistence.loadFrames(sessionA.id)).toArray();
    let framesB = (await persistence.loadFrames(sessionB.id)).toArray();

    // Verify session A has the tool-call frame
    let toolCallFrames = framesA.filter((frame) => frame.type === 'ToolCall');
    assert.equal(toolCallFrames.length, 1, 'Session A should have exactly one tool-call frame');
    assert.equal(toolCallFrames[0].id, toolCallID);
    assert.equal(toolCallFrames[0].authorType, 'agent');
    assert.equal(toolCallFrames[0].authorID, agent.id);

    // Verify session B has the message frame
    let messageFrames = framesB.filter((frame) => frame.type === 'Message');
    assert.equal(messageFrames.length, 1, 'Session B should have exactly one message frame');
    assert.equal(messageFrames[0].id, messageID);
    assert.equal(messageFrames[0].authorType, 'agent');
    assert.equal(messageFrames[0].authorID, agent.id);
    assert.equal(messageFrames[0].content.text, 'Hello from session A!');
  });

  // ---- Test 2 ----
  // Tool-call in A, message in B, tool-result back to A -- round-trip
  it('round-trip: tool-call in A -> message in B -> tool-result in A', async () => {
    let agent    = await createTestAgent('test-round-trip');
    let sessionA = await manager.createSession(org.id, { name: 'Session A (round-trip)' });
    let sessionB = await manager.createSession(org.id, { name: 'Session B (round-trip)' });

    await manager.addParticipant(sessionA.id, agent.id);
    await manager.addParticipant(sessionB.id, agent.id);

    let now = Date.now();

    // Step 1: Tool-call frame in session A
    let toolCallID = 'frm_' + XID.next();
    await persistence.saveFrames(sessionA.id, [
      {
        id:         toolCallID,
        type:       'ToolCall',
        content:    {
          name:            'cross_session_post',
          targetSessionID: sessionB.id,
          message:         'Question for session B',
        },
        authorType: 'agent',
        authorID:   agent.id,
        order:      1,
        timestamp:  now,
      },
    ]);

    // Step 2: Message frame in session B
    let messageID = 'frm_' + XID.next();
    await persistence.saveFrames(sessionB.id, [
      {
        id:         messageID,
        type: 'Message',
        content:    { text: 'Question for session B' },
        authorType: 'agent',
        authorID:   agent.id,
        order:      1,
        timestamp:  now + 1,
      },
    ]);

    // Step 3: Tool-result frame back in session A
    let toolResultID = 'frm_' + XID.next();
    await persistence.saveFrames(sessionA.id, [
      {
        id:         toolResultID,
        type:       'ToolResult',
        content:    {
          name:     'cross_session_post',
          result:   { status: 'delivered', targetSessionID: sessionB.id },
        },
        parentID:   toolCallID,
        authorType: 'agent',
        authorID:   agent.id,
        order:      2,
        timestamp:  now + 2,
      },
    ]);

    // Verify ordering in session A: tool-call comes before tool-result
    let framesA = (await persistence.loadFrames(sessionA.id)).toArray();
    assert.equal(framesA.length, 2, 'Session A should have exactly 2 frames');

    let toolCallFrame  = framesA.find((frame) => frame.type === 'ToolCall');
    let toolResultFrame = framesA.find((frame) => frame.type === 'ToolResult');
    assert.ok(toolCallFrame, 'tool-call frame should exist in session A');
    assert.ok(toolResultFrame, 'tool-result frame should exist in session A');
    assert.ok(
      toolCallFrame.order < toolResultFrame.order,
      `tool-call order (${toolCallFrame.order}) should precede tool-result order (${toolResultFrame.order})`,
    );

    // Verify session B has only the message frame
    let framesB = (await persistence.loadFrames(sessionB.id)).toArray();
    assert.equal(framesB.length, 1, 'Session B should have exactly 1 frame');
    assert.equal(framesB[0].type, 'Message');
    assert.equal(framesB[0].id, messageID);
  });

  // ---- Test 3 ----
  // Cross-session respects session isolation
  it('session isolation — loading frames from A excludes frames from B and vice versa', async () => {
    let sessionA = await manager.createSession(org.id, { name: 'Isolated A' });
    let sessionB = await manager.createSession(org.id, { name: 'Isolated B' });

    let now = Date.now();

    // Create distinct frames in each session
    let frameA1 = 'frm_' + XID.next();
    let frameA2 = 'frm_' + XID.next();
    let frameB1 = 'frm_' + XID.next();
    let frameB2 = 'frm_' + XID.next();
    let frameB3 = 'frm_' + XID.next();

    await persistence.saveFrames(sessionA.id, [
      { id: frameA1, type: 'Message', content: { text: 'A-one' }, order: 1, timestamp: now },
      { id: frameA2, type: 'Message', content: { text: 'A-two' }, order: 2, timestamp: now + 1 },
    ]);

    await persistence.saveFrames(sessionB.id, [
      { id: frameB1, type: 'Message', content: { text: 'B-one' },   order: 1, timestamp: now },
      { id: frameB2, type: 'Message', content: { text: 'B-two' },   order: 2, timestamp: now + 1 },
      { id: frameB3, type: 'Message', content: { text: 'B-three' }, order: 3, timestamp: now + 2 },
    ]);

    // Load frames for session A -- should NOT include session B's frames
    let framesA    = (await persistence.loadFrames(sessionA.id)).toArray();
    let frameAIDs  = framesA.map((frame) => frame.id);

    assert.equal(framesA.length, 2, 'Session A should have exactly 2 frames');
    assert.ok(frameAIDs.includes(frameA1));
    assert.ok(frameAIDs.includes(frameA2));
    assert.ok(!frameAIDs.includes(frameB1), 'Session A must not contain frames from session B');
    assert.ok(!frameAIDs.includes(frameB2), 'Session A must not contain frames from session B');
    assert.ok(!frameAIDs.includes(frameB3), 'Session A must not contain frames from session B');

    // Load frames for session B -- should NOT include session A's frames
    let framesB    = (await persistence.loadFrames(sessionB.id)).toArray();
    let frameBIDs  = framesB.map((frame) => frame.id);

    assert.equal(framesB.length, 3, 'Session B should have exactly 3 frames');
    assert.ok(frameBIDs.includes(frameB1));
    assert.ok(frameBIDs.includes(frameB2));
    assert.ok(frameBIDs.includes(frameB3));
    assert.ok(!frameBIDs.includes(frameA1), 'Session B must not contain frames from session A');
    assert.ok(!frameBIDs.includes(frameA2), 'Session B must not contain frames from session A');
  });
});
