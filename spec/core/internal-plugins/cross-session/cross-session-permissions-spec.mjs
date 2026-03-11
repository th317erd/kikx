'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../../src/core/index.mjs';
import { PluginInterface } from '../../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }  from '../../../../src/core/plugin-loader/registry.mjs';
import { SessionManager }  from '../../../../src/core/session/index.mjs';
import { Permissions }     from '../../../../src/core/permissions/permissions-base.mjs';
import { setup }           from '../../../../src/core/internal-plugins/cross-session/index.mjs';
import { CrossSessionPermissions } from '../../../../src/core/internal-plugins/cross-session/cross-session-permissions.mjs';

// =============================================================================
// CrossSessionPermissions — TDD Tests
// =============================================================================
// Tests for the permission logic governing cross-session tools:
//
//   - createSession:  ALWAYS requires explicit approval
//   - postToSession:  Auto-approved if agent is participant in target session
//   - Other tools:    Delegate to base Permissions behavior
// =============================================================================

describe('CrossSessionPermissions', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let registry;
  let org;

  let CreateSessionTool;
  let PostToSessionTool;
  let ListSessionsTool;
  let ReadFromSessionTool;
  let InviteParticipantTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager = new SessionManager(context);
    context.setProperty('sessionManager', sessionManager);

    // Register the cross-session plugin
    registry = new PluginRegistry();
    setup({
      registerTool: (name, cls) => registry.registerTool(name, cls),
      PluginInterface,
      context,
    });

    CreateSessionTool      = registry.getTool('cross-session:createSession');
    PostToSessionTool      = registry.getTool('cross-session:postToSession');
    ListSessionsTool       = registry.getTool('cross-session:listSessions');
    ReadFromSessionTool    = registry.getTool('cross-session:readFromSession');
    InviteParticipantTool  = registry.getTool('cross-session:inviteParticipant');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function createOrg(name = 'CrossPerm Test Org') {
    return models.Organization.create({ name });
  }

  async function createAgent(orgID, name) {
    return models.Agent.create({
      organizationID: orgID,
      name,
      pluginID:       'mock-agent',
    });
  }

  // ===========================================================================
  // Class structure
  // ===========================================================================

  describe('class structure', () => {
    it('should extend the base Permissions class', () => {
      let instance = new CrossSessionPermissions(context);
      assert.ok(instance instanceof Permissions);
    });

    it('should be constructable with a context', () => {
      let instance = new CrossSessionPermissions(context);
      assert.ok(instance);
    });
  });

  // ===========================================================================
  // getPermissionsClass() wiring
  // ===========================================================================

  describe('getPermissionsClass() wiring', () => {
    it('should return CrossSessionPermissions from CreateSessionTool', () => {
      let tool = new CreateSessionTool(context);
      assert.equal(tool.getPermissionsClass(), CrossSessionPermissions);
    });

    it('should return CrossSessionPermissions from PostToSessionTool', () => {
      let tool = new PostToSessionTool(context);
      assert.equal(tool.getPermissionsClass(), CrossSessionPermissions);
    });

    it('should NOT return CrossSessionPermissions from ListSessionsTool', () => {
      let tool = new ListSessionsTool(context);
      let result = tool.getPermissionsClass();
      assert.ok(result === null || result === undefined);
    });

    it('should NOT return CrossSessionPermissions from ReadFromSessionTool', () => {
      let tool = new ReadFromSessionTool(context);
      let result = tool.getPermissionsClass();
      assert.ok(result === null || result === undefined);
    });

    it('should NOT return CrossSessionPermissions from InviteParticipantTool', () => {
      let tool = new InviteParticipantTool(context);
      let result = tool.getPermissionsClass();
      assert.ok(result === null || result === undefined);
    });
  });

  // ===========================================================================
  // createSession — always requires approval
  // ===========================================================================

  describe('createSession — always requires approval', () => {
    it('should require approval via checkPermission', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:createSession',
        { title: 'Test Session' },
        {},
      );
      assert.equal(result, true, 'createSession must always need approval');
    });

    it('should require approval even with matching args', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:createSession',
        { title: 'Test', participants: ['agent-a'], parentSessionID: 'ses_123' },
        {},
      );
      assert.equal(result, true, 'createSession must always need approval regardless of args');
    });

    it('should bypass rule matching entirely (matchesRule always returns false for createSession)', () => {
      let permissions = new CrossSessionPermissions(context);
      let fakeRule = { effect: 'allow', metadata: null };
      let result = permissions.matchesRule(fakeRule, { toolName: 'createSession' }, {});
      assert.equal(result.matches, false, 'No rule should ever match createSession');
    });
  });

  // ===========================================================================
  // postToSession — auto-approve when agent is participant in target session
  // ===========================================================================

  describe('postToSession — participant-based auto-approval', () => {
    let testOrg;
    let agentA;
    let agentB;
    let parentSession;

    beforeEach(async () => {
      testOrg       = await createOrg('PostToSession Perms Org');
      agentA        = await createAgent(testOrg.id, `perm-agent-a-${Date.now()}`);
      agentB        = await createAgent(testOrg.id, `perm-agent-b-${Date.now()}`);
      parentSession = await sessionManager.createSession(testOrg.id, { name: 'Parent' });

      // agentA is a participant in the parent session
      await sessionManager.addParticipant(parentSession.id, agentA.id);
    });

    it('should auto-approve postToSession when agent is a participant in the target session', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:postToSession',
        { sessionID: parentSession.id, message: 'hello', agentID: agentA.id },
        {},
      );
      assert.equal(result, false, 'Agent that is participant should be auto-approved');
    });

    it('should require approval when agent is NOT a participant in the target session', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:postToSession',
        { sessionID: parentSession.id, message: 'hello', agentID: agentB.id },
        {},
      );
      assert.equal(result, null, 'Non-participant agent should defer to normal rule matching');
    });

    it('should handle agent being participant in a different session (not the target)', async () => {
      let otherSession = await sessionManager.createSession(testOrg.id, { name: 'Other' });
      await sessionManager.addParticipant(otherSession.id, agentB.id);

      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:postToSession',
        { sessionID: parentSession.id, message: 'hello', agentID: agentB.id },
        {},
      );
      assert.equal(result, null, 'Participant in different session should defer to normal matching');
    });
  });

  // ===========================================================================
  // postToSession — missing context handled gracefully
  // ===========================================================================

  describe('postToSession — missing context', () => {
    it('should defer when agentID is missing', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:postToSession',
        { sessionID: 'ses_123', message: 'hello' },
        {},
      );
      assert.equal(result, null, 'Missing agentID should defer');
    });

    it('should defer when sessionID is missing', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:postToSession',
        { message: 'hello', agentID: 'agt_123' },
        {},
      );
      assert.equal(result, null, 'Missing sessionID should defer');
    });

    it('should defer when sessionManager is not on context', async () => {
      let emptyContext = { getProperty: () => null };
      let permissions = new CrossSessionPermissions(emptyContext);
      let result = await permissions.checkPermission(
        'cross-session:postToSession',
        { sessionID: 'ses_123', message: 'hello', agentID: 'agt_123' },
        {},
      );
      assert.equal(result, null, 'Missing sessionManager should defer gracefully');
    });
  });

  // ===========================================================================
  // Other tools — delegate to base class behavior
  // ===========================================================================

  describe('other tools — default behavior', () => {
    it('should return null for listSessions (defer to base)', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:listSessions',
        {},
        {},
      );
      assert.equal(result, null, 'listSessions should defer to normal matching');
    });

    it('should return null for readFromSession (defer to base)', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:readFromSession',
        { sessionID: 'ses_123' },
        {},
      );
      assert.equal(result, null, 'readFromSession should defer to normal matching');
    });

    it('should return null for inviteParticipant (defer to base)', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:inviteParticipant',
        { sessionID: 'ses_123', agentName: 'bot' },
        {},
      );
      assert.equal(result, null, 'inviteParticipant should defer to normal matching');
    });

    it('should return null for unknown feature names (defer to base)', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:unknownTool',
        {},
        {},
      );
      assert.equal(result, null, 'Unknown tools should defer to normal matching');
    });
  });

  // ===========================================================================
  // matchesRule — createSession always rejects rules
  // ===========================================================================

  describe('matchesRule — createSession rule rejection', () => {
    it('should reject allow rules for createSession', () => {
      let permissions = new CrossSessionPermissions(context);
      let rule   = { effect: 'allow', metadata: null };
      let result = permissions.matchesRule(rule, { toolName: 'createSession' }, {});
      assert.equal(result.matches, false);
    });

    it('should reject deny rules for createSession', () => {
      let permissions = new CrossSessionPermissions(context);
      let rule   = { effect: 'deny', metadata: null };
      let result = permissions.matchesRule(rule, { toolName: 'createSession' }, {});
      assert.equal(result.matches, false);
    });

    it('should reject rules with metadata for createSession', () => {
      let permissions = new CrossSessionPermissions(context);
      let rule   = { effect: 'allow', metadata: '{"something":"value"}' };
      let result = permissions.matchesRule(rule, { toolName: 'createSession' }, { something: 'value' });
      assert.equal(result.matches, false);
    });
  });

  // ===========================================================================
  // matchesRule — other tools delegate to base
  // ===========================================================================

  describe('matchesRule — base delegation for other tools', () => {
    it('should delegate to base matchesRule for postToSession', () => {
      let permissions = new CrossSessionPermissions(context);
      let rule = { effect: 'allow', metadata: null };
      let result = permissions.matchesRule(rule, { toolName: 'postToSession' }, {});
      // Base class returns { matches: true }
      assert.equal(result.matches, true);
    });

    it('should delegate to base matchesRule for listSessions', () => {
      let permissions = new CrossSessionPermissions(context);
      let rule = { effect: 'allow', metadata: null };
      let result = permissions.matchesRule(rule, { toolName: 'listSessions' }, {});
      assert.equal(result.matches, true);
    });

    it('should delegate to base matchesRule for readFromSession', () => {
      let permissions = new CrossSessionPermissions(context);
      let rule = { effect: 'allow', metadata: null };
      let result = permissions.matchesRule(rule, { toolName: 'readFromSession' }, {});
      assert.equal(result.matches, true);
    });
  });

  // ===========================================================================
  // Integration: PermissionEngine + CrossSessionPermissions
  // ===========================================================================

  describe('PermissionEngine integration', () => {
    let engine;
    let testOrg;
    let agentA;
    let agentB;
    let parentSession;

    beforeEach(async () => {
      engine        = core.getPermissionEngine();
      testOrg       = await createOrg('Engine Integration Org');
      agentA        = await createAgent(testOrg.id, `engine-agent-a-${Date.now()}`);
      agentB        = await createAgent(testOrg.id, `engine-agent-b-${Date.now()}`);
      parentSession = await sessionManager.createSession(testOrg.id, { name: 'Engine Parent' });

      await sessionManager.addParticipant(parentSession.id, agentA.id);
    });

    it('should always require permission for createSession even with allow rule', async () => {
      // Create an allow rule for cross-session:createSession
      await engine.createRule({
        organizationID: testOrg.id,
        featureName:    'cross-session:createSession',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission(
        'cross-session:createSession',
        { title: 'New Session' },
        {
          organizationID: testOrg.id,
          toolClass:      CreateSessionTool,
          agent:          agentA,
        },
      );

      assert.equal(result, true, 'createSession must need permission even with allow rule');
    });

    it('should auto-approve postToSession when agent is participant', async () => {
      let result = await engine.checkPermission(
        'cross-session:postToSession',
        { sessionID: parentSession.id, message: 'hello', agentID: agentA.id },
        {
          organizationID: testOrg.id,
          toolClass:      PostToSessionTool,
          agent:          agentA,
        },
      );

      assert.equal(result, false, 'postToSession should be auto-approved for participant');
    });

    it('should require permission for postToSession when agent is NOT participant', async () => {
      let result = await engine.checkPermission(
        'cross-session:postToSession',
        { sessionID: parentSession.id, message: 'hello', agentID: agentB.id },
        {
          organizationID: testOrg.id,
          toolClass:      PostToSessionTool,
          agent:          agentB,
        },
      );

      assert.equal(result, true, 'postToSession should need permission for non-participant');
    });
  });
});
