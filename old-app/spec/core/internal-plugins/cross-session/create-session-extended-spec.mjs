'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../../src/core/index.mjs';
import { PluginInterface } from '../../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }  from '../../../../src/core/plugin-loader/registry.mjs';
import { SessionManager }  from '../../../../src/core/session/index.mjs';
import { FramePersistence } from '../../../../src/core/frames/index.mjs';
import { setup }           from '../../../../src/core/internal-plugins/cross-session/index.mjs';

// =============================================================================
// CreateSession Tool Extension — TDD Tests
// =============================================================================
// Step 8: Extended createSession tool with:
//   - initialMessage: first frame in the new session authored by creating agent
//   - constraints: maxInteractions and endsAt propagated to session
//   - Role assignment: creating agent → coordinator, others → member
//   - Default constraints for agent-created child sessions
// =============================================================================

describe('CreateSession Tool Extension', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;
  let registry;
  let CreateSessionTool;

  let org;
  let agentA;
  let agentB;
  let agentC;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager   = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);

    // Register the cross-session plugin
    registry = new PluginRegistry();
    registry.registerClass(PluginInterface, { pluginName: 'core' });
    setup((cb) => cb({ registry, context }));

    CreateSessionTool = registry.getTool('cross-session:createSession');

    // Create test org and agents
    org    = await models.Organization.create({ name: 'CreateSession Extended Org' });
    agentA = await models.Agent.create({ organizationID: org.id, name: `test-ext-agent-a-${Date.now()}`, pluginID: 'mock' });
    agentB = await models.Agent.create({ organizationID: org.id, name: `test-ext-agent-b-${Date.now()}`, pluginID: 'mock' });
    agentC = await models.Agent.create({ organizationID: org.id, name: `test-ext-agent-c-${Date.now()}`, pluginID: 'mock' });
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // Helper: execute the createSession tool
  async function executeCreateSession(params) {
    let tool = new CreateSessionTool(context);
    return tool._execute(params);
  }

  // ===========================================================================
  // Role Assignment: creating agent → coordinator, others → member
  // ===========================================================================

  describe('role assignment', () => {
    it('should assign coordinator role to the creating agent', async () => {
      let result = await executeCreateSession({
        title:        'Role Test Session',
        participants: [agentA.name, agentB.name],
        agentID:      agentA.id,
      });

      let participants = await sessionManager.getParticipants(result.sessionID);
      let agentAParticipant = participants.find((p) => p.agentID === agentA.id);
      let agentBParticipant = participants.find((p) => p.agentID === agentB.id);

      assert.equal(agentAParticipant.role, 'coordinator', 'Creating agent should be coordinator');
      assert.equal(agentBParticipant.role, 'member', 'Other participant should be member');
    });

    it('should assign member role to all non-creating participants', async () => {
      let result = await executeCreateSession({
        title:        'Multi-Member Session',
        participants: [agentA.name, agentB.name, agentC.name],
        agentID:      agentA.id,
      });

      let participants = await sessionManager.getParticipants(result.sessionID);
      let nonCreators  = participants.filter((p) => p.agentID !== agentA.id);

      for (let participant of nonCreators)
        assert.equal(participant.role, 'member', `${participant.agentID} should be member`);
    });

    it('should handle creating agent not in participants list', async () => {
      // agentA creates the session but only adds agentB and agentC
      let result = await executeCreateSession({
        title:        'Creator Not In List',
        participants: [agentB.name, agentC.name],
        agentID:      agentA.id,
      });

      let participants = await sessionManager.getParticipants(result.sessionID);
      // agentA should NOT be added automatically
      let agentAParticipant = participants.find((p) => p.agentID === agentA.id);
      assert.equal(agentAParticipant, undefined, 'Creator should not be auto-added if not in participants list');
    });

    it('should assign coordinator when creating agent is the only participant', async () => {
      let result = await executeCreateSession({
        title:        'Solo Coordinator',
        participants: [agentA.name],
        agentID:      agentA.id,
      });

      let participants = await sessionManager.getParticipants(result.sessionID);
      assert.equal(participants.length, 1);
      assert.equal(participants[0].role, 'coordinator');
    });
  });

  // ===========================================================================
  // initialMessage: first frame in new session
  // ===========================================================================

  describe('initialMessage', () => {
    it('should create a message frame in the new session', async () => {
      let result = await executeCreateSession({
        title:          'Initial Msg Session',
        participants:   [agentA.name],
        agentID:        agentA.id,
        initialMessage: 'Hello, this is the first message!',
      });

      let fm     = await framePersistence.loadFrames(result.sessionID);
      let frames = fm.toArray();

      let messageFrames = frames.filter((f) => f.type === 'Message');
      assert.ok(messageFrames.length >= 1, 'Should have at least 1 message frame');

      let initialFrame = messageFrames.find((f) => f.content && f.content.text === 'Hello, this is the first message!');
      assert.ok(initialFrame, 'Message frame should contain the initialMessage text');
      assert.equal(initialFrame.authorType, 'agent', 'Frame should be authored by agent');
      assert.equal(initialFrame.authorID, agentA.id, 'Frame should be authored by creating agent');
    });

    it('should not create a message frame when initialMessage is absent', async () => {
      let result = await executeCreateSession({
        title:        'No Initial Msg',
        participants: [agentA.name],
        agentID:      agentA.id,
      });

      let fm     = await framePersistence.loadFrames(result.sessionID);
      let frames = fm.toArray();

      let messageFrames = frames.filter((f) => f.type === 'Message' && f.authorType !== 'system');
      assert.equal(messageFrames.length, 0, 'Should have no message frames without initialMessage');
    });

    it('should not create a message frame when initialMessage is empty string', async () => {
      let result = await executeCreateSession({
        title:          'Empty Initial Msg',
        participants:   [agentA.name],
        agentID:        agentA.id,
        initialMessage: '',
      });

      let fm     = await framePersistence.loadFrames(result.sessionID);
      let frames = fm.toArray();

      let messageFrames = frames.filter((f) => f.type === 'Message' && f.authorType !== 'system');
      assert.equal(messageFrames.length, 0, 'Empty string initialMessage should produce no frames');
    });
  });

  // ===========================================================================
  // constraints: maxInteractions and endsAt
  // ===========================================================================

  describe('constraints', () => {
    it('should pass maxInteractions to the created session', async () => {
      let result = await executeCreateSession({
        title:        'Constrained Session',
        participants: [agentA.name],
        agentID:      agentA.id,
        constraints:  { maxInteractions: 5 },
      });

      let session = await sessionManager.getSession(result.sessionID);
      assert.equal(session.maxInteractions, 5);
    });

    it('should pass endsAt to the created session', async () => {
      let endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
      let result = await executeCreateSession({
        title:        'Time-Limited Session',
        participants: [agentA.name],
        agentID:      agentA.id,
        constraints:  { endsAt },
      });

      let session = await sessionManager.getSession(result.sessionID);
      assert.ok(session.endsAt, 'Session should have endsAt set');
    });

    it('should pass both maxInteractions and endsAt', async () => {
      let endsAt = new Date(Date.now() + 3600000).toISOString();
      let result = await executeCreateSession({
        title:        'Dual Constraint Session',
        participants: [agentA.name],
        agentID:      agentA.id,
        constraints:  { maxInteractions: 10, endsAt },
      });

      let session = await sessionManager.getSession(result.sessionID);
      assert.equal(session.maxInteractions, 10);
      assert.ok(session.endsAt);
    });

    it('should not set constraints when none specified', async () => {
      let result = await executeCreateSession({
        title:        'No Constraints Session',
        participants: [agentA.name],
        agentID:      agentA.id,
      });

      let session = await sessionManager.getSession(result.sessionID);
      assert.equal(session.maxInteractions, null);
      assert.equal(session.endsAt, null);
    });
  });

  // ===========================================================================
  // Default constraints for agent-created child sessions
  // ===========================================================================

  describe('default constraints for agent-created children', () => {
    it('should apply default maxInteractions when agent creates child with no constraints', async () => {
      // Create parent session first
      let parentSession = await sessionManager.createSession(org.id, { name: 'Parent for Defaults' });

      let result = await executeCreateSession({
        title:           'Child With Defaults',
        participants:    [agentA.name],
        agentID:         agentA.id,
        parentSessionID: parentSession.id,
      });

      let session = await sessionManager.getSession(result.sessionID);
      // Default maxInteractions for agent-created child sessions
      assert.ok(session.maxInteractions != null, 'Agent-created child should have default maxInteractions');
      assert.ok(session.maxInteractions > 0, 'Default maxInteractions should be positive');
    });

    it('should respect explicit constraints over defaults for child sessions', async () => {
      let parentSession = await sessionManager.createSession(org.id, { name: 'Parent for Override' });

      let result = await executeCreateSession({
        title:           'Child With Custom',
        participants:    [agentA.name],
        agentID:         agentA.id,
        parentSessionID: parentSession.id,
        constraints:     { maxInteractions: 3 },
      });

      let session = await sessionManager.getSession(result.sessionID);
      assert.equal(session.maxInteractions, 3, 'Explicit constraints should override defaults');
    });

    it('should not apply default constraints to top-level sessions', async () => {
      let result = await executeCreateSession({
        title:        'Top-Level No Defaults',
        participants: [agentA.name],
        agentID:      agentA.id,
      });

      let session = await sessionManager.getSession(result.sessionID);
      assert.equal(session.maxInteractions, null, 'Top-level session should have no default constraints');
    });
  });

  // ===========================================================================
  // inputSchema includes new fields
  // ===========================================================================

  describe('inputSchema', () => {
    it('should include initialMessage in inputSchema', () => {
      let schema = CreateSessionTool.inputSchema;
      assert.ok(schema.properties.initialMessage, 'inputSchema should have initialMessage');
      assert.equal(schema.properties.initialMessage.type, 'string');
    });

    it('should include constraints in inputSchema', () => {
      let schema = CreateSessionTool.inputSchema;
      assert.ok(schema.properties.constraints, 'inputSchema should have constraints');
      assert.equal(schema.properties.constraints.type, 'object');
    });
  });

  // ===========================================================================
  // Sub-session with initialMessage
  // ===========================================================================

  describe('sub-session with initialMessage', () => {
    it('should create initialMessage frame in sub-session (not parent)', async () => {
      let parentSession = await sessionManager.createSession(org.id, { name: 'Parent for InitMsg' });

      let result = await executeCreateSession({
        title:           'Child With Message',
        participants:    [agentA.name],
        agentID:         agentA.id,
        parentSessionID: parentSession.id,
        initialMessage:  'Starting deliberation...',
      });

      // Message should be in child, not parent
      let childFM = await framePersistence.loadFrames(result.sessionID);
      let childMsgs = childFM.toArray().filter((f) => f.type === 'Message');
      assert.ok(childMsgs.length >= 1, 'Child should have the initial message');

      let parentFM = await framePersistence.loadFrames(parentSession.id);
      let parentMsgs = parentFM.toArray().filter((f) => f.type === 'Message');
      assert.equal(parentMsgs.length, 0, 'Parent should not have the initial message');
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle constraints with zero maxInteractions', async () => {
      // Zero is technically invalid but should be stored faithfully
      let result = await executeCreateSession({
        title:        'Zero Constraint',
        participants: [agentA.name],
        agentID:      agentA.id,
        constraints:  { maxInteractions: 0 },
      });

      let session = await sessionManager.getSession(result.sessionID);
      assert.equal(session.maxInteractions, 0);
    });

    it('should handle missing agentID gracefully for role assignment', async () => {
      // No agentID means no coordinator — all are members
      // Use parentSessionID to resolve org when agentID is absent
      let parentSession = await sessionManager.createSession(org.id, { name: 'Parent for No AgentID' });

      let result = await executeCreateSession({
        title:           'No Agent ID Session',
        participants:    [agentA.name, agentB.name],
        parentSessionID: parentSession.id,
      });

      let participants = await sessionManager.getParticipants(result.sessionID);
      for (let participant of participants)
        assert.equal(participant.role, 'member', 'All should be member when no agentID');
    });
  });
});
