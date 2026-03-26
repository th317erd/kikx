'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../../src/core/index.mjs';
import { PluginInterface } from '../../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }  from '../../../../src/core/plugin-loader/registry.mjs';
import { SessionManager }  from '../../../../src/core/session/index.mjs';
import { Permissions }     from '../../../../src/core/permissions/permissions-base.mjs';
import { PermissionRequiredError } from '../../../../src/core/permissions/permission-required-error.mjs';
import { setup }           from '../../../../src/core/internal-plugins/cross-session/index.mjs';
import { CrossSessionPermissions } from '../../../../src/core/internal-plugins/cross-session/cross-session-permissions.mjs';

// =============================================================================
// CrossSessionPermissions — TDD Tests
// =============================================================================
// Tests for the permission logic governing cross-session tools.
//
// After tool-owned permissions migration:
//   - postToSession:  Auto-approved if participant, throws PermissionRequiredError otherwise
//   - listSessions:   Throws PermissionRequiredError with rich context
//   - createSession:  Throws PermissionRequiredError with rich context
//   - Other tools:    Return null (defer to base default)
// =============================================================================

describe('CrossSessionPermissions', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let registry;

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
    registry.registerClass(PluginInterface, { pluginName: 'core' });
    setup((cb) => cb({ registry, context }));

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

    it('should return CrossSessionPermissions from ListSessionsTool', () => {
      let tool = new ListSessionsTool(context);
      assert.equal(tool.getPermissionsClass(), CrossSessionPermissions);
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
  // postToSession — throws PermissionRequiredError with rich context
  // ===========================================================================

  describe('postToSession — rich PermissionRequiredError', () => {
    let testOrg;
    let agentA;
    let agentB;
    let parentSession;

    beforeEach(async () => {
      testOrg       = await createOrg('PostToSession Perms Org');
      agentA        = await createAgent(testOrg.id, `perm-agent-a-${Date.now()}`);
      agentB        = await createAgent(testOrg.id, `perm-agent-b-${Date.now()}`);
      parentSession = await sessionManager.createSession(testOrg.id, { name: 'My Project' });

      // agentA is a participant in the parent session
      await sessionManager.addParticipant(parentSession.id, agentA.id);
    });

    it('should auto-approve postToSession when agent is a participant', async () => {
      let permissions = new CrossSessionPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:postToSession',
        { sessionID: parentSession.id, message: 'hello', agentID: agentA.id },
        {},
      );
      assert.equal(result, false, 'Agent that is participant should be auto-approved');
    });

    it('should throw PermissionRequiredError when agent is NOT a participant', async () => {
      let permissions = new CrossSessionPermissions(context);
      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:postToSession',
          { sessionID: parentSession.id, message: 'hello world', agentID: agentB.id },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.equal(err.title, 'Send Message to Session');
          assert.ok(err.titleParams.sessionName === 'My Project');
          assert.ok(err.description.includes('is attempting to send a message'));
          assert.equal(err.featureName, 'cross-session:postToSession');

          // Details should contain agent, target session, and message
          assert.ok(err.details.length >= 2);
          let agentDetail   = err.details.find((d) => d.label === 'Agent');
          let sessionDetail = err.details.find((d) => d.label === 'Target Session');
          let messageDetail = err.details.find((d) => d.label === 'Message');
          assert.ok(agentDetail, 'should have Agent detail');
          assert.ok(sessionDetail, 'should have Target Session detail');
          assert.ok(sessionDetail.value.includes('My Project'));
          if (messageDetail) assert.equal(messageDetail.value, 'hello world');
          return true;
        },
      );
    });

    it('should resolve session name from DB in error details', async () => {
      let namedSession = await sessionManager.createSession(testOrg.id, { name: 'Design Review' });
      let permissions = new CrossSessionPermissions(context);

      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:postToSession',
          { sessionID: namedSession.id, message: 'test', agentID: agentB.id },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.ok(err.titleParams.sessionName === 'Design Review');
          let sd = err.details.find((d) => d.label === 'Target Session');
          assert.ok(sd && sd.value.includes('Design Review'));
          return true;
        },
      );
    });

    it('should fall back to raw sessionID when session not found', async () => {
      let permissions = new CrossSessionPermissions(context);

      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:postToSession',
          { sessionID: 'ses_nonexistent', message: 'test', agentID: 'agt_fake' },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.ok(err.titleParams.sessionName === 'ses_nonexistent');
          let sd = err.details.find((d) => d.label === 'Target Session');
          assert.ok(sd && sd.value.includes('ses_nonexistent'));
          return true;
        },
      );
    });

    it('should show (unnamed) when session name is empty string', async () => {
      let unnamedSession = await sessionManager.createSession(testOrg.id, { name: '' });
      let permissions = new CrossSessionPermissions(context);

      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:postToSession',
          { sessionID: unnamedSession.id, message: 'test', agentID: agentB.id },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.ok(err.titleParams.sessionName === '(unnamed)');
          let sd = err.details.find((d) => d.label === 'Target Session');
          assert.ok(sd && sd.value.includes('(unnamed)'));
          return true;
        },
      );
    });

    it('should truncate message preview when message > 200 chars', async () => {
      let longMessage = 'x'.repeat(250);
      let permissions = new CrossSessionPermissions(context);

      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:postToSession',
          { sessionID: parentSession.id, message: longMessage, agentID: agentB.id },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          let preview = err.details.find((d) => d.label === 'Message');
          assert.ok(preview, 'Should have messagePreview detail');
          assert.equal(preview.value.length, 203); // 200 + '...'
          assert.ok(preview.value.endsWith('...'));
          return true;
        },
      );
    });

    it('should omit message preview when message is missing', async () => {
      let permissions = new CrossSessionPermissions(context);

      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:postToSession',
          { sessionID: parentSession.id, agentID: agentB.id },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          let preview = err.details.find((d) => d.label === 'Message');
          assert.equal(preview, undefined, 'Should not have message when message is missing');
          // Should still have agent + target session
          let sd = err.details.find((d) => d.label === 'Target Session');
          assert.ok(sd, 'Should have Target Session detail');
          return true;
        },
      );
    });

    it('should omit target session detail when sessionID is missing', async () => {
      let permissions = new CrossSessionPermissions(context);

      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:postToSession',
          { message: 'hello', agentID: 'agt_123' },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          let target = err.details.find((d) => d.label === 'Target Session');
          assert.equal(target, undefined, 'Should not have Target Session when sessionID is missing');
          // Should still have agent + message
          let msg = err.details.find((d) => d.label === 'Message');
          assert.ok(msg, 'Should have Message detail');
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // listSessions — throws PermissionRequiredError with rich context
  // ===========================================================================

  describe('listSessions — rich PermissionRequiredError', () => {
    it('should throw PermissionRequiredError with list title', async () => {
      let permissions = new CrossSessionPermissions(context);
      await assert.rejects(
        () => permissions.checkPermission('cross-session:listSessions', {}, {}),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.equal(err.featureName, 'cross-session:listSessions');
          assert.equal(err.title, 'List Sessions');
          assert.equal(err.description, 'Agent is requesting to list available sessions.');
          assert.deepEqual(err.details, []);
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // createSession — throws PermissionRequiredError with rich context
  // ===========================================================================

  describe('createSession — rich PermissionRequiredError', () => {
    it('should throw PermissionRequiredError with create title', async () => {
      let permissions = new CrossSessionPermissions(context);
      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:createSession',
          { title: 'Test Session' },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.equal(err.featureName, 'cross-session:createSession');
          assert.equal(err.title, 'Create New Session');
          assert.ok(err.description.includes('requesting to create a new session'));
          return true;
        },
      );
    });

    it('should throw PermissionRequiredError even with full args', async () => {
      let permissions = new CrossSessionPermissions(context);
      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:createSession',
          { title: 'Test', participants: ['agent-a'], parentSessionID: 'ses_123' },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.equal(err.title, 'Create New Session');
          return true;
        },
      );
    });

    it('should include session title in details when provided', async () => {
      let permissions = new CrossSessionPermissions(context);
      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:createSession',
          { title: 'Research Task' },
          {},
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          let titleDetail = err.details.find((d) => d.label === 'Session Name');
          assert.ok(titleDetail, 'Should have sessionTitle detail');
          assert.equal(titleDetail.value, 'Research Task');
          return true;
        },
      );
    });

    it('should bypass rule matching entirely (matchesRule always returns false for createSession)', () => {
      let permissions = new CrossSessionPermissions(context);
      let fakeRule = { effect: 'allow', metadata: null };
      let result = permissions.matchesRule(fakeRule, { toolName: 'createSession' }, {});
      assert.equal(result.matches, false, 'No rule should ever match createSession');
    });
  });

  // ===========================================================================
  // Other tools — return null (defer to base default)
  // ===========================================================================

  describe('other tools — default behavior', () => {
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
  // Integration: Full permission flow (checkPermission → evaluate)
  // ===========================================================================

  describe('full permission flow integration', () => {
    let testOrg;
    let agentA;
    let agentB;
    let parentSession;

    beforeEach(async () => {
      testOrg       = await createOrg('Flow Integration Org');
      agentA        = await createAgent(testOrg.id, `flow-agent-a-${Date.now()}`);
      agentB        = await createAgent(testOrg.id, `flow-agent-b-${Date.now()}`);
      parentSession = await sessionManager.createSession(testOrg.id, { name: 'Flow Parent' });

      await sessionManager.addParticipant(parentSession.id, agentA.id);
    });

    it('should always require permission for createSession (checkPermission throws)', async () => {
      let permissions = new CrossSessionPermissions(context);

      // Create an allow rule — should be ignored because checkPermission
      // throws before evaluate() is ever reached
      await permissions.createRule({
        organizationID: testOrg.id,
        featureName:    'cross-session:createSession',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:createSession',
          { title: 'New Session' },
          {
            organizationID: testOrg.id,
            toolClass:      CreateSessionTool,
            agent:          agentA,
          },
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.equal(err.title, 'Create New Session');
          return true;
        },
      );
    });

    it('should auto-approve postToSession when agent is participant', async () => {
      let permissions = new CrossSessionPermissions(context);

      let result = await permissions.checkPermission(
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
      let permissions = new CrossSessionPermissions(context);

      await assert.rejects(
        () => permissions.checkPermission(
          'cross-session:postToSession',
          { sessionID: parentSession.id, message: 'hello', agentID: agentB.id },
          {
            organizationID: testOrg.id,
            toolClass:      PostToSessionTool,
            agent:          agentB,
          },
        ),
        (err) => {
          assert.ok(err instanceof PermissionRequiredError);
          assert.equal(err.title, 'Send Message to Session');
          assert.ok(err.titleParams.sessionName === 'Flow Parent');
          return true;
        },
      );
    });
  });
});
