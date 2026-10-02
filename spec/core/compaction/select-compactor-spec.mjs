'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTOR_REASON,
  selectCompactor,
} from '../../../src/core/compaction/index.mjs';

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

test('selectCompactor skips rung 2 when no compaction-bot list exists (P3 pending)', () => {
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

function participants(...windows) {
  return windows.map((window, index) => ({
    id: String.fromCharCode(97 + index),
    window,
  }));
}
