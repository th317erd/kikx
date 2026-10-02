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
        character: '',
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
        character: agent.character,
        characterCompressed: agent.characterCompressed,
        config: agent.config,
        secretState: agent.secretState,
        enabled: agent.enabled,
      };
    },
    async listAgents() {
      return [ ...agents.values() ];
    },
    async getAgent(agentID, options = {}) {
      if (options.includeSecrets)
        return agents.get(agentID);

      let agent = agents.get(agentID);
      if (!agent)
        return agent;

      let { secrets: _secrets, ...sanitized } = agent;
      return sanitized;
    },
    async findAgentByIDOrName(reference) {
      let lowered = reference.toLowerCase();
      return agents.get(reference) || [ ...agents.values() ].find((agent) => agent.name.toLowerCase() === lowered) || null;
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

test('AgentManager lists plugin-registered agent providers', async () => {
  let manager = createManager();

  assert.deepEqual(await manager.listProviders(), [
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
    character: 'You are a pragmatic engineer.',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });

  assert.equal(agent.name, 'Coder');
  assert.equal(agent.pluginID, 'test-agent');
  assert.equal(agent.character, 'You are a pragmatic engineer.');
  assert.deepEqual(agent.config, { model: 'sonnet' });
  assert.deepEqual(agent.secretState, {
    apiKey: { present: true, last4: '1234' },
  });
  assert.equal(agent.secrets, undefined);
});

test('AgentManager creates agents using dynamically resolved plugin fields', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });

  class DynamicProvider extends AgentInterface {
    static pluginID = 'dynamic-agent';
    static displayName = 'Dynamic Agent';

    static async resolveConfigFields() {
      return [
        { name: 'model', type: 'select', required: true },
        { name: 'apiKey', secret: true },
      ];
    }
  }

  pluginRegistry.registerAgentProvider('dynamic-agent', DynamicProvider);

  let manager = new AgentManager({ pluginRegistry, agentStore: createStore() });
  let agent = await manager.createAgent({
    name: 'Dynamic',
    pluginID: 'dynamic-agent',
    config: { model: 'live-model' },
    secrets: { apiKey: 'sk-dynamic-9999' },
  });

  assert.deepEqual(agent.config, { model: 'live-model' });

  await assert.rejects(
    () => manager.createAgent({ name: 'Bad', pluginID: 'dynamic-agent', config: { unknown: 1 } }),
    /Unknown config field/,
  );
});

test('AgentManager runs provider validateCreateAgent and rejects on its error', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  let calls = [];

  class ConditionalProvider extends AgentInterface {
    static pluginID = 'conditional-agent';

    static configFields = [
      { name: 'baseUrl', type: 'text' },
      { name: 'apiKey', secret: true },
    ];

    static async validateCreateAgent({ config }) {
      calls.push(config);
      if (config.baseUrl !== 'http://127.0.0.1:8090')
        throw new Error('apiKey is required for the default endpoint');
    }
  }

  pluginRegistry.registerAgentProvider('conditional-agent', ConditionalProvider);
  let manager = new AgentManager({ pluginRegistry, agentStore: createStore() });

  await assert.rejects(
    () => manager.createAgent({ name: 'A', pluginID: 'conditional-agent', config: {}, secrets: {} }),
    /apiKey is required for the default endpoint/,
  );

  let agent = await manager.createAgent({
    name: 'Local',
    pluginID: 'conditional-agent',
    config: { baseUrl: 'http://127.0.0.1:8090' },
    secrets: {},
  });
  assert.equal(agent.config.baseUrl, 'http://127.0.0.1:8090');
  assert.deepEqual(calls, [{}, { baseUrl: 'http://127.0.0.1:8090' }]);
});

test('AgentManager rejects agent creation when provider config resolution fails', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });

  class BrokenProvider extends AgentInterface {
    static pluginID = 'broken-agent';

    static async resolveConfigFields() {
      throw new Error('discovery unavailable');
    }
  }

  pluginRegistry.registerAgentProvider('broken-agent', BrokenProvider);

  let manager = new AgentManager({ pluginRegistry, agentStore: createStore() });

  await assert.rejects(
    () => manager.createAgent({ name: 'Broken', pluginID: 'broken-agent' }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /Unable to resolve provider configuration/);
      return true;
    },
  );
});

test('AgentManager updates persistent agent character outside plugin config', async () => {
  let manager = createManager();

  let agent = await manager.createAgent({
    name: 'Coder',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });
  let updated = await manager.updateAgentCharacter(
    agent.id,
    'You are a dirty swearing pirate and fantastic engineer.',
    'Pirate engineer; direct and technical.',
  );

  assert.equal(updated.id, agent.id);
  assert.equal(updated.character, 'You are a dirty swearing pirate and fantastic engineer.');
  assert.equal(updated.characterCompressed, 'Pirate engineer; direct and technical.');
  assert.deepEqual(updated.config, { model: 'sonnet' });

  await assert.rejects(
    () => manager.updateAgentCharacter(agent.id, ''),
    /character must be a non-empty string/,
  );

  await assert.rejects(
    () => manager.updateAgentCharacter(agent.id, 'You are terse.', 'x'.repeat(401)),
    /characterCompressed must be 400 characters or fewer/,
  );
});

