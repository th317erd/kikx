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
    async deleteFile(path) {
      this.calls.push({ method: 'deleteFile', path });
      this.files.delete(path);
      return { path };
    },
    async listDirectory(path, options) {
      this.calls.push({ method: 'listDirectory', path, options });
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      return {
        items: [ ...this.files.keys() ]
          .filter((filePath) => filePath.startsWith(prefix) && filePath.endsWith('/agent.json'))
          .map((filePath) => ({ path: filePath })),
      };
    },
  };
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
    config: { model: 'sonnet' },
    secrets: { apiKey: 'sk-secret-1234' },
  });

  assert.deepEqual(agent, {
    id: 'agent_1',
    name: 'Coder',
    pluginID: 'test-agent',
    config: { model: 'sonnet' },
    secretState: {
      apiKey: { present: true, last4: '1234' },
    },
    enabled: true,
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(aeordb.files.get('/kikx/agents/agent_1/agent.json').secrets.apiKey, 'sk-secret-1234');
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
    config: { model: 'opus' },
    secrets: { apiKey: 'sk-secret-9999' },
  });

  assert.equal(updated.name, 'Reviewer');
  assert.deepEqual(updated.config, { model: 'opus' });
  assert.deepEqual(updated.secretState.apiKey, { present: true, last4: '9999' });
  assert.deepEqual((await store.listAgents()).map((agent) => agent.id), [ 'agent_1' ]);

  await store.deleteAgent('agent_1');
  assert.equal(await store.loadAgent('agent_1'), null);
});

test('AeorDBAgentStore rejects malformed agents and missing records', async () => {
  let store = new AeorDBAgentStore({ aeordb: createClient() });

  await assert.rejects(
    () => store.createAgent({ pluginID: 'test-agent', secrets: {}, config: {} }),
    /name must be a non-empty string/,
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
