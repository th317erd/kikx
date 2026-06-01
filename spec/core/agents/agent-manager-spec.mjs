'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../../../src/core/agents/agent-manager.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';

class TestAgentProvider extends AgentInterface {
  static pluginID = 'test-agent';
  static displayName = 'Test Agent';
  static description = 'Provider from a plugin';
  static configFields = [
    { name: 'model', label: 'Model', required: true },
    { name: 'apiKey', label: 'API key', secret: true, required: true },
  ];
}

function createStore() {
  let agents = new Map();
  return {
    async createAgent(input) {
      let agent = {
        id: `agent_${agents.size + 1}`,
        enabled: true,
        createdAt: 1000,
        updatedAt: 1000,
        ...input,
        secretState: Object.fromEntries(Object.entries(input.secrets || {}).map(([key, value]) => [
          key,
          { present: true, last4: String(value).slice(-4) },
        ])),
      };
      agents.set(agent.id, agent);
      return {
        id: agent.id,
        name: agent.name,
        pluginID: agent.pluginID,
        config: agent.config,
        secretState: agent.secretState,
        enabled: agent.enabled,
      };
    },
    async listAgents() {
      return [ ...agents.values() ];
    },
    async getAgent(agentID) {
      return agents.get(agentID);
    },
    async updateAgent(agentID, input) {
      let next = { ...agents.get(agentID), ...input };
      agents.set(agentID, next);
      return next;
    },
    async deleteAgent(agentID) {
      agents.delete(agentID);
    },
  };
}

function createManager() {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentProvider('test-agent', TestAgentProvider);
  return new AgentManager({
    pluginRegistry,
    agentStore: createStore(),
  });
}

test('AgentManager lists plugin-registered agent providers', () => {
  let manager = createManager();

  assert.deepEqual(manager.listProviders(), [
    {
      pluginID: 'test-agent',
      agentType: 'test-agent',
      serviceType: null,
      displayName: 'Test Agent',
      description: 'Provider from a plugin',
      configFields: [
        {
          name: 'model',
          label: 'Model',
          type: 'text',
          required: true,
          secret: false,
          defaultValue: undefined,
          options: undefined,
          help: '',
        },
        {
          name: 'apiKey',
          label: 'API key',
          type: 'text',
          required: true,
          secret: true,
          defaultValue: undefined,
          options: undefined,
          help: '',
        },
      ],
    },
  ]);
});

test('AgentManager creates agents using plugin-declared fields only', async () => {
  let manager = createManager();

  let agent = await manager.createAgent({
    name: 'Coder',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });

  assert.equal(agent.name, 'Coder');
  assert.equal(agent.pluginID, 'test-agent');
  assert.deepEqual(agent.config, { model: 'sonnet' });
  assert.deepEqual(agent.secretState, {
    apiKey: { present: true, last4: '1234' },
  });
  assert.equal(agent.secrets, undefined);
});

test('AgentManager rejects unknown providers and unknown fields', async () => {
  let manager = createManager();

  await assert.rejects(
    () => manager.createAgent({ name: 'Bad', pluginID: 'missing' }),
    /Unknown agent provider/,
  );

  await assert.rejects(
    () => manager.createAgent({
      name: 'Bad',
      pluginID: 'test-agent',
      config: { model: 'sonnet', temperature: 1 },
      secrets: { apiKey: 'sk' },
    }),
    /Unknown config field/,
  );

  await assert.rejects(
    () => manager.createAgent({
      name: 'Bad',
      pluginID: 'test-agent',
      config: { model: 'sonnet' },
      secrets: { otherKey: 'sk' },
    }),
    /Unknown secret field/,
  );
});

test('AgentManager rejects missing required plugin fields on create', async () => {
  let manager = createManager();

  await assert.rejects(
    () => manager.createAgent({
      name: 'Bad',
      pluginID: 'test-agent',
      config: { model: 'sonnet' },
    }),
    /apiKey is required/,
  );
});