test('AgentManager persists a compressed character through create and update', async () => {
  let manager = createManager();

  let agent = await manager.createAgent({
    name: 'Coder',
    pluginID: 'test-agent',
    character: 'You are a pragmatic engineer.',
    characterCompressed: 'Pragmatic engineer.',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });
  assert.equal(agent.characterCompressed, 'Pragmatic engineer.');

  let updated = await manager.updateAgent(agent.id, {
    character: 'You are a skeptical reviewer.',
    characterCompressed: 'Skeptical reviewer.',
  });
  assert.equal(updated.character, 'You are a skeptical reviewer.');
  assert.equal(updated.characterCompressed, 'Skeptical reviewer.');

  await assert.rejects(
    () => manager.createAgent({
      name: 'Bad',
      pluginID: 'test-agent',
      character: 'Terse.',
      characterCompressed: 'x'.repeat(401),
      config: { model: 'sonnet' },
      secrets: { apiKey: 'sk' },
    }),
    /characterCompressed must be 400 characters or fewer/,
  );
});

test('AgentManager passes read options through to the agent store', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentProvider('test-agent', TestAgentProvider);
  let calls = [];
  let manager = new AgentManager({
    pluginRegistry,
    agentStore: {
      async getAgent(agentID, options) {
        calls.push({ agentID, options });
        return {
          id: agentID,
          name: 'Coder',
          pluginID: 'test-agent',
          config: {},
          secrets: { apiKey: 'sk-test' },
        };
      },
    },
  });

  let agent = await manager.getAgent('agent_1', { includeSecrets: true });

  assert.equal(agent.secrets.apiKey, 'sk-test');
  assert.deepEqual(calls, [{
    agentID: 'agent_1',
    options: { includeSecrets: true },
  }]);
});

