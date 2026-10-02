'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTOR_REASON,
  selectCompactor,
} from '../../../src/core/compaction/index.mjs';
import { AeorDBAgentStore } from '../../../src/core/aeordb/aeordb-agent-store.mjs';
import { AgentManager } from '../../../src/core/agents/agent-manager.mjs';

test('selectCompactor rung 1 prefers the session compaction bot', () => {
  let result = selectCompactor({
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'a', 'b', 'c' ],
      compactionAgentID: 'b',
      coordinatorAgentID: 'a',
    },
    participantAgentsWithMeta: participants(100000, 200000, 300000),
  });

  assert.deepEqual(result, { agentID: 'b', reason: COMPACTOR_REASON.SESSION });
});

test('selectCompactor ignores a session compaction bot that is not a participant', () => {
  let result = selectCompactor({
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'a', 'b' ],
      compactionAgentID: 'outsider',
    },
    participantAgentsWithMeta: participants(100000, 200000),
  });

  assert.equal(result.agentID, 'b');
  assert.equal(result.reason, COMPACTOR_REASON.LARGEST);
});

test('selectCompactor rung 2 uses a designated compaction bot that is a participant', () => {
  let result = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ 'a', 'b', 'c' ] },
    participantAgentsWithMeta: participants(100000, 200000, 300000),
    agentManager: {
      listCompactionBots() {
        return [ { id: 'outsider' }, { id: 'c' } ];
      },
    },
  });

  assert.deepEqual(result, { agentID: 'c', reason: COMPACTOR_REASON.DESIGNATED });
});

test('selectCompactor skips rung 2 when the manager exposes no compaction-bot list', () => {
  let result = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ 'a', 'b' ], coordinatorAgentID: 'a' },
    participantAgentsWithMeta: participants(100000, 200000),
    agentManager: {},
  });

  assert.deepEqual(result, { agentID: 'a', reason: COMPACTOR_REASON.COORDINATOR });
});

test('selectCompactor rung 3 falls back to the explicit coordinator when it is smaller than another participant', () => {
  let result = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ 'coord', 'big' ], coordinatorAgentID: 'coord' },
    participantAgentsWithMeta: [
      { id: 'coord', window: 32768 },
      { id: 'big', window: 200000 },
    ],
  });

  assert.deepEqual(result, { agentID: 'coord', reason: COMPACTOR_REASON.COORDINATOR });
});

test('selectCompactor does not treat the implicit first-participant coordinator as a designation', () => {
  let result = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ 'a', 'b' ] },
    participantAgentsWithMeta: participants(50000, 200000),
  });

  assert.deepEqual(result, { agentID: 'b', reason: COMPACTOR_REASON.LARGEST });
});

test('selectCompactor rung 4 picks the participant with the largest effective window', () => {
  let result = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ 'a', 'b', 'c' ] },
    participantAgentsWithMeta: participants(50000, 400000, 120000),
  });

  assert.deepEqual(result, { agentID: 'b', reason: COMPACTOR_REASON.LARGEST });
});

test('selectCompactor largest-window tie breaks by participant order', () => {
  let result = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ 'a', 'b', 'c' ] },
    participantAgentsWithMeta: participants(200000, 200000, 100000),
  });

  assert.deepEqual(result, { agentID: 'a', reason: COMPACTOR_REASON.LARGEST });
});

test('selectCompactor resolves windows from provider config when meta omits one', () => {
  let result = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ 'a', 'b' ] },
    participantAgentsWithMeta: [
      { agent: { id: 'a', pluginID: 'p', config: { contextWindowTokens: 30000 } } },
      { agent: { id: 'b', pluginID: 'p', config: { contextWindowTokens: 90000 } } },
    ],
  });

  assert.deepEqual(result, { agentID: 'b', reason: COMPACTOR_REASON.LARGEST });
});

test('selectCompactor returns null when there are no participants', () => {
  assert.deepEqual(selectCompactor({ session: { id: 'ses_1' } }), { agentID: null, reason: null });
});

test('selectCompactor rung 2 picks a real designated compaction bot end-to-end', async () => {
  // Real store + manager: designate a compaction bot, then confirm rung 2 wins
  // over a larger-window participant and stays independent of the crown.
  let tick = 0;
  let logicalClock = {
    tick() {
      tick++;
      return { at: 7_000_000 + tick, clock: `${String(7_000_000 + tick).padStart(16, '0')}-000000-e2e` };
    },
  };
  let store = new AeorDBAgentStore({ aeordb: createStoreClient(), logicalClock });
  let pluginRegistry = {
    getAgentProvider() { return null; },
    getAgentProviders() { return new Map(); },
    listAgentProviderDescriptors() { return []; },
  };
  let manager = new AgentManager({ pluginRegistry, agentStore: store });

  let small = await store.createAgent({ name: 'Small', pluginID: 'test' });
  let large = await store.createAgent({ name: 'Large', pluginID: 'test' });

  // Crown the large agent as a master only; that must NOT make it a compactor.
  await store.setAgentCrowned(large.id, true);
  await manager.refreshCompactionBots();
  assert.deepEqual(manager.listCompactionBots(), []);

  // Designate the SMALL agent as a compaction bot; it should win despite the
  // larger-window participant.
  await manager.setAgentCompactionBotCrowned(small.id, true);

  let decision = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ small.id, large.id ] },
    participantAgentsWithMeta: [
      { id: small.id, window: 32768 },
      { id: large.id, window: 400000 },
    ],
    agentManager: manager,
  });

  assert.deepEqual(decision, { agentID: small.id, reason: COMPACTOR_REASON.DESIGNATED });

  // Clearing the designation restores the largest-window fallback (the crown on
  // `large` is still irrelevant to compaction selection).
  await manager.setAgentCompactionBotCrowned(small.id, false);
  let fallback = selectCompactor({
    session: { id: 'ses_1', participantAgentIDs: [ small.id, large.id ] },
    participantAgentsWithMeta: [
      { id: small.id, window: 32768 },
      { id: large.id, window: 400000 },
    ],
    agentManager: manager,
  });
  assert.deepEqual(fallback, { agentID: large.id, reason: COMPACTOR_REASON.LARGEST });
});

function createStoreClient() {
  return {
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
    async fetchFiles(paths) {
      let output = {};
      for (let path of paths)
        output[path] = { path, content: JSON.stringify(this.files.get(path)) };

      return output;
    },
    async listDirectory(path, options) {
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let regex = options?.glob === '*/agent.json' ? /^\/kikx\/agents\/[^/]+\/agent\.json$/ : null;
      return {
        items: [ ...this.files.keys() ]
          .filter((filePath) => filePath.startsWith(prefix))
          .filter((filePath) => !regex || regex.test(filePath))
          .map((filePath) => ({ path: filePath })),
      };
    },
  };
}

function participants(...windows) {
  return windows.map((window, index) => ({
    id: String.fromCharCode(97 + index),
    window,
  }));
}
