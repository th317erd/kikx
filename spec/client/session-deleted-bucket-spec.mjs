'use strict';

// The soft-deleted bucket that backs the "show deleted sessions" eye. It lives
// beside sessionIDs (never inside it), so getSessions() and the delete prune
// path are untouched; these specs pin the bucket's add/replace/drop rules and
// the getVisibleSessions merge.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';
import {
  createSessionStateSnapshot,
  forgetDeletedSessionState,
  recordDeletedSessionState,
  setDeletedSessionsState,
} from '../../src/client/state/session-state-utils.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();

const { getDeletedSessions, getSessions, getVisibleSessions } = await import('../../src/client/state/kikx-state.mjs');

function stateWith(sessionIDs = [], deleted = []) {
  let state = createSessionStateSnapshot({
    sessionIDs: sessionIDs.slice(),
    sessionDetailsByID: Object.fromEntries(sessionIDs.map((id) => [ id, { id, title: `Live ${id}` } ])),
    framesBySessionID: {},
    sessionPagingByID: {},
  });
  state = setDeletedSessionsState(state, deleted);
  state.showDeletedSessions = false;
  state.sessionSearch = '';
  return state;
}

test('setDeletedSessionsState keeps only sessions carrying a deletedAt stamp', () => {
  let state = setDeletedSessionsState(createSessionStateSnapshot(), [
    { id: 'd1', title: 'Gone 1', deletedAt: 'stamp-1' },
    { id: 'live', title: 'Still here' },
    { id: 'd2', title: 'Gone 2', deletedAt: 'stamp-2' },
  ]);

  assert.deepEqual(state.deletedSessionIDs, [ 'd1', 'd2' ]);
  assert.equal(state.deletedSessionDetailsByID.live, undefined);
  assert.equal(state.deletedSessionDetailsByID.d1.title, 'Gone 1');
});

test('recordDeletedSessionState adds then refreshes a deleted session in place', () => {
  let state = recordDeletedSessionState(createSessionStateSnapshot(), { id: 'd1', title: 'Gone', deletedAt: 'stamp-1' });
  assert.deepEqual(state.deletedSessionIDs, [ 'd1' ]);

  let renamed = recordDeletedSessionState(state, { id: 'd1', title: 'Gone renamed', deletedAt: 'stamp-1' });
  assert.deepEqual(renamed.deletedSessionIDs, [ 'd1' ], 'no duplicate id');
  assert.equal(renamed.deletedSessionDetailsByID.d1.title, 'Gone renamed');
});

test('recordDeletedSessionState ignores a live (non-deleted) session', () => {
  let state = recordDeletedSessionState(createSessionStateSnapshot(), { id: 'live', title: 'Live' });
  assert.deepEqual(state.deletedSessionIDs, []);
});

test('forgetDeletedSessionState drops the id and its detail', () => {
  let state = setDeletedSessionsState(createSessionStateSnapshot(), [
    { id: 'd1', title: 'Gone 1', deletedAt: 'stamp-1' },
    { id: 'd2', title: 'Gone 2', deletedAt: 'stamp-2' },
  ]);

  let next = forgetDeletedSessionState(state, 'd1');
  assert.deepEqual(next.deletedSessionIDs, [ 'd2' ]);
  assert.equal(next.deletedSessionDetailsByID.d1, undefined);
  // Immutability: the source snapshot is untouched.
  assert.deepEqual(state.deletedSessionIDs, [ 'd1', 'd2' ]);
});

test('getVisibleSessions shows the deleted bucket only while the eye is on', () => {
  let state = stateWith([ 'live1' ], [ { id: 'd1', title: 'Gone', deletedAt: 'stamp-1' } ]);
  assert.deepEqual(getSessions(state).map((s) => s.id), [ 'live1' ]);
  assert.deepEqual(getDeletedSessions(state).map((s) => s.id), [ 'd1' ]);

  assert.deepEqual(getVisibleSessions(state).map((s) => s.id), [ 'live1' ]);

  state.showDeletedSessions = true;
  assert.deepEqual(getVisibleSessions(state).map((s) => s.id), [ 'live1', 'd1' ]);
});

test('getVisibleSessions applies the title filter across both buckets', () => {
  let state = stateWith([ 'alpha' ], [ { id: 'dalpha', title: 'Deleted Alpha', deletedAt: 'stamp-1' } ]);
  state.showDeletedSessions = true;
  state.sessionSearch = 'alpha';

  assert.deepEqual(getVisibleSessions(state).map((s) => s.id), [ 'alpha', 'dalpha' ]);
});
