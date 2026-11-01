'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../../../src/core/agents/agent-manager.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { MAX_BEHAVIOR_SCRIPT_LENGTH } from '../../../src/core/agents/script-limits.mjs';

class ScriptTestProvider extends AgentInterface {
  static pluginID = 'script-test';
  static displayName = 'Script Test';
  static description = 'Provider for behaviorScript plumbing tests';
  static configFields = [];
}

function createMemoryStore() {
  let agents = new Map();
  return {
    async createAgent(input) {
      let id = `agent_${agents.size + 1}`;
      let agent = { id, enabled: true, createdAt: 1, updatedAt: 1, ...input };
      agents.set(id, agent);
      return agent;
    },
    async getAgent(id) {
      return agents.get(id);
    },
    async updateAgent(id, patch) {
      let agent = agents.get(id);
      if (!agent)
        throw new Error(`missing ${id}`);
      Object.assign(agent, patch, { updatedAt: 2 });
      return agent;
    },
    async listAgents() {
      return [ ...agents.values() ];
    },
  };
}

function createManager() {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentProvider('script-test', ScriptTestProvider);
  return new AgentManager({
    pluginRegistry,
    agentStore: createMemoryStore(),
  });
}

test('createAgent persists behaviorScript', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({
    name: 'Scripted',
    pluginID: 'script-test',
    behaviorScript: 'SCRIPT x\nEND',
  });
  let stored = await manager.getAgent(agent.id);
  assert.equal(stored.behaviorScript, 'SCRIPT x\nEND');
});

test('createAgent defaults behaviorScript to empty', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({ name: 'Plain', pluginID: 'script-test' });
  let stored = await manager.getAgent(agent.id);
  assert.equal(stored.behaviorScript, '');
});

test('updateAgentScript sets and clears the script', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({ name: 'Scripted', pluginID: 'script-test' });

  await manager.updateAgentScript(agent.id, 'SCRIPT loop\nEND');
  assert.equal((await manager.getAgent(agent.id)).behaviorScript, 'SCRIPT loop\nEND');

  await manager.updateAgentScript(agent.id, '');
  assert.equal((await manager.getAgent(agent.id)).behaviorScript, '');
});

test('updateAgent without behaviorScript leaves it unchanged', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({
    name: 'Scripted',
    pluginID: 'script-test',
    behaviorScript: 'SCRIPT keep\nEND',
  });

  await manager.updateAgent(agent.id, { name: 'Renamed' });
  let stored = await manager.getAgent(agent.id);
  assert.equal(stored.name, 'Renamed');
  assert.equal(stored.behaviorScript, 'SCRIPT keep\nEND');
});

test('oversized scripts are refused at the manager boundary', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({ name: 'Scripted', pluginID: 'script-test' });
  await assert.rejects(
    () => manager.updateAgentScript(agent.id, 'x'.repeat(MAX_BEHAVIOR_SCRIPT_LENGTH + 1)),
    new RegExp(`${MAX_BEHAVIOR_SCRIPT_LENGTH} characters or fewer`),
  );
});
