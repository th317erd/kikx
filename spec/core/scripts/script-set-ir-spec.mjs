'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../../../src/core/agents/agent-manager.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { setAgentBehaviorScript } from '../../../src/core/plugins/agent-loop-tools.mjs';

// P5(a) wiring (plan §12.2(5), §7 P5): script-set accepts compiled IR,
// validates it structurally, and stores {source, IR, compiledAt}. Legacy
// text-only sets keep working AND clear any stale IR (text is authoritative;
// IR must be recompiled whenever the source changes).

const VALID_IR = {
  version: 1,
  events: { endTurn: { say: 'execution incomplete — ask with question-create, then continue' } },
  phases: [
    {
      id: 'p1',
      branch: [ { when: 'always', then: [ { goto: 'p1' } ] } ],
    },
  ],
};

const INVALID_IR = {
  version: 1,
  events: { endTurn: { say: 'execution incomplete' } },
  phases: [
    {
      id: 'p1',
      branch: [ { when: 'always', then: [ { goto: 'nope' } ] } ],
    },
  ],
};

class IRTestProvider extends AgentInterface {
  static pluginID = 'ir-test';
  static displayName = 'IR Test';
  static description = 'Provider for script-set IR wiring tests';
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
  pluginRegistry.registerAgentProvider('ir-test', IRTestProvider);
  return new AgentManager({
    pluginRegistry,
    agentStore: createMemoryStore(),
  });
}

test('updateAgentScript stores validated IR with compiledAt', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({ name: 'Scripted', pluginID: 'ir-test' });

  await manager.updateAgentScript(agent.id, 'SCRIPT v1', { ir: VALID_IR, compiledAt: '2026-11-17T00:00:00.000Z' });

  let stored = await manager.getAgent(agent.id);
  assert.equal(stored.behaviorScript, 'SCRIPT v1');
  assert.deepEqual(stored.behaviorScriptIR, VALID_IR);
  assert.equal(stored.behaviorScriptCompiledAt, '2026-11-17T00:00:00.000Z');
});

test('text-only script-set clears stale IR (recompile required)', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({ name: 'Scripted', pluginID: 'ir-test' });

  await manager.updateAgentScript(agent.id, 'SCRIPT v1', { ir: VALID_IR });
  await manager.updateAgentScript(agent.id, 'SCRIPT v2');

  let stored = await manager.getAgent(agent.id);
  assert.equal(stored.behaviorScript, 'SCRIPT v2');
  assert.equal(stored.behaviorScriptIR, null);
  assert.equal(stored.behaviorScriptCompiledAt, null);
});

test('invalid IR is rejected at the manager and the record is unchanged', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({ name: 'Scripted', pluginID: 'ir-test' });
  await manager.updateAgentScript(agent.id, 'SCRIPT v1', { ir: VALID_IR });

  await assert.rejects(
    () => manager.updateAgentScript(agent.id, 'SCRIPT v2', { ir: INVALID_IR }),
    /rejected.*unknown label/i,
  );

  let stored = await manager.getAgent(agent.id);
  assert.equal(stored.behaviorScript, 'SCRIPT v1');
  assert.deepEqual(stored.behaviorScriptIR, VALID_IR);
});

test('script-set tool passes IR through and reports validation', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({ name: 'Scripted', pluginID: 'ir-test' });
  let context = { services: { agentManager: manager }, agent: { id: agent.id } };

  let result = await setAgentBehaviorScript(
    { behaviorScript: 'SCRIPT v1', ir: VALID_IR, compiledAt: '2026-11-17T01:02:03.000Z' },
    context,
  );

  assert.equal(result.action, 'script-set');
  assert.equal(result.content.irValidated, true);
  assert.equal(result.content.behaviorScriptCompiledAt, '2026-11-17T01:02:03.000Z');

  let stored = await manager.getAgent(agent.id);
  assert.deepEqual(stored.behaviorScriptIR, VALID_IR);
  assert.equal(context.agent.behaviorScript, 'SCRIPT v1');
});

test('script-set tool refuses invalid IR with a validation message', async () => {
  let manager = createManager();
  let agent = await manager.createAgent({ name: 'Scripted', pluginID: 'ir-test' });
  let context = { services: { agentManager: manager }, agent: { id: agent.id } };

  await assert.rejects(
    () => setAgentBehaviorScript({ behaviorScript: 'SCRIPT v1', ir: INVALID_IR }, context),
    /rejected.*unknown label/i,
  );

  let stored = await manager.getAgent(agent.id);
  assert.equal(stored.behaviorScript, '');
});
