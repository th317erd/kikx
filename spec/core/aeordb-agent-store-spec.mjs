'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AeorDBAgentStore } from '../../src/core/aeordb/aeordb-agent-store.mjs';

function createClient() {
  return {
    calls: [],
    files: new Map(),
    async putFile(path, body) {
      this.calls.push({ method: 'putFile', path, body });
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      this.calls.push({ method: 'getFile', path });
      return this.files.get(path) || null;
    },
    async fetchFiles(paths, options) {
      this.calls.push({ method: 'fetchFiles', paths, options });
      let output = {};
      for (let path of paths) {
        if (!this.files.has(path)) {
          let error = new Error(`missing: ${path}`);
          error.status = 404;
          throw error;
        }

        output[path] = {
          path,
          content: JSON.stringify(this.files.get(path)),
        };
      }

      return output;
    },
    async deleteFile(path) {
      this.calls.push({ method: 'deleteFile', path });
      this.files.delete(path);
      return { path };
    },
    async listDirectory(path, options) {
      this.calls.push({ method: 'listDirectory', path, options });
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let regex = null;
      if (options?.glob === '*/agent.json')
        regex = /^\/kikx\/agents\/[^/]+\/agent\.json$/;
      else if (options?.glob === '*.json')
        regex = new RegExp(`^${escapeRegex(prefix)}[^/]+\\.json$`);

      return {
        items: [ ...this.files.keys() ]
          .filter((filePath) => filePath.startsWith(prefix))
          .filter((filePath) => !regex || regex.test(filePath))
          .map((filePath) => ({ path: filePath })),
      };
    },
    async queryFiles(query) {
      this.calls.push({ method: 'queryFiles', query });
      let prefix = `${query.path.replace(/\/+$/g, '')}/`;
      let matches = [];

      for (let [filePath, body] of this.files.entries()) {
        if (!filePath.startsWith(prefix))
          continue;

        if (query.where?.field === 'nameKey' && query.where?.op === 'eq' && body.nameKey === query.where.value)
          matches.push({ path: filePath });
      }

      return { results: matches.slice(0, query.limit || matches.length) };
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('AeorDBAgentStore persists plugin-owned agent config and sanitizes secrets', async () => {
  let aeordb = createClient();
  let store = new AeorDBAgentStore({
    aeordb,
    clock: () => 1000,
    idGenerator: () => 'agent_1',
  });

  let agent = await store.createAgent({
    name: 'Coder',
    pluginID: 'test-agent',
    character: 'You are a careful engineering partner.',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });

  assert.deepEqual(agent, {
    id: 'agent_1',
    name: 'Coder',
    pluginID: 'test-agent',
    character: 'You are a careful engineering partner.',
    characterCompressed: '',
    config: { model: 'sonnet' },
    secretState: {
      apiKey: { present: true, last4: '1234' },
    },
    enabled: true,
    crownedAt: null,
    crownedClock: null,
    compactionCrownedAt: null,
    compactionCrownedClock: null,
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(aeordb.files.get('/kikx/agents/agent_1/agent.json').secrets.apiKey, 'sk-secret-1234');
  assert.equal(aeordb.files.get('/kikx/agents/agent_1/agent.json').character, 'You are a careful engineering partner.');
  assert.equal(aeordb.files.get('/kikx/agents/agent_1/agent.json').nameKey, 'coder');
  assert.ok([ ...aeordb.files.keys() ].some((path) => path.startsWith('/kikx/agent-name-lookup/') && path.endsWith('/agent_1.json')));
  assert.equal(aeordb.calls[0].path, '/kikx/agents/.aeordb-config/indexes.json');
});

test('AeorDBAgentStore lists, updates, and deletes agents', async () => {
  let aeordb = createClient();
  let store = new AeorDBAgentStore({
    aeordb,
    clock: (() => {
      let now = 1000;
      return () => now++;
    })(),
    idGenerator: () => 'agent_1',
  });

  await store.createAgent({
    name: 'Coder',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });
  let updated = await store.updateAgent('agent_1', {
    name: 'Reviewer',
    character: 'You are a skeptical reviewer.',
    config: { model: 'opus' },
    secrets: { apiKey: 'sk-secret-9999' },
  });

  assert.equal(updated.name, 'Reviewer');
  assert.equal(updated.character, 'You are a skeptical reviewer.');
  assert.deepEqual(updated.config, { model: 'opus' });
  assert.deepEqual(updated.secretState.apiKey, { present: true, last4: '9999' });
  assert.equal([ ...aeordb.files.values() ].filter((value) => value?.agentID === 'agent_1').length, 1);
  assert.equal([ ...aeordb.files.values() ].find((value) => value?.agentID === 'agent_1')?.name, 'Reviewer');
  assert.deepEqual((await store.listAgents()).map((agent) => agent.id), [ 'agent_1' ]);
  assert.ok(aeordb.calls.some((call) => call.method === 'fetchFiles' && call.paths.includes('/kikx/agents/agent_1/agent.json')));

  await store.deleteAgent('agent_1');
  assert.equal(await store.loadAgent('agent_1'), null);
  assert.equal([ ...aeordb.files.values() ].some((value) => value?.agentID === 'agent_1'), false);
});

test('AeorDBAgentStore resolves agents by direct id or exact name lookup', async () => {
  let aeordb = createClient();
  let ids = [ 'agent_1', 'agent_2' ];
  let store = new AeorDBAgentStore({
    aeordb,
    clock: () => 1000,
    idGenerator: () => ids.shift(),
  });

  await store.createAgent({
    name: 'Coder',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });
  await store.createAgent({
    name: 'Mr. Bennett',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-5678' },
  });

  assert.equal((await store.findAgentByIDOrName('agent_1')).name, 'Coder');
  assert.equal((await store.findAgentByIDOrName('Mr. Bennett')).id, 'agent_2');
  assert.equal((await store.findAgentByIDOrName('mr. bennett')).id, 'agent_2');
  assert.equal(await store.findAgentByIDOrName('missing'), null);
  assert.ok(aeordb.calls.some((call) => call.method === 'fetchFiles' && call.paths.includes('/kikx/agents/agent_2/agent.json')));
  assert.ok(aeordb.calls.some((call) => call.method === 'listDirectory' && call.path.startsWith('/kikx/agent-name-lookup/')));
});

test('AeorDBAgentStore falls back to bounded exact-name list lookup for legacy records', async () => {
  let aeordb = createClient();
  let store = new AeorDBAgentStore({
    aeordb,
    clock: () => 1000,
    idGenerator: () => 'agent_1',
  });
  aeordb.queryFiles = async (query) => {
    aeordb.calls.push({ method: 'queryFiles', query });
    let error = new Error('AeorDB HTTP 404');
    error.status = 404;
    throw error;
  };

  aeordb.files.set('/kikx/agents/agent_1/agent.json', {
    id: 'agent_1',
    name: 'Mr. Bennett',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });

  assert.equal((await store.findAgentByIDOrName('Mr. Bennett')).id, 'agent_1');
  assert.ok(aeordb.calls.some((call) => call.method === 'queryFiles'));
  assert.ok(aeordb.calls.some((call) => call.method === 'listDirectory' && call.options.limit === 500));
  assert.ok([ ...aeordb.files.keys() ].some((path) => path.startsWith('/kikx/agent-name-lookup/') && path.endsWith('/agent_1.json')));
});

test('AeorDBAgentStore rejects malformed agents and missing records', async () => {
  let store = new AeorDBAgentStore({ aeordb: createClient() });

  await assert.rejects(
    () => store.createAgent({ pluginID: 'test-agent', secrets: {}, config: {} }),
    /name must be a non-empty string/,
  );

  await assert.rejects(
    () => store.createAgent({
      name: 'Bad',
      pluginID: 'test-agent',
      character: {},
      secrets: {},
      config: {},
    }),
    /character must be a string/,
  );

  await assert.rejects(
    () => store.getAgent('missing'),
    /Unknown agent/,
  );
});

test('AeorDBAgentStore treats a missing agents directory as an empty list', async () => {
  let store = new AeorDBAgentStore({
    aeordb: {
      async putFile() {},
      async listDirectory() {
        let error = new Error('missing');
        error.status = 404;
        throw error;
      },
    },
  });

  assert.deepEqual(await store.listAgents(), []);
});

test('AeorDBAgentStore crowns agents and orders master agents newest-first', async () => {
  // Deterministic HLC: distinct micros per call so order is unambiguous.
  let tick = 0;
  let logicalClock = {
    tick() {
      tick++;
      return { at: 1_000_000 + tick, clock: `${String(1_000_000 + tick).padStart(16, '0')}-000000-test` };
    },
  };
  let store = new AeorDBAgentStore({ aeordb: createClient(), logicalClock });

  let a = await store.createAgent({ name: 'Alpha', pluginID: 'test' });
  let b = await store.createAgent({ name: 'Beta', pluginID: 'test' });
  let c = await store.createAgent({ name: 'Gamma', pluginID: 'test' });

  assert.equal(a.crownedAt, null);
  assert.equal(a.crownedClock, null);

  let crownedA = await store.setAgentCrowned(a.id, true);
  assert.ok(crownedA.crownedAt > 0);
  assert.match(crownedA.crownedClock, /^\d{16}-\d{6}-test$/);

  let crownedB = await store.setAgentCrowned(b.id, true);
  let crownedC = await store.setAgentCrowned(c.id, true);

  let masters = await store.listMasterAgents();
  // Newest crown first => C (#1), B (#2), A (#3).
  assert.deepEqual(masters.map((agent) => agent.name), [ 'Gamma', 'Beta', 'Alpha' ]);
  assert.ok(crownedC.crownedClock > crownedB.crownedClock);
  assert.ok(crownedB.crownedClock > crownedA.crownedClock);
});

test('AeorDBAgentStore un-crowns agents and ignores idempotent re-crown', async () => {
  let tick = 0;
  let logicalClock = {
    tick() {
      tick++;
      return { at: 2_000_000 + tick, clock: `${String(2_000_000 + tick).padStart(16, '0')}-000000-test` };
    },
  };
  let store = new AeorDBAgentStore({ aeordb: createClient(), logicalClock });
  let a = await store.createAgent({ name: 'Alpha', pluginID: 'test' });

  let first = await store.setAgentCrowned(a.id, true);
  // Re-crowning while already crowned must not move it (no new timestamp).
  let again = await store.setAgentCrowned(a.id, true);
  assert.equal(again.crownedClock, first.crownedClock);

  let uncrowned = await store.setAgentCrowned(a.id, false);
  assert.equal(uncrowned.crownedAt, null);
  assert.equal(uncrowned.crownedClock, null);
  assert.deepEqual(await store.listMasterAgents(), []);

  // Re-crowning after uncrown gets a fresh, later stamp.
  let recrowned = await store.setAgentCrowned(a.id, true);
  assert.ok(recrowned.crownedClock > first.crownedClock);
});

test('AeorDBAgentStore rejects crowning a missing agent', async () => {
  let store = new AeorDBAgentStore({
    aeordb: {
      async putFile() {},
      async getFile() {
        return null;
      },
    },
  });

  await assert.rejects(
    () => store.setAgentCrowned('missing', true),
    /Unknown agent/,
  );
});

test('AeorDBAgentStore caps masters at three, evicting the oldest crown', async () => {
  let tick = 0;
  let logicalClock = {
    tick() {
      tick++;
      return { at: 3_000_000 + tick, clock: `${String(3_000_000 + tick).padStart(16, '0')}-000000-test` };
    },
  };
  let store = new AeorDBAgentStore({ aeordb: createClient(), logicalClock });

  let agents = [];
  for (let index = 0; index < 5; index++)
    agents.push(await store.createAgent({ name: `Agent ${index}`, pluginID: 'test' }));

  for (let agent of agents)
    await store.setAgentCrowned(agent.id, true);

  let masters = await store.listMasterAgents();
  // Only the last three crowns remain, newest first: Agent 4, 3, 2.
  assert.deepEqual(masters.map((agent) => agent.name), [ 'Agent 4', 'Agent 3', 'Agent 2' ]);

  // The evicted agents are genuinely uncrowned on disk.
  let all = new Map((await store.listAgents()).map((agent) => [ agent.name, agent ]));
  assert.equal(all.get('Agent 0').crownedClock, null);
  assert.equal(all.get('Agent 1').crownedClock, null);
  assert.ok(all.get('Agent 2').crownedClock);

  // Asking for more than three still returns three.
  assert.equal((await store.listMasterAgents({ limit: 500 })).length, 3);
});

test('AeorDBAgentStore designates compaction bots and orders them newest-first', async () => {
  let tick = 0;
  let logicalClock = {
    tick() {
      tick++;
      return { at: 4_000_000 + tick, clock: `${String(4_000_000 + tick).padStart(16, '0')}-000000-cb` };
    },
  };
  let store = new AeorDBAgentStore({ aeordb: createClient(), logicalClock });

  let a = await store.createAgent({ name: 'Alpha', pluginID: 'test' });
  let b = await store.createAgent({ name: 'Beta', pluginID: 'test' });
  let c = await store.createAgent({ name: 'Gamma', pluginID: 'test' });

  assert.equal(a.compactionCrownedAt, null);
  assert.equal(a.compactionCrownedClock, null);

  await store.setAgentCompactionBotCrowned(a.id, true);
  await store.setAgentCompactionBotCrowned(b.id, true);
  let crownedC = await store.setAgentCompactionBotCrowned(c.id, true);
  assert.ok(crownedC.compactionCrownedAt > 0);
  assert.match(crownedC.compactionCrownedClock, /^\d{16}-\d{6}-cb$/);

  let bots = await store.listCompactionBots();
  assert.deepEqual(bots.map((agent) => agent.name), [ 'Gamma', 'Beta', 'Alpha' ]);

  // Idempotent re-designation keeps the order.
  await store.setAgentCompactionBotCrowned(c.id, true);
  assert.deepEqual((await store.listCompactionBots()).map((agent) => agent.name), [ 'Gamma', 'Beta', 'Alpha' ]);

  // Clearing removes it from the list and clears the fields.
  let cleared = await store.setAgentCompactionBotCrowned(c.id, false);
  assert.equal(cleared.compactionCrownedAt, null);
  assert.equal(cleared.compactionCrownedClock, null);
  assert.deepEqual((await store.listCompactionBots()).map((agent) => agent.name), [ 'Beta', 'Alpha' ]);
});

test('AeorDBAgentStore caps compaction bots at three, evicting the oldest', async () => {
  let tick = 0;
  let logicalClock = {
    tick() {
      tick++;
      return { at: 5_000_000 + tick, clock: `${String(5_000_000 + tick).padStart(16, '0')}-000000-cb` };
    },
  };
  let store = new AeorDBAgentStore({ aeordb: createClient(), logicalClock });

  let agents = [];
  for (let index = 0; index < 5; index++)
    agents.push(await store.createAgent({ name: `Agent ${index}`, pluginID: 'test' }));

  for (let agent of agents)
    await store.setAgentCompactionBotCrowned(agent.id, true);

  assert.deepEqual((await store.listCompactionBots()).map((agent) => agent.name), [ 'Agent 4', 'Agent 3', 'Agent 2' ]);

  let all = new Map((await store.listAgents()).map((agent) => [ agent.name, agent ]));
  assert.equal(all.get('Agent 0').compactionCrownedClock, null);
  assert.equal(all.get('Agent 1').compactionCrownedClock, null);
  assert.ok(all.get('Agent 2').compactionCrownedClock);
  assert.equal((await store.listCompactionBots({ limit: 500 })).length, 3);
});

test('AeorDBAgentStore keeps the crown and compaction-bot lists independent', async () => {
  let tick = 0;
  let logicalClock = {
    tick() {
      tick++;
      return { at: 6_000_000 + tick, clock: `${String(6_000_000 + tick).padStart(16, '0')}-000000-both` };
    },
  };
  let store = new AeorDBAgentStore({ aeordb: createClient(), logicalClock });

  let a = await store.createAgent({ name: 'Alpha', pluginID: 'test' });
  let b = await store.createAgent({ name: 'Beta', pluginID: 'test' });

  // Crown Alpha as a master only. The compaction-bot list must stay empty.
  await store.setAgentCrowned(a.id, true);
  assert.deepEqual((await store.listMasterAgents()).map((agent) => agent.name), [ 'Alpha' ]);
  assert.deepEqual(await store.listCompactionBots(), []);
  assert.equal((await store.getAgent(a.id)).compactionCrownedClock, null);

  // Designate Beta as a compaction bot only. The crown list must not change.
  await store.setAgentCompactionBotCrowned(b.id, true);
  assert.deepEqual((await store.listCompactionBots()).map((agent) => agent.name), [ 'Beta' ]);
  assert.deepEqual((await store.listMasterAgents()).map((agent) => agent.name), [ 'Alpha' ]);
  assert.equal((await store.getAgent(b.id)).crownedClock, null);

  // Both designations coexist on the same agent without clobbering each other.
  await store.setAgentCrowned(b.id, true);
  await store.setAgentCompactionBotCrowned(a.id, true);
  assert.deepEqual((await store.listMasterAgents()).map((agent) => agent.name).sort(), [ 'Alpha', 'Beta' ]);
  assert.deepEqual((await store.listCompactionBots()).map((agent) => agent.name).sort(), [ 'Alpha', 'Beta' ]);

  // Clearing the crown leaves the compaction-bot designation intact.
  await store.setAgentCrowned(a.id, false);
  assert.deepEqual((await store.listMasterAgents()).map((agent) => agent.name), [ 'Beta' ]);
  assert.deepEqual((await store.listCompactionBots()).map((agent) => agent.name).sort(), [ 'Alpha', 'Beta' ]);
});

test('AeorDBAgentStore rejects designating a missing compaction bot', async () => {
  let store = new AeorDBAgentStore({
    aeordb: {
      async putFile() {},
      async getFile() {
        return null;
      },
    },
  });

  await assert.rejects(
    () => store.setAgentCompactionBotCrowned('missing', true),
    /Unknown agent/,
  );
});
