'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effectiveSessionAgentIDs,
  effectiveSessionTeamIDs,
} from '../../src/shared/session-actors.mjs';

const sessions = [
  { id: 'root', parentSessionID: null, participantAgentIDs: [ 'a1' ], teamIDs: [ 't1' ] },
  { id: 'child', parentSessionID: 'root', participantAgentIDs: [ 'a2', 'a1' ], teamIDs: [ 't2' ] },
  { id: 'grandchild', parentSessionID: 'child', participantAgentIDs: [ 'a3' ], teamIDs: [] },
  { id: 'sibling', parentSessionID: 'root', participantAgentIDs: [ 'a4' ], teamIDs: [ 't4' ] },
];
const byID = new Map(sessions.map((session) => [ session.id, session ]));

test('agents and teams inherit from every ancestor, nearest first', () => {
  assert.deepEqual(effectiveSessionAgentIDs('grandchild', (id) => byID.get(id)), [ 'a3', 'a2', 'a1' ]);
  assert.deepEqual(effectiveSessionTeamIDs('grandchild', (id) => byID.get(id)), [ 't2', 't1' ]);
});

test('a child never inherits from a sibling or descendant', () => {
  assert.equal(effectiveSessionAgentIDs('child', (id) => byID.get(id)).includes('a4'), false);
  assert.equal(effectiveSessionTeamIDs('child', (id) => byID.get(id)).includes('t4'), false);
});

test('a missing ancestor stops the walk without throwing', () => {
  let partial = new Map([
    [ 'child', { id: 'child', parentSessionID: 'missing', participantAgentIDs: [ 'a2' ], teamIDs: [ 't2' ] } ],
  ]);
  assert.deepEqual(effectiveSessionAgentIDs('child', (id) => partial.get(id)), [ 'a2' ]);
  assert.deepEqual(effectiveSessionTeamIDs('child', (id) => partial.get(id)), [ 't2' ]);
});
