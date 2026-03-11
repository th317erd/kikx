'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }   from '../../../../src/core/index.mjs';
import { PluginInterface }  from '../../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }   from '../../../../src/core/plugin-loader/registry.mjs';
import { setup }            from '../../../../src/core/internal-plugins/memory/index.mjs';

// =============================================================================
// Memory Plugin — Agent Tools Tests
// =============================================================================
// Tests for memory:getAgentConfig, memory:setAgentConfig, memory:updateAgentConfig
// =============================================================================

describe('Memory Plugin — Agent Tools', () => {
  let core;
  let models;
  let context;
  let registry;
  let organization;

  let GetAgentConfigTool;
  let SetAgentConfigTool;
  let UpdateAgentConfigTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    registry = new PluginRegistry();
    setup({
      registerTool: (name, cls) => registry.registerTool(name, cls),
      PluginInterface,
      context,
    });

    GetAgentConfigTool    = registry.getTool('memory:getAgentConfig');
    SetAgentConfigTool    = registry.getTool('memory:setAgentConfig');
    UpdateAgentConfigTool = registry.getTool('memory:updateAgentConfig');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Agent Memory Test Org' });
  });

  async function createAgent(name, extras = {}) {
    return models.Agent.create({
      organizationID: organization.id,
      name:           name,
      pluginID:       'mock-agent',
      ...extras,
    });
  }

  function instantiateTool(ToolClass) {
    return new ToolClass({
      getProperty: (key) => context.getProperty(key),
    });
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('setup()', () => {
    it('registers all 3 agent memory tools', () => {
      assert.ok(GetAgentConfigTool, 'memory:getAgentConfig should be registered');
      assert.ok(SetAgentConfigTool, 'memory:setAgentConfig should be registered');
      assert.ok(UpdateAgentConfigTool, 'memory:updateAgentConfig should be registered');
    });

    it('all tools extend PluginInterface', () => {
      assert.ok(GetAgentConfigTool.prototype instanceof PluginInterface);
      assert.ok(SetAgentConfigTool.prototype instanceof PluginInterface);
      assert.ok(UpdateAgentConfigTool.prototype instanceof PluginInterface);
    });

    it('all tools define inputSchema', () => {
      assert.ok(GetAgentConfigTool.inputSchema);
      assert.ok(SetAgentConfigTool.inputSchema);
      assert.ok(UpdateAgentConfigTool.inputSchema);
    });

    it('getAgentConfig has riskLevel low', () => {
      assert.equal(GetAgentConfigTool.riskLevel, 'low');
    });

    it('setAgentConfig has riskLevel low', () => {
      assert.equal(SetAgentConfigTool.riskLevel, 'low');
    });

    it('updateAgentConfig has riskLevel low', () => {
      assert.equal(UpdateAgentConfigTool.riskLevel, 'low');
    });
  });

  // ---------------------------------------------------------------------------
  // memory:getAgentConfig
  // ---------------------------------------------------------------------------

  describe('memory:getAgentConfig', () => {
    it('returns agent config (via getSafeConfig, no protected keys)', async () => {
      let agent = await createAgent('test-mem-get-1');
      agent.setConfig({ riskLevel: 'high', model: 'claude-sonnet' });
      await agent.save();

      let tool   = instantiateTool(GetAgentConfigTool);
      let result = await tool.execute({ agentID: agent.id });

      assert.equal(result.config.riskLevel, 'high');
      assert.equal(result.config.model, 'claude-sonnet');
    });

    it('never exposes apiKey even if present in stored config', async () => {
      let agent = await createAgent('test-mem-get-apikey');
      agent.config = JSON.stringify({ riskLevel: 'medium', apiKey: 'sk-secret-12345' });
      await agent.save();

      let tool   = instantiateTool(GetAgentConfigTool);
      let result = await tool.execute({ agentID: agent.id });

      assert.equal(result.config.apiKey, undefined);
      assert.equal(result.config.riskLevel, 'medium');
    });

    it('never exposes encryptedAPIKey', async () => {
      let agent = await createAgent('test-mem-get-encrypted');
      agent.config = JSON.stringify({ encryptedAPIKey: '{cipher}', model: 'gpt-4' });
      await agent.save();

      let tool   = instantiateTool(GetAgentConfigTool);
      let result = await tool.execute({ agentID: agent.id });

      assert.equal(result.config.encryptedAPIKey, undefined);
      assert.equal(result.config.model, 'gpt-4');
    });

    it('returns defaults when no config stored', async () => {
      let agent = await createAgent('test-mem-get-defaults');

      let tool   = instantiateTool(GetAgentConfigTool);
      let result = await tool.execute({ agentID: agent.id });

      assert.equal(result.config.riskLevel, 'medium');
    });

    it('rejects when agent not found', async () => {
      let tool = instantiateTool(GetAgentConfigTool);

      await assert.rejects(
        () => tool.execute({ agentID: 'agt_nonexistent' }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('agent'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // memory:setAgentConfig
  // ---------------------------------------------------------------------------

  describe('memory:setAgentConfig', () => {
    it('persists config and round-trips via getAgentConfig', async () => {
      let agent = await createAgent('test-mem-set-1');
      let tool  = instantiateTool(SetAgentConfigTool);

      await tool.execute({
        agentID: agent.id,
        config:  { riskLevel: 'critical', model: 'opus' },
      });

      let getTool = instantiateTool(GetAgentConfigTool);
      let result  = await getTool.execute({ agentID: agent.id });

      assert.equal(result.config.riskLevel, 'critical');
      assert.equal(result.config.model, 'opus');
    });

    it('cannot set protected keys (silently stripped)', async () => {
      let agent = await createAgent('test-mem-set-protected');
      let tool  = instantiateTool(SetAgentConfigTool);

      await tool.execute({
        agentID: agent.id,
        config:  { riskLevel: 'high', apiKey: 'sk-evil', encryptedAPIKey: '{evil}' },
      });

      // Verify via direct DB read
      let { Agent } = models;
      let fetched = await Agent.where.id.EQ(agent.id).first();
      let config  = fetched.getConfig();

      assert.equal(config.riskLevel, 'high');
      assert.equal(config.apiKey, undefined);
      assert.equal(config.encryptedAPIKey, undefined);
    });

    it('rejects when agent not found', async () => {
      let tool = instantiateTool(SetAgentConfigTool);

      await assert.rejects(
        () => tool.execute({ agentID: 'agt_nonexistent', config: { foo: 'bar' } }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('agent'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // memory:updateAgentConfig
  // ---------------------------------------------------------------------------

  describe('memory:updateAgentConfig', () => {
    it('merges partial config into existing', async () => {
      let agent = await createAgent('test-mem-update-1');
      agent.setConfig({ riskLevel: 'high', model: 'claude-sonnet' });
      await agent.save();

      let tool = instantiateTool(UpdateAgentConfigTool);
      await tool.execute({
        agentID: agent.id,
        updates: { apiUrl: 'https://api.example.com' },
      });

      let getTool = instantiateTool(GetAgentConfigTool);
      let result  = await getTool.execute({ agentID: agent.id });

      assert.equal(result.config.riskLevel, 'high');
      assert.equal(result.config.model, 'claude-sonnet');
      assert.equal(result.config.apiUrl, 'https://api.example.com');
    });

    it('cannot set protected keys', async () => {
      let agent = await createAgent('test-mem-update-protected');
      let tool  = instantiateTool(UpdateAgentConfigTool);

      await tool.execute({
        agentID: agent.id,
        updates: { apiKey: 'sk-sneaky', custom: 'allowed' },
      });

      let { Agent } = models;
      let fetched = await Agent.where.id.EQ(agent.id).first();
      let config  = fetched.getConfig();

      assert.equal(config.apiKey, undefined);
      assert.equal(config.custom, 'allowed');
    });

    it('with empty object is a no-op', async () => {
      let agent = await createAgent('test-mem-update-noop');
      agent.setConfig({ riskLevel: 'low' });
      await agent.save();

      let tool = instantiateTool(UpdateAgentConfigTool);
      await tool.execute({ agentID: agent.id, updates: {} });

      let getTool = instantiateTool(GetAgentConfigTool);
      let result  = await getTool.execute({ agentID: agent.id });

      assert.equal(result.config.riskLevel, 'low');
    });

    it('rejects when agent not found', async () => {
      let tool = instantiateTool(UpdateAgentConfigTool);

      await assert.rejects(
        () => tool.execute({ agentID: 'agt_nonexistent', updates: { foo: 'bar' } }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('agent'));
          return true;
        },
      );
    });

    it('arbitrary keys round-trip (model, apiUrl, abilities, custom blobs)', async () => {
      let agent = await createAgent('test-mem-update-arbitrary');
      let tool  = instantiateTool(UpdateAgentConfigTool);

      await tool.execute({
        agentID: agent.id,
        updates: {
          model:     'claude-opus',
          abilities: { codeReview: true, testing: true, deployment: false },
          metadata:  { version: '2.0', tags: ['stable', 'production'] },
        },
      });

      let getTool = instantiateTool(GetAgentConfigTool);
      let result  = await getTool.execute({ agentID: agent.id });

      assert.equal(result.config.model, 'claude-opus');
      assert.deepStrictEqual(result.config.abilities, { codeReview: true, testing: true, deployment: false });
      assert.deepStrictEqual(result.config.metadata, { version: '2.0', tags: ['stable', 'production'] });
    });
  });
});
