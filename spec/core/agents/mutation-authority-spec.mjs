'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAgentMutationAllowed,
  checkAgentMutationAllowed,
  checkAgentMutationAllowedForSession,
} from '../../../src/core/agents/mutation-authority.mjs';

function buildTree() {
  let S1 = { id: 'S1', participantAgentIDs: [ 'boss' ], coordinatorAgentID: 'boss' };
  let S2 = { id: 'S2', parentSessionID: 'S1', participantAgentIDs: [ 'mid', 'w1' ], coordinatorAgentID: 'mid' };
  let S3 = { id: 'S3', parentSessionID: 'S2', participantAgentIDs: [ 'w2' ], coordinatorAgentID: null };
  let map = new Map([ [ 'S1', S1 ], [ 'S2', S2 ], [ 'S3', S3 ] ]);
  return { map, getSession: (id) => map.get(id) || null };
}

test('self-mutation is always allowed', () => {
  let { getSession } = buildTree();
  let result = checkAgentMutationAllowed({
    actorAgentID: 'w1',
    targetAgentID: 'w1',
    currentSessionID: 'S2',
    getSession,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'self');
});

test('coordinator mutates its in-session workers', () => {
  let { getSession } = buildTree();
  let result = checkAgentMutationAllowed({
    actorAgentID: 'mid',
    targetAgentID: 'w1',
    currentSessionID: 'S2',
    getSession,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'coordinator-descendant');
});

test('coordinator mutates workers in descendant sessions', () => {
  let { getSession } = buildTree();
  let result = checkAgentMutationAllowed({
    actorAgentID: 'mid',
    targetAgentID: 'w2',
    currentSessionID: 'S3',
    getSession,
  });
  assert.equal(result.allowed, true);
});

test('a worker may not mutate its coordinator', () => {
  let { getSession } = buildTree();
  let result = checkAgentMutationAllowed({
    actorAgentID: 'w1',
    targetAgentID: 'mid',
    currentSessionID: 'S2',
    getSession,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'not-coordinator');
});

test('a coordinator may not mutate anything upstream', () => {
  let { map, getSession } = buildTree();
  let S2WithBoss = { ...map.get('S2'), participantAgentIDs: [ 'mid', 'w1', 'boss' ] };
  map.set('S2', S2WithBoss);
  let result = checkAgentMutationAllowed({
    actorAgentID: 'mid',
    targetAgentID: 'boss',
    currentSessionID: 'S2',
    getSession,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'upstream-coordinator');
});

test('a root coordinator may mutate a lower coordinator', () => {
  let { getSession } = buildTree();
  let result = checkAgentMutationAllowed({
    actorAgentID: 'boss',
    targetAgentID: 'mid',
    currentSessionID: 'S2',
    getSession,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'coordinator-descendant');
});

test('non-participants of the current session are refused', () => {
  let { getSession } = buildTree();
  let result = checkAgentMutationAllowed({
    actorAgentID: 'mid',
    targetAgentID: 'boss',
    currentSessionID: 'S2',
    getSession,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'not-in-session');
});

test('missing agents and sessions are refused', () => {
  let { getSession } = buildTree();
  assert.equal(checkAgentMutationAllowed({ actorAgentID: '', targetAgentID: 'w1', currentSessionID: 'S2', getSession }).allowed, false);
  assert.equal(checkAgentMutationAllowed({ actorAgentID: 'mid', targetAgentID: '', currentSessionID: 'S2', getSession }).allowed, false);
  assert.equal(checkAgentMutationAllowed({ actorAgentID: 'mid', targetAgentID: 'w1', currentSessionID: '', getSession }).reason, 'missing-session');
  assert.equal(checkAgentMutationAllowed({ actorAgentID: 'mid', targetAgentID: 'w1', currentSessionID: 'S404', getSession }).reason, 'not-coordinator');
});

test('assertAgentMutationAllowed throws a refusal naming both agents', () => {
  let { getSession } = buildTree();
  assert.throws(
    () => assertAgentMutationAllowed({
      actorAgentID: 'w1',
      targetAgentID: 'mid',
      currentSessionID: 'S2',
      getSession,
    }),
    /w1 may not modify mid/,
  );
  assert.ok(assertAgentMutationAllowed({
    actorAgentID: 'w1',
    targetAgentID: 'w1',
    currentSessionID: 'S2',
    getSession,
  }).allowed);
});

test('session wrapper fails closed without runtime or session', async () => {
  assert.equal(
    (await checkAgentMutationAllowedForSession({ actorAgentID: 'a', targetAgentID: 'b' })).reason,
    'missing-session',
  );
  assert.equal(
    (await checkAgentMutationAllowedForSession({
      actorAgentID: 'a',
      targetAgentID: 'b',
      session: { id: 'S1' },
      runtime: null,
    })).reason,
    'missing-session',
  );
});
