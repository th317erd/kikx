'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OWNERSHIP_POLICY,
  isAncestorOrSelf,
  isVisibleTo,
  isOwnedBy,
  visibleOwnerIDsFor,
  ownerScopeFor,
  resolveScopeSessionIDs,
  normalizeSessionID,
  parentSessionIDOf,
} from '../../src/core/ownership/session-ownership.mjs';

import {
  OWNER_FIELD,
  buildOwnerScopeWhere,
  buildScopedQuery,
  chunkOwnerIDs,
  filterOwnedRows,
  normalizeOwnerIDs,
  ownerSessionIDOf,
} from '../../src/core/ownership/ownership-query.mjs';

import {
  isSessionVisibleTo,
  visibleOwnersFor,
  isOwnedBy as isOwnedByClient,
} from '../../src/client/state/session-scope.mjs';

// ---------------------------------------------------------------------------
// Fixtures:  root ─┬─ a ─┬─ a1
//                   │     └─ a2
//                   └─ b ─── b1
//            root2 (unrelated)
// ---------------------------------------------------------------------------

const TREE = [
  { id: 'root' },
  { id: 'a', parentSessionID: 'root' },
  { id: 'a1', parentSessionID: 'a' },
  { id: 'a2', parentSessionID: 'a' },
  { id: 'b', parentSessionID: 'root' },
  { id: 'b1', parentSessionID: 'b' },
  { id: 'root2' },
];

const ids = (list) => [ ...list ].sort();

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('self and every ancestor are visible owners; siblings and cousins are not', () => {
  assert.deepEqual(ids(visibleOwnerIDsFor('a1', TREE)), [ 'a', 'a1', 'root' ]);
});

test('the visible-owner chain is nearest-last and contains nothing off the chain', () => {
  assert.deepEqual(visibleOwnerIDsFor('a1', TREE), [ 'a1', 'a', 'root' ]);
});

test('a parent cannot see what its child owns', () => {
  assert.equal(isVisibleTo('a', 'a1', TREE), false);
  assert.equal(isVisibleTo('root', 'a', TREE), false);
});

test('a sibling branch is invisible in both directions', () => {
  assert.equal(isVisibleTo('a1', 'b1', TREE), false);
  assert.equal(isVisibleTo('b1', 'a1', TREE), false);
  assert.equal(isVisibleTo('a1', 'b', TREE), false);
  assert.equal(isVisibleTo('b', 'a1', TREE), false);
});

test('an unrelated tree is invisible in both directions', () => {
  assert.equal(isVisibleTo('root2', 'a1', TREE), false);
  assert.equal(isVisibleTo('a1', 'root2', TREE), false);
});

test('this is the upward rule, not resolveVisibleSessionIDs', () => {
  // The distinguishing case. The downward helper returns a1's subtree:
  //   resolveScopeSessionIDs('a1') === ['a1']
  // The ownership rule returns a1's ancestry:
  //   visibleOwnerIDsFor('a1')    === ['a1','a','root']
  // A two-session fixture cannot tell them apart; this one can.
  assert.deepEqual(ids(resolveScopeSessionIDs('a1', TREE)), [ 'a1' ]);
  assert.deepEqual(ids(visibleOwnerIDsFor('a1', TREE)), [ 'a', 'a1', 'root' ]);

  // And at the root they invert: the subtree is everything, the chain is just root.
  assert.deepEqual(ids(resolveScopeSessionIDs('root', TREE)), [ 'a', 'a1', 'a2', 'b', 'b1', 'root' ]);
  assert.deepEqual(ids(visibleOwnerIDsFor('root', TREE)), [ 'root' ]);
});

