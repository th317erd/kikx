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
    config: { model: 'sonnet' },
    secretState: {
      apiKey: { present: true, last4: '1234' },
    },
    enabled: true,
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
