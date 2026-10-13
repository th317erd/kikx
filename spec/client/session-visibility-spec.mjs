'use strict';

// Pure view helpers for the session workspace: the title filter and the
// live+deleted merge that the "show deleted" eye drives. No DOM needed.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterSessionsByTitle,
  matchesSessionTitle,
  normalizeSessionQuery,
  visibleSessions,
} from '../../src/client/state/session-visibility.mjs';

const LIVE = [
  { id: 'a', title: 'Alpha Session' },
  { id: 'b', title: 'Beta Session' },
  { id: 'c', title: 'Gamma Report' },
];
const DELETED = [
  { id: 'd', title: 'Deleted Alpha', deletedAt: 'stamp-1' },
  { id: 'e', title: 'Deleted Zeta', deletedAt: 'stamp-2' },
];

test('normalizeSessionQuery trims and lowercases, and tolerates non-strings', () => {
  assert.equal(normalizeSessionQuery('  Alpha  '), 'alpha');
  assert.equal(normalizeSessionQuery(''), '');
  assert.equal(normalizeSessionQuery(null), '');
  assert.equal(normalizeSessionQuery(42), '');
});

test('matchesSessionTitle is a case-insensitive substring test', () => {
  assert.equal(matchesSessionTitle({ title: 'Alpha Session' }, 'alpha'), true);
  assert.equal(matchesSessionTitle({ title: 'Alpha Session' }, 'ALP'), true);
  assert.equal(matchesSessionTitle({ title: 'Alpha Session' }, 'beta'), false);
  // An empty query matches everything.
  assert.equal(matchesSessionTitle({ title: 'Alpha' }, ''), true);
  // A missing title never matches a non-empty query.
  assert.equal(matchesSessionTitle({ id: 'x' }, 'a'), false);
  assert.equal(matchesSessionTitle(null, 'a'), false);
});

test('filterSessionsByTitle returns a copy in order for an empty query', () => {
  let result = filterSessionsByTitle(LIVE, '');
  assert.deepEqual(result.map((s) => s.id), [ 'a', 'b', 'c' ]);
  assert.notEqual(result, LIVE, 'a copy, not the same array');
});

test('filterSessionsByTitle narrows by title without reordering', () => {
  let result = filterSessionsByTitle(LIVE, 'session');
  assert.deepEqual(result.map((s) => s.id), [ 'a', 'b' ]);
  assert.deepEqual(filterSessionsByTitle(LIVE, 'gamma').map((s) => s.id), [ 'c' ]);
  assert.deepEqual(filterSessionsByTitle(LIVE, 'nope'), []);
});

test('visibleSessions lists only live sessions while the eye is off', () => {
  let result = visibleSessions({ liveSessions: LIVE, deletedSessions: DELETED, showDeleted: false });
  assert.deepEqual(result.map((s) => s.id), [ 'a', 'b', 'c' ]);
});

test('visibleSessions appends the deleted bucket while the eye is on', () => {
  let result = visibleSessions({ liveSessions: LIVE, deletedSessions: DELETED, showDeleted: true });
  assert.deepEqual(result.map((s) => s.id), [ 'a', 'b', 'c', 'd', 'e' ]);
});

test('the title filter applies to both buckets when the eye is on', () => {
  let result = visibleSessions({ liveSessions: LIVE, deletedSessions: DELETED, showDeleted: true, query: 'alpha' });
  assert.deepEqual(result.map((s) => s.id), [ 'a', 'd' ]);
});

test('the title filter applies to the live bucket while the eye is off', () => {
  let result = visibleSessions({ liveSessions: LIVE, deletedSessions: DELETED, showDeleted: false, query: 'alpha' });
  assert.deepEqual(result.map((s) => s.id), [ 'a' ]);
});

test('visibleSessions tolerates missing lists', () => {
  assert.deepEqual(visibleSessions(), []);
  assert.deepEqual(visibleSessions({ showDeleted: true }), []);
});
