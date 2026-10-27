'use strict';

// The rule under test, from the owner: a thing created at session S is visible
// and usable in S and in every descendant of S, and in no ancestor, sibling or
// unrelated subtree. Read from the viewer's side that is
//
//     an item owned by O is visible to viewer V  iff  O === V or O is an
//     ancestor of V
//
// so the set a viewer may see is { V } + ancestors(V).
//
// These tests are written to fail if the rule is *loosened*. In particular the
// test named "an ancestor IS visible while a sibling is not" is the one that
// separates this rule from resolveVisibleSessionIDs (which returns
// { V } + descendants(V)): copying that helper in here passes every
// two-session test and fails only that one.

// The seam: filtering arbitrary scoped rows for one viewer session.
//
// This is the shape the shell is wired against, split out of
// session-scope-spec.mjs so neither file carries every surface. The tests
// run the one predicate over agent, team, inbox-question and activity rows
// alike: one implementation, so the sidebar cannot grow a separate filter
// per item type. The relation itself is asserted in session-scope-spec.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionScope,
  filterItemsInScope,
  filterSessionsInScope,
  sessionIDOf,
} from '../../src/client/state/session-scope.mjs';

import { tree } from './session-scope-fixture.mjs';

// ---------------------------------------------------------------------------
// The seam: filtering data-driven sidebar entries
// ---------------------------------------------------------------------------

test('sessionIDOf reads the owner field the row carries', () => {
  assert.equal(sessionIDOf({ sessionID: 'a' }), 'a');
  assert.equal(sessionIDOf({ sessionId: ' a ' }), 'a');
  assert.equal(sessionIDOf({ ownerSessionID: 'a' }), 'a');
  assert.equal(sessionIDOf({ ownerSessionId: 'a' }), 'a');
  assert.equal(sessionIDOf({ id: 'row_1' }), '', 'a row id is not an owner');
  assert.equal(sessionIDOf(null), '');
  assert.equal(sessionIDOf('a'), '');
});

test('createSessionScope.filter keeps caller order and keeps only visible owners', () => {
  let scope = createSessionScope('a1', tree());
  let rows = [
    { id: 'row_a2', sessionID: 'a2' },     // sibling    - out
    { id: 'row_a', sessionID: 'a' },      // ancestor   - in
    { id: 'row_a1x', sessionID: 'a1x' },  // descendant - out
    { id: 'row_root', sessionID: 'root' },// ancestor   - in
    { id: 'row_a1', sessionID: 'a1' },    // self       - in
    { id: 'row_none' },                   // unscoped   - out
  ];

  assert.deepEqual(scope.filter(rows).map((row) => row.id), [ 'row_a', 'row_root', 'row_a1' ]);
  assert.deepEqual(scope.filter([]), []);
  assert.deepEqual(scope.filter(null), []);
  assert.equal(scope.owns('a'), true);
  assert.equal(scope.owns('a2'), false);
  assert.equal(scope.owns(''), false);
});

test('the same filter works for agents, teams, inbox rows and activities alike', () => {
  // The seam is a filter over arbitrary scoped items, not an agents-specific
  // function: one predicate, four row kinds, identical answer.
  let sessions = tree();
  let entries = [
    { kind: 'agent', name: 'root-agent', sessionID: 'root' },
    { kind: 'team', name: 'branch-team', sessionID: 'a' },
    { kind: 'question', ref: 'q1', sessionID: 'a1' },
    { kind: 'activity', at: 1, sessionID: 'a2' },
    { kind: 'agent', name: 'other-agent', sessionID: 'other' },
  ];

  let kept = filterItemsInScope('a1', entries, sessions).map((entry) => entry.name ?? entry.ref ?? entry.kind);
  assert.deepEqual(kept, [ 'root-agent', 'branch-team', 'q1' ]);

  // From the root, only the root's own agent is visible.
  assert.deepEqual(
    filterItemsInScope('root', entries, sessions).map((entry) => entry.name),
    [ 'root-agent' ],
  );

  // A sibling branch sees its own team but not a1's question.
  assert.deepEqual(
    filterItemsInScope('a2', entries, sessions).map((entry) => entry.name ?? entry.ref ?? entry.kind),
    [ 'root-agent', 'branch-team', 'activity' ],
  );
});

test('filterSessionsInScope returns the visible owners in the caller\'s order', () => {
  let sessions = tree();

  assert.deepEqual(
    filterSessionsInScope('a1', sessions).map((session) => session.id),
    [ 'root', 'a', 'a1' ],
  );
  assert.deepEqual(
    filterSessionsInScope('root', sessions).map((session) => session.id),
    [ 'root' ],
  );
  assert.deepEqual(filterSessionsInScope('', sessions), []);
  assert.deepEqual(filterSessionsInScope('a1', null), []);
});

test('an empty viewer yields an empty scope that grants nothing', () => {
  let scope = createSessionScope('', tree());

  assert.equal(scope.viewerSessionID, '');
  assert.equal(scope.ownerSessionIDs.size, 0);
  assert.equal(scope.owns('a'), false);
  assert.deepEqual(scope.filter([ { sessionID: 'a' } ]), []);
});