test('AgentManager resolves agents by id or exact name', async () => {
  let manager = createManager();

  await manager.createAgent({
    name: 'Coder',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });
  await manager.createAgent({
    name: 'Test 1',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-5678' },
  });

  assert.equal((await manager.resolveAgent('agent_1')).id, 'agent_1');
  assert.equal((await manager.resolveAgent('coder')).id, 'agent_1');
  assert.equal((await manager.resolveAgent('Test 1')).id, 'agent_2');

  await assert.rejects(
    () => manager.resolveAgent('missing-agent'),
    /Agent not found/,
  );
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

  await assert.rejects(
    () => manager.createAgent({
      name: 'Bad',
      pluginID: 'test-agent',
      character: {},
      config: { model: 'sonnet' },
      secrets: { apiKey: 'sk' },
    }),
    /character must be a string/,
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

test('AgentManager crowns agents and resolves the default master agent in order', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentProvider('test-agent', TestAgentProvider);

  // Minimal store implementing the master-agent surface.
  let masters = [
    { id: 'agent_1', name: 'Master One', pluginID: 'test-agent', enabled: true, crownedClock: '0002', crownedAt: 2 },
    { id: 'agent_2', name: 'Master Two', pluginID: 'test-agent', enabled: true, crownedClock: '0001', crownedAt: 1 },
    { id: 'agent_3', name: 'Master Three', pluginID: 'test-agent', enabled: true, crownedClock: '0000', crownedAt: 0 },
  ];
  let crownCalls = [];
  let store = {
    async createAgent() { throw new Error('unused'); },
    async getAgent() { return null; },
    async updateAgent() { throw new Error('unused'); },
    async setAgentCrowned(agentID, crowned) {
      crownCalls.push({ agentID, crowned });
      return { id: agentID, crownedClock: crowned ? '0009' : null, crownedAt: crowned ? 9 : null };
    },
    async listMasterAgents() { return masters; },
  };

  let manager = new AgentManager({ pluginRegistry, agentStore: store });

  await manager.setAgentCrowned('agent_2', true);
  assert.deepEqual(crownCalls, [ { agentID: 'agent_2', crowned: true } ]);

  assert.deepEqual((await manager.listMasterAgents()).map((agent) => agent.name), [ 'Master One', 'Master Two', 'Master Three' ]);

  // Default = master #1.
  assert.equal((await manager.resolveDefaultAgent()).id, 'agent_1');
  // Excluding #1 falls back to master #2, then #3.
  assert.equal((await manager.resolveDefaultAgent({ excludeAgentIDs: [ 'agent_1' ] })).id, 'agent_2');
  assert.equal((await manager.resolveDefaultAgent({ excludeAgentIDs: [ 'agent_1', 'agent_2' ] })).id, 'agent_3');
  // All excluded => null.
  assert.equal(await manager.resolveDefaultAgent({ excludeAgentIDs: [ 'agent_1', 'agent_2', 'agent_3' ] }), null);
});

test('AgentManager skips disabled master agents when resolving the default', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentProvider('test-agent', TestAgentProvider);

  let store = {
    async listMasterAgents() {
      return [
        { id: 'agent_1', name: 'Disabled Master', pluginID: 'test-agent', enabled: false, crownedClock: '0002' },
        { id: 'agent_2', name: 'Enabled Master', pluginID: 'test-agent', enabled: true, crownedClock: '0001' },
      ];
    },
  };

  let manager = new AgentManager({ pluginRegistry, agentStore: store });
  assert.equal((await manager.resolveDefaultAgent()).id, 'agent_2');
});

test('AgentManager manages compaction bots independently of masters', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentProvider('test-agent', TestAgentProvider);

  // Store exposing the parallel compaction-bot surface; master list is separate.
  let masters = [
    { id: 'agent_1', name: 'Master One', pluginID: 'test-agent', enabled: true, crownedClock: '0002' },
  ];
  let storageBots = [
    { id: 'bot_1', name: 'Bot One', pluginID: 'test-agent', enabled: true, compactionCrownedClock: '0002' },
    { id: 'bot_2', name: 'Bot Two', pluginID: 'test-agent', enabled: true, compactionCrownedClock: '0001' },
  ];
  let calls = [];
  let store = {
    async setAgentCompactionBotCrowned(agentID, crowned) {
      calls.push({ method: 'setAgentCompactionBotCrowned', agentID, crowned });
      return { id: agentID, name: 'Bot', pluginID: 'test-agent', compactionCrownedClock: crowned ? '0009' : null, compactionCrownedAt: crowned ? 9 : null };
    },
    async listCompactionBots() { return storageBots; },
    async listMasterAgents() { return masters; },
  };

  let manager = new AgentManager({ pluginRegistry, agentStore: store });

  // The snapshot is empty until a toggle or refresh populates it.
  assert.deepEqual(manager.listCompactionBots(), []);

  let toggled = await manager.setAgentCompactionBotCrowned('bot_1', true);
  assert.equal(toggled.compactionCrownedClock, '0009');
  assert.deepEqual(calls, [ { method: 'setAgentCompactionBotCrowned', agentID: 'bot_1', crowned: true } ]);

  // Synchronous snapshot now reflects the store list, #1 first.
  assert.deepEqual(manager.listCompactionBots().map((agent) => agent.name), [ 'Bot One', 'Bot Two' ]);
  // Synchronous limit narrows the snapshot.
  assert.deepEqual(manager.listCompactionBots({ limit: 1 }).map((agent) => agent.id), [ 'bot_1' ]);

  // Master list is untouched by compaction-bot work.
  assert.deepEqual((await manager.listMasterAgents()).map((agent) => agent.name), [ 'Master One' ]);

  // resolveCompactionBot returns the first enabled, non-excluded bot.
  assert.equal((await manager.resolveCompactionBot()).id, 'bot_1');
  assert.equal((await manager.resolveCompactionBot({ excludeAgentIDs: [ 'bot_1' ] })).id, 'bot_2');
  assert.equal(await manager.resolveCompactionBot({ excludeAgentIDs: [ 'bot_1', 'bot_2' ] }), null);
});

test('AgentManager.resolveCompactionBot skips disabled bots', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentProvider('test-agent', TestAgentProvider);

  let store = {
    async listCompactionBots() {
      return [
        { id: 'bot_1', name: 'Disabled', pluginID: 'test-agent', enabled: false, compactionCrownedClock: '0002' },
        { id: 'bot_2', name: 'Enabled', pluginID: 'test-agent', enabled: true, compactionCrownedClock: '0001' },
      ];
    },
  };

  let manager = new AgentManager({ pluginRegistry, agentStore: store });
  assert.equal((await manager.resolveCompactionBot()).id, 'bot_2');
});

test('AgentManager.listModels aggregates provider model manifests tagged by pluginID', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });

  class ProviderA extends AgentInterface {
    static pluginID = 'provider-a';
    static getModels() {
      return [ { id: 'a-1', contextWindow: 128000, displayName: 'A One' } ];
    }
  }

  class ProviderB extends AgentInterface {
    static pluginID = 'provider-b';
    static getModels() {
      throw new Error('manifest unavailable');
    }
  }

  class ProviderC extends AgentInterface {
    static pluginID = 'provider-c';
    static getModels() {
      return [ { id: 'c-1', displayName: 'C One' }, { id: 'c-2', displayName: 'C Two' } ];
    }
  }

  pluginRegistry.registerAgentProvider('provider-a', ProviderA);
  pluginRegistry.registerAgentProvider('provider-b', ProviderB);
  pluginRegistry.registerAgentProvider('provider-c', ProviderC);

  let manager = new AgentManager({ pluginRegistry, agentStore: createStore() });
  let models = manager.listModels();

  assert.deepEqual(models.map((model) => `${model.pluginID}:${model.id}`).sort(), [
    'provider-a:a-1',
    'provider-c:c-1',
    'provider-c:c-2',
  ]);
  assert.equal(models.find((model) => model.id === 'a-1').contextWindow, 128000);
});