test('isVisibleTo and isOwnedBy are the same relation, not two', () => {
  for (let viewer of TREE.map((s) => s.id)) {
    for (let owner of TREE.map((s) => s.id)) {
      assert.equal(
        isVisibleTo(viewer, owner, TREE),
        isOwnedBy(viewer, owner, TREE),
        `disagreement for viewer=${viewer} owner=${owner}`,
      );
      assert.equal(
        isVisibleTo(viewer, owner, TREE),
        isAncestorOrSelf(owner, viewer, TREE),
        `isVisibleTo must be isAncestorOrSelf(owner, viewer) for ${viewer}/${owner}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Corrupt and partial data
// ---------------------------------------------------------------------------

test('a parent cycle terminates instead of hanging', () => {
  let cyclic = [
    { id: 'x', parentSessionID: 'y' },
    { id: 'y', parentSessionID: 'x' },
  ];

  assert.equal(isAncestorOrSelf('x', 'y', cyclic), true);
  assert.deepEqual(ids(visibleOwnerIDsFor('x', cyclic)), [ 'x', 'y' ]);
});

test('a self-parenting session terminates', () => {
  let self = [ { id: 's', parentSessionID: 's' } ];
  assert.equal(isAncestorOrSelf('nobody', 's', self), false);
  assert.deepEqual(visibleOwnerIDsFor('s', self), [ 's' ]);
});

test('a cycle not on the viewer chain grants nothing', () => {
  let cyclic = [
    { id: 'v', parentSessionID: 'p' },
    { id: 'p', parentSessionID: 'q' },
    { id: 'q', parentSessionID: 'p' },
  ];

  assert.equal(isAncestorOrSelf('ghost', 'v', cyclic), false);
  assert.deepEqual(ids(visibleOwnerIDsFor('v', cyclic)), [ 'p', 'q', 'v' ]);
});

test('a declared parent missing from the list is still an ancestor', () => {
  // The parent link is the evidence; a single declared ancestor is admitted,
  // and it can never widen into a branch.
  let partial = [ { id: 'leaf', parentSessionID: 'unloaded' } ];
  assert.equal(isVisibleTo('leaf', 'unloaded', partial), true);
  assert.equal(isVisibleTo('leaf', 'elsewhere', partial), false);
});

test('fails closed on blank, junk and unresolvable input', () => {
  assert.equal(isAncestorOrSelf('', 'a', TREE), false);
  assert.equal(isAncestorOrSelf('a', '', TREE), false);
  assert.equal(isAncestorOrSelf(null, undefined, TREE), false);
  assert.deepEqual(visibleOwnerIDsFor('', TREE), []);
  assert.deepEqual(visibleOwnerIDsFor('   ', TREE), []);
  assert.deepEqual(visibleOwnerIDsFor(null, TREE), []);
  assert.deepEqual(visibleOwnerIDsFor('a', null), [ 'a' ]);
});

test('normalizeSessionID and parentSessionIDOf tolerate junk', () => {
  assert.equal(normalizeSessionID('  a  '), 'a');
  assert.equal(normalizeSessionID(7), '');
  assert.equal(normalizeSessionID(null), '');
  assert.equal(parentSessionIDOf({ parentSessionID: 'p' }), 'p');
  assert.equal(parentSessionIDOf({ parentSessionId: 'p' }), 'p');
  assert.equal(parentSessionIDOf({}), '');
  assert.equal(parentSessionIDOf(null), '');
});

// ---------------------------------------------------------------------------
// The policy switch is the only switch
// ---------------------------------------------------------------------------

test('the policy default is ancestors-visible', () => {
  assert.equal(OWNERSHIP_POLICY.ancestorsVisible, true);
  assert.deepEqual(ids(ownerScopeFor('a1', TREE)), [ 'a', 'a1', 'root' ]);
});

// ---------------------------------------------------------------------------
// Parity with the client copy — this is what stops the two drifting
// ---------------------------------------------------------------------------

test('the client copy and the core copy answer every ordered pair identically', () => {
  for (let viewer of TREE.map((s) => s.id)) {
    for (let owner of TREE.map((s) => s.id)) {
      assert.equal(
        isOwnedBy(viewer, owner, TREE),
        isOwnedByClient(viewer, owner, TREE),
        `client/core disagree for viewer=${viewer} owner=${owner}`,
      );
      assert.equal(
        isSessionVisibleTo(viewer, owner, TREE),
        isVisibleTo(viewer, owner, TREE),
      );
    }
  }
});

test('the client and core owner chains agree', () => {
  for (let viewer of TREE.map((s) => s.id)) {
    assert.deepEqual(
      visibleOwnersFor(viewer, TREE),
      visibleOwnerIDsFor(viewer, TREE),
      `chain disagreement for viewer=${viewer}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The indexed query
// ---------------------------------------------------------------------------

test('the scope where-clause is an indexed in-list, not an unscoped query', () => {
  let where = buildOwnerScopeWhere([ 'a1', 'a', 'root' ]);
  assert.deepEqual(where, { field: OWNER_FIELD, op: 'in', value: [ 'a1', 'a', 'root' ] });
});

test('an empty scope yields null and never an unfiltered query', () => {
  assert.equal(buildOwnerScopeWhere([]), null);
  assert.equal(buildOwnerScopeWhere([ '', '  ' ]), null);
  assert.equal(buildOwnerScopeWhere(null), null);
  assert.equal(buildScopedQuery([]), null);
});

test('a long owner list is chunked into several in-lists, unioned', () => {
  let owners = Array.from({ length: 5 }, (_, i) => `s${i}`);
  let where = buildOwnerScopeWhere(owners, OWNER_FIELD, 2);

  assert.deepEqual(where, {
    or: [
      { field: OWNER_FIELD, op: 'in', value: [ 's0', 's1' ] },
      { field: OWNER_FIELD, op: 'in', value: [ 's2', 's3' ] },
      { field: OWNER_FIELD, op: 'in', value: [ 's4' ] },
    ],
  });

  assert.equal(chunkOwnerIDs(owners, 2).length, 3);
  assert.deepEqual(chunkOwnerIDs([ 'a', 'a', 'b' ]), [ [ 'a', 'b' ] ]);
});

test('a single chunk stays a bare condition rather than a one-element or', () => {
  let where = buildOwnerScopeWhere([ 'x', 'y' ], OWNER_FIELD, 64);
  assert.equal(Array.isArray(where.or), false);
  assert.equal(where.op, 'in');
});

test('extra conditions are conjoined with the scope', () => {
  let query = buildScopedQuery([ 'a' ], {
    path: '/sessions/agents',
    limit: 50,
    extra: [ { field: 'enabled', op: 'eq', value: true } ],
  });

  assert.equal(query.path, '/sessions/agents');
  assert.equal(query.limit, 50);
  assert.deepEqual(query.where, {
    and: [
      { field: 'enabled', op: 'eq', value: true },
      { field: OWNER_FIELD, op: 'in', value: [ 'a' ] },
    ],
  });
});

test('ownerSessionIDOf reads the field names in use and blanks the rest', () => {
  assert.equal(ownerSessionIDOf({ ownerSessionID: 'a' }), 'a');
  assert.equal(ownerSessionIDOf({ ownerSessionId: 'a' }), 'a');
  assert.equal(ownerSessionIDOf({ sessionID: 'a' }), 'a');
  assert.equal(ownerSessionIDOf({ sessionId: 'a' }), 'a');
  assert.equal(ownerSessionIDOf({}), '');
  assert.equal(ownerSessionIDOf(null), '');
});

test('filterOwnedRows re-checks index results and preserves order', () => {
  let rows = [
    { id: 1, ownerSessionID: 'root' },
    { id: 2, ownerSessionID: 'b1' },      // out of scope for a1
    { id: 3, ownerSessionID: 'a' },
    { id: 4 },                            // no owner: dropped, never granted
    { id: 5, ownerSessionID: 'a1' },
  ];

  let kept = filterOwnedRows(visibleOwnerIDsFor('a1', TREE), rows);
  assert.deepEqual(kept.map((r) => r.id), [ 1, 3, 5 ]);
});

test('filterOwnedRows with an empty scope keeps nothing', () => {
  let rows = [ { id: 1, ownerSessionID: 'root' } ];
  assert.deepEqual(filterOwnedRows([], rows), []);
});

test('normalizeOwnerIDs dedupes and preserves order', () => {
  assert.deepEqual(normalizeOwnerIDs([ 'b', ' a ', 'b', '', null ]), [ 'b', 'a' ]);
});
