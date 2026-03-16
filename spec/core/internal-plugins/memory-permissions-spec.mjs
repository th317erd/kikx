'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../../src/core/index.mjs';
import { PluginInterface }    from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }     from '../../../src/core/plugin-loader/registry.mjs';
import { Permissions }        from '../../../src/core/permissions/permissions-base.mjs';
import { setup }              from '../../../src/core/internal-plugins/memory/index.mjs';
import { MemoryPermissions }  from '../../../src/core/internal-plugins/memory/memory-permissions.mjs';

// =============================================================================
// MemoryPermissions — Tests
// =============================================================================
// Tests for the permission logic governing memory tools:
//
//   Agent-owned tools (6): Auto-approved when the agent accesses its own data.
//                          Deferred when agentID targets a different agent.
//
//   Session context tools (3): Always deferred to normal rule matching.
// =============================================================================

describe('MemoryPermissions', () => {
  let core;
  let context;
  let registry;

  let GetAgentConfigTool;
  let SetAgentConfigTool;
  let UpdateAgentConfigTool;
  let GetSessionContextTool;
  let SetSessionContextTool;
  let UpdateSessionContextTool;
  let GetMemoryValueTool;
  let SetMemoryValueTool;
  let SearchMemoryValuesTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    context = core.getContext();

    registry = new PluginRegistry();
    setup({
      registerTool: (name, cls) => registry.registerTool(name, cls),
      PluginInterface,
      context,
    });

    GetAgentConfigTool      = registry.getTool('memory:getAgentConfig');
    SetAgentConfigTool      = registry.getTool('memory:setAgentConfig');
    UpdateAgentConfigTool   = registry.getTool('memory:updateAgentConfig');
    GetSessionContextTool   = registry.getTool('memory:getSessionContext');
    SetSessionContextTool   = registry.getTool('memory:setSessionContext');
    UpdateSessionContextTool = registry.getTool('memory:updateSessionContext');
    GetMemoryValueTool      = registry.getTool('memory:getValue');
    SetMemoryValueTool      = registry.getTool('memory:setValue');
    SearchMemoryValuesTool  = registry.getTool('memory:searchValues');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // ===========================================================================
  // Class structure
  // ===========================================================================

  describe('class structure', () => {
    it('extends the base Permissions class', () => {
      let instance = new MemoryPermissions(context);
      assert.ok(instance instanceof Permissions);
    });

    it('is constructable with a context', () => {
      let instance = new MemoryPermissions(context);
      assert.ok(instance);
    });
  });

  // ===========================================================================
  // getPermissionsClass() wiring — all 9 tools return MemoryPermissions
  // ===========================================================================

  describe('getPermissionsClass() wiring', () => {
    it('returns MemoryPermissions from GetAgentConfigTool', () => {
      let tool = new GetAgentConfigTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });

    it('returns MemoryPermissions from SetAgentConfigTool', () => {
      let tool = new SetAgentConfigTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });

    it('returns MemoryPermissions from UpdateAgentConfigTool', () => {
      let tool = new UpdateAgentConfigTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });

    it('returns MemoryPermissions from GetSessionContextTool', () => {
      let tool = new GetSessionContextTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });

    it('returns MemoryPermissions from SetSessionContextTool', () => {
      let tool = new SetSessionContextTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });

    it('returns MemoryPermissions from UpdateSessionContextTool', () => {
      let tool = new UpdateSessionContextTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });

    it('returns MemoryPermissions from GetMemoryValueTool', () => {
      let tool = new GetMemoryValueTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });

    it('returns MemoryPermissions from SetMemoryValueTool', () => {
      let tool = new SetMemoryValueTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });

    it('returns MemoryPermissions from SearchMemoryValuesTool', () => {
      let tool = new SearchMemoryValuesTool(context);
      assert.equal(tool.getPermissionsClass(), MemoryPermissions);
    });
  });

  // ===========================================================================
  // Agent-owned tools — self-access auto-approved
  // ===========================================================================

  describe('agent-owned tools — self-access auto-approved', () => {
    let agentSelf = { id: 'agt_self_123' };

    it('auto-approves getAgentConfig when agent accesses own data', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getAgentConfig',
        { agentID: agentSelf.id },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access getAgentConfig should be auto-approved');
    });

    it('auto-approves setAgentConfig when agent accesses own data', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:setAgentConfig',
        { agentID: agentSelf.id, config: { model: 'test' } },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access setAgentConfig should be auto-approved');
    });

    it('auto-approves updateAgentConfig when agent accesses own data', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:updateAgentConfig',
        { agentID: agentSelf.id, updates: { model: 'test' } },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access updateAgentConfig should be auto-approved');
    });

    it('auto-approves getValue when agent accesses own data', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getValue',
        { agentID: agentSelf.id, key: 'test-key' },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access getValue should be auto-approved');
    });

    it('auto-approves setValue when agent accesses own data', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:setValue',
        { agentID: agentSelf.id, key: 'test-key', value: 'hello' },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access setValue should be auto-approved');
    });

    it('auto-approves searchValues when agent accesses own data', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:searchValues',
        { agentID: agentSelf.id },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access searchValues should be auto-approved');
    });
  });

  // ===========================================================================
  // Agent-owned tools — self-access with explicit scopeID still auto-approved
  // ===========================================================================

  describe('agent-owned tools — scopeID does not affect self-access', () => {
    let agentSelf = { id: 'agt_scope_test' };

    it('auto-approves getValue with explicit scopeID (agent owns all scopes)', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getValue',
        { agentID: agentSelf.id, key: 'k', scopeID: 'some-other-session' },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access with explicit scopeID should be auto-approved');
    });

    it('auto-approves setValue with explicit scopeID', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:setValue',
        { agentID: agentSelf.id, key: 'k', value: 'v', scopeID: '' },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access setValue with empty scopeID should be auto-approved');
    });

    it('auto-approves searchValues with explicit scopeID', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:searchValues',
        { agentID: agentSelf.id, query: 'test', scopeID: 'scope-x' },
        { agent: agentSelf },
      );
      assert.equal(result, false, 'Self-access searchValues with scopeID should be auto-approved');
    });
  });

  // ===========================================================================
  // Agent-owned tools — cross-agent access defers to rules
  // ===========================================================================

  describe('agent-owned tools — cross-agent access defers to rules', () => {
    let callingAgent = { id: 'agt_caller_111' };
    let targetAgent  = { id: 'agt_target_222' };

    it('defers getAgentConfig when agentID targets a different agent', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getAgentConfig',
        { agentID: targetAgent.id },
        { agent: callingAgent },
      );
      assert.equal(result, null, 'Cross-agent getAgentConfig should defer to rules');
    });

    it('defers setAgentConfig when agentID targets a different agent', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:setAgentConfig',
        { agentID: targetAgent.id, config: {} },
        { agent: callingAgent },
      );
      assert.equal(result, null, 'Cross-agent setAgentConfig should defer to rules');
    });

    it('defers updateAgentConfig when agentID targets a different agent', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:updateAgentConfig',
        { agentID: targetAgent.id, updates: {} },
        { agent: callingAgent },
      );
      assert.equal(result, null, 'Cross-agent updateAgentConfig should defer to rules');
    });

    it('defers getValue when agentID targets a different agent', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getValue',
        { agentID: targetAgent.id, key: 'k' },
        { agent: callingAgent },
      );
      assert.equal(result, null, 'Cross-agent getValue should defer to rules');
    });

    it('defers setValue when agentID targets a different agent', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:setValue',
        { agentID: targetAgent.id, key: 'k', value: 'v' },
        { agent: callingAgent },
      );
      assert.equal(result, null, 'Cross-agent setValue should defer to rules');
    });

    it('defers searchValues when agentID targets a different agent', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:searchValues',
        { agentID: targetAgent.id },
        { agent: callingAgent },
      );
      assert.equal(result, null, 'Cross-agent searchValues should defer to rules');
    });
  });

  // ===========================================================================
  // Session context tools — always defer to rules
  // ===========================================================================

  describe('session context tools — always defer to rules', () => {
    it('defers getSessionContext', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getSessionContext',
        { sessionID: 'ses_123' },
        {},
      );
      assert.equal(result, null, 'getSessionContext should always defer to rules');
    });

    it('defers setSessionContext', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:setSessionContext',
        { sessionID: 'ses_123', context: {} },
        {},
      );
      assert.equal(result, null, 'setSessionContext should always defer to rules');
    });

    it('defers updateSessionContext', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:updateSessionContext',
        { sessionID: 'ses_123', updates: {} },
        {},
      );
      assert.equal(result, null, 'updateSessionContext should always defer to rules');
    });

    it('defers getSessionContext even without args', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getSessionContext',
        {},
        {},
      );
      assert.equal(result, null, 'getSessionContext with no args should still defer');
    });
  });

  // ===========================================================================
  // Unknown tools — defer to rules
  // ===========================================================================

  describe('unknown tools — defer to rules', () => {
    it('defers for unknown feature names within memory plugin', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:unknownTool',
        {},
        {},
      );
      assert.equal(result, null, 'Unknown memory tools should defer to rules');
    });

    it('defers for feature names from other plugins', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'cross-session:postToSession',
        { sessionID: 'ses_123' },
        {},
      );
      assert.equal(result, null, 'Non-memory tools should defer to rules');
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('auto-approves when options is null/undefined (no agent to compare)', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getAgentConfig',
        { agentID: 'agt_123' },
        null,
      );
      // No callingAgent to compare against — can't determine mismatch,
      // so the guard doesn't trigger, and it falls through to auto-approve
      assert.equal(result, false);
    });

    it('auto-approves when options.agent is missing', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getAgentConfig',
        { agentID: 'agt_123' },
        {},
      );
      assert.equal(result, false);
    });

    it('auto-approves when args is null/undefined', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getAgentConfig',
        null,
        { agent: { id: 'agt_123' } },
      );
      assert.equal(result, false);
    });

    it('auto-approves when args.agentID is missing (framework will inject)', async () => {
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:getValue',
        { key: 'test' },
        { agent: { id: 'agt_123' } },
      );
      // No agentID in args means the guard can't detect a mismatch
      assert.equal(result, false);
    });

    it('auto-approves when agentID matches exactly', async () => {
      let agent = { id: 'agt_exact_match' };
      let permissions = new MemoryPermissions(context);
      let result = await permissions.checkPermission(
        'memory:setValue',
        { agentID: 'agt_exact_match', key: 'k', value: 'v' },
        { agent },
      );
      assert.equal(result, false);
    });
  });

  // ===========================================================================
  // PermissionEngine integration
  // ===========================================================================

  describe('PermissionEngine integration', () => {
    let engine;
    let models;
    let organization;

    before(async () => {
      engine = core.getPermissionEngine();
      models = core.getModels();
    });

    it('auto-approves getAgentConfig for self-access through PermissionEngine', async () => {
      organization = await models.Organization.create({ name: 'MemPerm Engine Org' });
      let agent = await models.Agent.create({
        organizationID: organization.id,
        name:           'test-engine-agent',
        pluginID:       'mock-agent',
      });

      let result = await engine.checkPermission(
        'memory:getAgentConfig',
        { agentID: agent.id },
        {
          organizationID: organization.id,
          toolClass:      GetAgentConfigTool,
          agent,
        },
      );

      assert.equal(result, false, 'Self-access getAgentConfig should be auto-approved via engine');
    });

    it('defers cross-agent getValue through PermissionEngine (falls through to rules)', async () => {
      organization = await models.Organization.create({ name: 'MemPerm Engine Org 2' });
      let callerAgent = await models.Agent.create({
        organizationID: organization.id,
        name:           'test-engine-caller',
        pluginID:       'mock-agent',
      });
      let targetAgent = await models.Agent.create({
        organizationID: organization.id,
        name:           'test-engine-target',
        pluginID:       'mock-agent',
      });

      let result = await engine.checkPermission(
        'memory:getValue',
        { agentID: targetAgent.id, key: 'secret' },
        {
          organizationID: organization.id,
          toolClass:      GetMemoryValueTool,
          agent:          callerAgent,
        },
      );

      // No allow rules exist, so should require approval
      assert.equal(result, true, 'Cross-agent getValue should require approval');
    });

    it('defers setSessionContext through PermissionEngine (not agent-owned)', async () => {
      organization = await models.Organization.create({ name: 'MemPerm Engine Org 3' });
      let agent = await models.Agent.create({
        organizationID: organization.id,
        name:           'test-engine-session',
        pluginID:       'mock-agent',
      });

      let result = await engine.checkPermission(
        'memory:setSessionContext',
        { sessionID: 'ses_123', context: { foo: 'bar' } },
        {
          organizationID: organization.id,
          toolClass:      SetSessionContextTool,
          agent,
        },
      );

      // Should defer to rules; no allow rule → needs approval
      assert.equal(result, true, 'setSessionContext should require approval via engine');
    });
  });
});
