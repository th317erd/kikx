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
// These tests verify the INTENDED behavior after the implementation is
// complete. They are expected to FAIL against the current codebase.
//
// A single KikxCore instance is shared across the entire suite to avoid
// race conditions from multiple concurrent DB connections.
// =============================================================================

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
  it('addParticipant creates participant-joined frame in session FrameManager', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-2');

    await manager.addParticipant(session.id, agent.id);

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrames = frames.filter((frame) => frame.type === 'participant-joined');

    assert.equal(joinedFrames.length, 1, 'Expected exactly one participant-joined frame');
  });

  // ---- Test 3 ----
  it('participant-joined frame has correct schema', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-3');

    await manager.addParticipant(session.id, agent.id);

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrame  = frames.find((frame) => frame.type === 'participant-joined');

    assert.ok(joinedFrame, 'participant-joined frame should exist');
    assert.equal(joinedFrame.type, 'participant-joined');
    assert.equal(joinedFrame.hidden, false);
    assert.equal(joinedFrame.authorType, 'system');
    assert.equal(joinedFrame.authorID, null);
    assert.ok(joinedFrame.content, 'Frame content should exist');
    assert.equal(joinedFrame.content.agentID, agent.id);
    assert.equal(joinedFrame.content.agentName, 'test-lifecycle-3');
  });

  // ---- Test 4 ----
  it('participant-joined frame is persisted via FramePersistence', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-4');

    await manager.addParticipant(session.id, agent.id);

    // Load frames from the database using a fresh FrameManager
    let loadedFrameManager = await persistence.loadFrames(session.id);
    let loadedFrames       = loadedFrameManager.toArray();
    let joinedFrames       = loadedFrames.filter((frame) => frame.type === 'participant-joined');

    assert.equal(joinedFrames.length, 1, 'Persisted participant-joined frame should be loadable');
    assert.equal(joinedFrames[0].content.agentID, agent.id);
    assert.equal(joinedFrames[0].content.agentName, 'test-lifecycle-4');
  });

  // ---- Test 5 ----
  it('participant-joined frame has correct monotonic order within session', async () => {
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
    let joinedFrames = frames.filter((frame) => frame.type === 'participant-joined');

    assert.equal(joinedFrames.length, 2, 'Expected two participant-joined frames');
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
    let leftFrame    = frames.find((frame) => frame.type === 'participant-left');

    assert.ok(leftFrame, 'participant-left frame should exist');
    assert.equal(leftFrame.type, 'participant-left');
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
    let joinedFrames = frames.filter((frame) => frame.type === 'participant-joined');

    assert.equal(joinedFrames.length, 2, 'Should have two participant-joined frames (original + re-add)');
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
      (frame) => frame.type === 'participant-joined' || frame.type === 'participant-left',
    );

    assert.equal(lifecycleFrames.length, 4, 'Expected 4 lifecycle frames (2 joined + 2 left)');

    // Verify chronological ordering by order field
    for (let index = 1; index < lifecycleFrames.length; index++) {
      assert.ok(
        lifecycleFrames[index - 1].order < lifecycleFrames[index].order,
        `Frame at index ${index - 1} (order ${lifecycleFrames[index - 1].order}) should precede frame at index ${index} (order ${lifecycleFrames[index].order})`,
      );
    }

    // Verify the sequence: joined, left, joined, left
    assert.equal(lifecycleFrames[0].type, 'participant-joined');
    assert.equal(lifecycleFrames[1].type, 'participant-left');
    assert.equal(lifecycleFrames[2].type, 'participant-joined');
    assert.equal(lifecycleFrames[3].type, 'participant-left');
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
    let leftFrames   = frames.filter((frame) => frame.type === 'participant-left');

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
    let joinedFrames = frames.filter((frame) => frame.type === 'participant-joined');

    assert.equal(joinedFrames.length, 1, 'Should not create a duplicate participant-joined frame');
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
  it('participant-joined frame is visible to agents (hidden: false)', async () => {
    let { agent, session } = await createAgentAndSession('test-lifecycle-17');

    await manager.addParticipant(session.id, agent.id);

    let frameManager = manager.getFrameManager(session.id);
    let frames       = frameManager.toArray();
    let joinedFrame  = frames.find((frame) => frame.type === 'participant-joined');

    assert.ok(joinedFrame, 'participant-joined frame must exist');

    // hidden: false means the frame appears in agent context.
    // The default for Frame is hidden: true, so this verifies addParticipant
    // explicitly sets hidden to false.
    assert.equal(
      joinedFrame.hidden,
      false,
      'participant-joined frame must have hidden: false so it appears in agent context',
    );
  });
});
