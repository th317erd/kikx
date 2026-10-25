'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../../../src/core/agents/agent-manager.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { registerBuiltInTagDefinitions, TagsStore } from '../../../src/core/tags/index.mjs';
import { FakeAeorDBClient } from '../database/fake-aeordb-client.mjs';

class PriorityAgentProvider extends AgentInterface {
  static pluginID = 'priority-agent';
  static displayName = 'Priority Agent';
  static configFields = [];
}

test('agent tags drive leadership, compaction, and OCR priority selection', async () => {
  let db = new FakeAeorDBClient();
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerAgentProvider('priority-agent', PriorityAgentProvider);
  registerBuiltInTagDefinitions(registry);
  let tagsStore = new TagsStore({ db, pluginRegistry: registry });
  let manager = new AgentManager({
    db,
    pluginRegistry: registry,
    tagsStore,
  });

  let low = await manager.createAgent({
    name: 'Low',
    pluginID: 'priority-agent',
    tags: [
      { name: 'leadership_score', value: 2 },
      { name: 'compaction_score', value: 4 },
      { name: 'ocr_score', value: 1 },
    ],
  });
  let high = await manager.createAgent({
    name: 'High',
    pluginID: 'priority-agent',
    tags: [
      { name: 'leadership_score', value: 10 },
      { name: 'compaction_score', value: 9 },
      { name: 'ocr_score', value: 8 },
    ],
  });

  assert.equal(low.tags.find((tag) => tag.name === 'ocr_score').target_id, low.id);
  assert.equal(high.tags.find((tag) => tag.name === 'leadership_score').value, 10);

  assert.equal((await manager.resolveDefaultAgent()).id, high.id);
  assert.equal((await manager.resolveCompactionBot()).id, high.id);
  assert.deepEqual((await manager.listTaggedAgents('ocr_score')).map((agent) => agent.id), [ high.id, low.id ]);

  await manager.updateAgent(high.id, {
    tags: [ { name: 'ocr_score', value: null } ],
  });
  assert.deepEqual((await manager.listTaggedAgents('ocr_score')).map((agent) => agent.id), [ low.id ]);
});

test('deleting an agent removes its tags', async () => {
  let db = new FakeAeorDBClient();
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerAgentProvider('priority-agent', PriorityAgentProvider);
  registerBuiltInTagDefinitions(registry);
  let tagsStore = new TagsStore({ db, pluginRegistry: registry });
  let manager = new AgentManager({ db, pluginRegistry: registry, tagsStore });

  let agent = await manager.createAgent({
    name: 'Delete me',
    pluginID: 'priority-agent',
    tags: [ { name: 'ocr_score', value: 5 } ],
  });

  await manager.deleteAgent(agent.id);
  assert.deepEqual((await tagsStore.listTags({ target_type: 'agent' })).tags, []);
});
