'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }   from '../../../src/core/index.mjs';
import { PluginInterface }  from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }   from '../../../src/core/plugin-loader/registry.mjs';
import { SessionManager }   from '../../../src/core/session/index.mjs';
import { setup }            from '../../../src/core/internal-plugins/memory/index.mjs';
import { Agent }            from '../../../src/core/models/agent-model.mjs';

// =============================================================================
// Memory & Context Integration Tests
// =============================================================================
// End-to-end tests that exercise the full stack: model methods, plugin tools,
// DB persistence, protected key security, and context inheritance.
// =============================================================================

describe('Memory Context Integration', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let registry;
  let organization;

  let GetAgentConfigTool;
  let SetAgentConfigTool;
  let UpdateAgentConfigTool;
  let GetSessionContextTool;
  let SetSessionContextTool;
  let UpdateSessionContextTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager = new SessionManager(context);
    context.setProperty('sessionManager', sessionManager);

    registry = new PluginRegistry();
    registry.registerClass(PluginInterface, { pluginName: 'core' });
    setup((cb) => cb({ registry, context }));

    GetAgentConfigTool     = registry.getTool('memory:getAgentConfig');
    SetAgentConfigTool     = registry.getTool('memory:setAgentConfig');
    UpdateAgentConfigTool  = registry.getTool('memory:updateAgentConfig');
    GetSessionContextTool  = registry.getTool('memory:getSessionContext');
    SetSessionContextTool  = registry.getTool('memory:setSessionContext');
    UpdateSessionContextTool = registry.getTool('memory:updateSessionContext');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Integration Test Org' });
  });

  async function createAgent(name) {
    return models.Agent.create({
      organizationID: organization.id,
      name,
      pluginID:       'mock-agent',
    });
  }

  async function createSession(opts = {}) {
    return sessionManager.createSession(organization.id, opts);
  }

  function instantiateTool(ToolClass) {
    return new ToolClass({
      getProperty: (key) => {
        if (key === 'permissionEngine') return null; // bypass permissions in unit tests
        return context.getProperty(key);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Agent config: full lifecycle via tools
  // ---------------------------------------------------------------------------

  it('agent sets config via tool, reads it back, persists across re-fetch', async () => {
    let agent = await createAgent('test-integ-agent-1');

    // Set config via tool (riskLevel is stripped by stripProtectedKeys)
    let setTool = instantiateTool(SetAgentConfigTool);
    await setTool.execute({
      agentID: agent.id,
      config:  { model: 'claude-opus', abilities: { planning: true } },
    });

    // Read back via tool (getSafeConfig strips protected keys including riskLevel)
    let getTool = instantiateTool(GetAgentConfigTool);
    let result  = await getTool.execute({ agentID: agent.id });

    assert.equal(result.config.model, 'claude-opus');
    assert.deepStrictEqual(result.config.abilities, { planning: true });

    // Update partial via tool
    let updateTool = instantiateTool(UpdateAgentConfigTool);
    await updateTool.execute({
      agentID: agent.id,
      updates: { abilities: { planning: true, coding: true } },
    });

    let result2 = await getTool.execute({ agentID: agent.id });
    assert.equal(result2.config.model, 'claude-opus');
    assert.deepStrictEqual(result2.config.abilities, { planning: true, coding: true });
  });

  // ---------------------------------------------------------------------------
  // Session context: set via tool, child inherits via effective
  // ---------------------------------------------------------------------------

  it('session context set via tool, child session inherits via effective: true', async () => {
    let parent = await createSession();
    let child  = await createSession({ parentSessionID: parent.id });

    // Set parent context via tool
    let setTool = instantiateTool(SetSessionContextTool);
    await setTool.execute({
      sessionID: parent.id,
      context:   { theme: 'dark', lang: 'en' },
    });

    // Set child context via tool (override one key)
    await setTool.execute({
      sessionID: child.id,
      context:   { theme: 'light' },
    });

    // Read effective context on child
    let getTool = instantiateTool(GetSessionContextTool);
    let result  = await getTool.execute({ sessionID: child.id, effective: true });

    assert.equal(result.context.theme, 'light', 'child overrides parent');
    assert.equal(result.context.lang, 'en', 'inherited from parent');
  });

  // ---------------------------------------------------------------------------
  // Protected keys never leak through tool responses
  // ---------------------------------------------------------------------------

  it('protected keys never leak through tool responses even when stored in DB', async () => {
    let agent = await createAgent('test-integ-agent-leak');

    // Store protected keys directly via setConfig (bypassing stripProtectedKeys)
    await agent.setConfig({
      riskLevel:      'medium',
      apiKey:         'sk-secret-should-never-appear',
      encryptedAPIKey: '{ciphertext-should-never-appear}',
      model:          'claude-sonnet',
    });

    // Read via tool — protected keys should be stripped by getSafeConfig
    let getTool = instantiateTool(GetAgentConfigTool);
    let result  = await getTool.execute({ agentID: agent.id });

    assert.equal(result.config.riskLevel, undefined, 'riskLevel is now a protected key');
    assert.equal(result.config.model, 'claude-sonnet');
    assert.equal(result.config.apiKey, undefined, 'apiKey must not leak');
    assert.equal(result.config.encryptedAPIKey, undefined, 'encryptedAPIKey must not leak');

    // Also verify set tool strips them on write
    let setTool = instantiateTool(SetAgentConfigTool);
    await setTool.execute({
      agentID: agent.id,
      config:  { apiKey: 'sk-evil', encryptedAPIKey: '{evil}', custom: 'allowed' },
    });

    let { Agent: AgentModel } = models;
    let fetched    = await AgentModel.where.id.EQ(agent.id).first();
    let fullConfig = await fetched.getConfig();
    assert.equal(fullConfig.apiKey, undefined, 'apiKey should not be stored via tool');
    assert.equal(fullConfig.encryptedAPIKey, undefined, 'encryptedAPIKey should not be stored via tool');
    assert.equal(fullConfig.custom, 'allowed');
  });

  // ---------------------------------------------------------------------------
  // UTF8 content round-trips through full stack
  // ---------------------------------------------------------------------------

  it('UTF8 content round-trips through full stack (agent config)', async () => {
    let agent = await createAgent('test-integ-utf8-agent');

    let setTool = instantiateTool(SetAgentConfigTool);
    await setTool.execute({
      agentID: agent.id,
      config:  { greeting: '你好世界 🌍', instructions: 'こんにちは' },
    });

    let getTool = instantiateTool(GetAgentConfigTool);
    let result  = await getTool.execute({ agentID: agent.id });

    assert.equal(result.config.greeting, '你好世界 🌍');
    assert.equal(result.config.instructions, 'こんにちは');
  });

  it('UTF8 content round-trips through full stack (session context)', async () => {
    let session = await createSession();

    let setTool = instantiateTool(SetSessionContextTool);
    await setTool.execute({
      sessionID: session.id,
      context:   { emoji: '🚀🎉💡', korean: '안녕하세요' },
    });

    let getTool = instantiateTool(GetSessionContextTool);
    let result  = await getTool.execute({ sessionID: session.id });

    assert.equal(result.context.emoji, '🚀🎉💡');
    assert.equal(result.context.korean, '안녕하세요');
  });

  // ---------------------------------------------------------------------------
  // Plugin registers all 9 tools
  // ---------------------------------------------------------------------------

  it('memory plugin registers exactly 9 tools', () => {
    let tools = registry.getTools();
    let memoryTools = [...tools.keys()].filter((k) => k.startsWith('memory:'));
    assert.equal(memoryTools.length, 9);
    assert.deepStrictEqual(memoryTools.sort(), [
      'memory:getAgentConfig',
      'memory:getSessionContext',
      'memory:getValue',
      'memory:searchValues',
      'memory:setAgentConfig',
      'memory:setSessionContext',
      'memory:setValue',
      'memory:updateAgentConfig',
      'memory:updateSessionContext',
    ]);
  });
});
