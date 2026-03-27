'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../src/core/index.mjs';
import { SessionManager }  from '../../src/core/session/index.mjs';
import { FrameManager }    from '../../src/shared/frame-manager/frame-manager.mjs';
import { FramePersistence } from '../../src/core/frames/index.mjs';
import { Participant }      from '../../src/core/models/participant-model.mjs';

// =============================================================================
// Participant Lifecycle Tests
// =============================================================================
// TDD tests for participant-joined / participant-left frame generation.
// addParticipant now creates a Message frame (authorType: 'system') so agents
// can see the join notification in their context.
// =============================================================================

// Helper: find join notification frames (Message type with system author and join text)
function isJoinFrame(frame) {
  if (frame.type !== 'Message' || frame.authorType !== 'system')
    return false;

  let html = (frame.content && frame.content.html) || '';
  return html.includes('has joined the session');
}

describe('Participant Lifecycle Frames', () => {
  let core;
  let models;
  let manager;
  let persistence;
  let organization;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models      = core.getModels();
    persistence = new FramePersistence(core.getContext());
    core.getContext().setProperty('framePersistence', persistence);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    manager      = new SessionManager(core.getContext());
    organization = await models.Organization.create({ name: 'Lifecycle Test Org' });
  });

  // ===========================================================================
  // Helper: create an agent and session for a test
  // ===========================================================================
  async function createAgentAndSession(agentName) {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           agentName,
      pluginID:       'claude-agent',
    });

    let session = await manager.createSession(organization.id);
    return { agent, session };
  }

  // ===========================================================================
  // Happy Paths
  // ===========================================================================

  // ---- Test 1 ----
  it('addParticipant creates Participant record with correct sessionID and agentID', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-1');

    let participant = await manager.addParticipant(session.id, agent.id);
    assert.ok(participant);
    assert.ok(participant.id.startsWith('prt_'));
    assert.equal(participant.sessionID, session.id);
    assert.equal(participant.agentID, agent.id);
  });

  // ---- Test 2 ----
  it('addParticipant creates a system Message frame in session FrameManager', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-2');

    await manager.addParticipant(session.id, agent.id);

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrames = frames.filter(isJoinFrame);

    assert.equal(joinedFrames.length, 1, 'Expected exactly one join notification frame');
  });

  // ---- Test 3 ----
  it('join notification frame has correct schema', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-3');

    await manager.addParticipant(session.id, agent.id);

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrame  = frames.find(isJoinFrame);

    assert.ok(joinedFrame, 'join notification frame should exist');
    assert.equal(joinedFrame.type, 'Message');
    assert.equal(joinedFrame.hidden, false);
    assert.equal(joinedFrame.authorType, 'system');
    assert.equal(joinedFrame.authorID, null);
    assert.ok(joinedFrame.content, 'Frame content should exist');
    assert.ok(joinedFrame.content.html.includes('test-lifecycle-3'), 'Frame should contain agent name');
    assert.ok(joinedFrame.content.html.includes('has joined the session'), 'Frame should contain join text');
  });

  // ---- Test 4 ----
  it('join notification frame is persisted via FramePersistence', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-4');

    await manager.addParticipant(session.id, agent.id);

    // Load frames from the database using a fresh FrameManager
    let loadedFrameManager = await persistence.loadFrames(session.id);
    let loadedFrames       = loadedFrameManager.toArray();
    let joinedFrames       = loadedFrames.filter(isJoinFrame);

    assert.equal(joinedFrames.length, 1, 'Persisted join notification frame should be loadable');
    assert.ok(joinedFrames[0].content.html.includes('test-lifecycle-4'));
  });

  // ---- Test 5 ----
  it('join notification frame has correct monotonic order within session', async () => {
    let agentOne = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-lifecycle-5a',
      pluginID:       'claude-agent',
    });

    let agentTwo = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-lifecycle-5b',
      pluginID:       'claude-agent',
    });

    let session = await manager.createSession(organization.id);

    await manager.addParticipant(session.id, agentOne.id);
    await manager.addParticipant(session.id, agentTwo.id);

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrames = frames.filter(isJoinFrame);

    assert.equal(joinedFrames.length, 2, 'Expected two join notification frames');
    assert.ok(
      joinedFrames[0].order < joinedFrames[1].order,
      `First frame order (${joinedFrames[0].order}) should be less than second (${joinedFrames[1].order})`,
    );
  });

  // ---- Test 6 ----
  it('removeParticipant deletes Participant record', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-6');

    await manager.addParticipant(session.id, agent.id);

    let participantsBefore = await manager.getParticipants(session.id);
    assert.equal(participantsBefore.length, 1);

    await manager.removeParticipant(session.id, agent.id);

    let participantsAfter = await manager.getParticipants(session.id);
    assert.equal(participantsAfter.length, 0);
  });

  // ---- Test 7 ----
  it('removeParticipant creates participant-left frame with correct schema', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-7');

    await manager.addParticipant(session.id, agent.id);
    await manager.removeParticipant(session.id, agent.id);

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let leftFrame    = frames.find((frame) => frame.type === 'ParticipantLeft');

    assert.ok(leftFrame, 'participant-left frame should exist');
    assert.equal(leftFrame.type, 'ParticipantLeft');
    assert.equal(leftFrame.hidden, false);
    assert.equal(leftFrame.authorType, 'system');
    assert.equal(leftFrame.authorID, null);
    assert.ok(leftFrame.content, 'Frame content should exist');
    assert.equal(leftFrame.content.agentID, agent.id);
    assert.equal(leftFrame.content.agentName, 'test-lifecycle-7');
    assert.ok(leftFrame.content.reason !== undefined, 'participant-left frame should include a reason field');
  });

  // ---- Test 8 ----
  it('re-adding a previously removed participant creates new record and new frame', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-8');

    // First add + remove cycle
    await manager.addParticipant(session.id, agent.id);
    await manager.removeParticipant(session.id, agent.id);

    // Re-add
    let participant = await manager.addParticipant(session.id, agent.id);
    assert.ok(participant);
    assert.equal(participant.sessionID, session.id);
    assert.equal(participant.agentID, agent.id);

    let participants = await manager.getParticipants(session.id);
    assert.equal(participants.length, 1, 'Should have exactly one active participant after re-add');

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrames = frames.filter(isJoinFrame);

    assert.equal(joinedFrames.length, 2, 'Should have two join notification frames (original + re-add)');
  });

  // ---- Test 9 ----
  it('multiple add/remove cycles produce chronologically ordered frames', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-9');

    // Cycle 1: add then remove
    await manager.addParticipant(session.id, agent.id);
    await manager.removeParticipant(session.id, agent.id);

    // Cycle 2: add then remove
    await manager.addParticipant(session.id, agent.id);
    await manager.removeParticipant(session.id, agent.id);

    let frameManager    = manager.getFrameManager(session.id);
    let frames          = frameManager.toArray();
    let lifecycleFrames = frames.filter(
      (frame) => isJoinFrame(frame) || frame.type === 'ParticipantLeft',
    );

    assert.equal(lifecycleFrames.length, 4, 'Expected 4 lifecycle frames (2 joined + 2 left)');

    // Verify chronological ordering by order field
    for (let index = 1; index < lifecycleFrames.length; index++) {
      assert.ok(
        lifecycleFrames[index - 1].order < lifecycleFrames[index].order,
        `Frame at index ${index - 1} (order ${lifecycleFrames[index - 1].order}) should precede frame at index ${index} (order ${lifecycleFrames[index].order})`,
      );
    }

    // Verify the sequence: joined (Message), left, joined (Message), left
    assert.ok(isJoinFrame(lifecycleFrames[0]));
    assert.equal(lifecycleFrames[1].type, 'ParticipantLeft');
    assert.ok(isJoinFrame(lifecycleFrames[2]));
    assert.equal(lifecycleFrames[3].type, 'ParticipantLeft');
  });

  // ===========================================================================
  // Failure Paths
  // ===========================================================================

  // ---- Test 10 ----
  it('addParticipant with non-existent sessionID should error', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-lifecycle-10',
      pluginID:       'claude-agent',
    });

    await assert.rejects(
      () => manager.addParticipant('ses_nonexistent', agent.id),
      { message: /Session not found/ },
    );
  });

  // ---- Test 11 ----
  it('addParticipant with non-existent agentID should error', async () => {
    let session = await manager.createSession(organization.id);

    await assert.rejects(
      () => manager.addParticipant(session.id, 'agt_nonexistent'),
      { message: /Agent not found/ },
    );
  });

  // ---- Test 12 ----
  it('addParticipant on archived session should be rejected', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-lifecycle-12',
      pluginID:       'claude-agent',
    });

    let session = await manager.createSession(organization.id, { archived: true });

    await assert.rejects(
      () => manager.addParticipant(session.id, agent.id),
      { message: /archived/ },
    );
  });

  // ---- Test 13 ----
  it('removeParticipant when agent is not a participant should be a no-op', async () => {
    let agent = await models.Agent.create({
      organizationID: organization.id,
      name:           'test-lifecycle-13',
      pluginID:       'claude-agent',
    });

    let session = await manager.createSession(organization.id);

    // Should not throw and should not produce a frame
    let result = await manager.removeParticipant(session.id, agent.id);

    // No-op should return a falsy or null/undefined result (not true)
    assert.ok(!result, 'removeParticipant on non-participant should return a falsy value');

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let leftFrames   = frames.filter((frame) => frame.type === 'ParticipantLeft');

    assert.equal(leftFrames.length, 0, 'No participant-left frame should be created for a non-participant');
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  // ---- Test 14 ----
  it('duplicate addParticipant is silently idempotent', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-14');

    let firstParticipant  = await manager.addParticipant(session.id, agent.id);
    let secondParticipant = await manager.addParticipant(session.id, agent.id);

    // Should return the existing participant, not create a duplicate
    assert.equal(firstParticipant.id, secondParticipant.id, 'Should return the same participant on duplicate add');

    let participants = await manager.getParticipants(session.id);
    assert.equal(participants.length, 1, 'Should not create a duplicate Participant record');

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrames = frames.filter(isJoinFrame);

    assert.equal(joinedFrames.length, 1, 'Should not create a duplicate join notification frame');
  });

  // ---- Test 15 ----
  it('Participant model schema: alias field should be ABSENT', () => {
    let fields     = Participant.fields;
    let fieldNames = Object.keys(fields);

    assert.ok(
      !fieldNames.includes('alias'),
      'Participant model should not have an alias field',
    );
  });

  // ---- Test 16 ----
  it('Participant model schema: overrides field should be ABSENT', () => {
    let fields     = Participant.fields;
    let fieldNames = Object.keys(fields);

    assert.ok(
      !fieldNames.includes('overrides'),
      'Participant model should not have an overrides field',
    );
  });

  // ---- Test 17 ----
  it('join notification frame is visible to agents (hidden: false)', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-17');

    await manager.addParticipant(session.id, agent.id);

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrame  = frames.find(isJoinFrame);

    assert.ok(joinedFrame, 'join notification frame must exist');

    // hidden: false means the frame appears in agent context.
    assert.equal(
      joinedFrame.hidden,
      false,
      'join notification frame must have hidden: false so it appears in agent context',
    );
  });
});
