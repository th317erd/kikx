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

// The relation itself: who may see what, the policy switch, cycle and
// corrupt-chain termination, and the deep-chain scale test. The *filter
// seam* — the shape the shell is wired against — is in
// session-scope-filter-spec.mjs. Both import the same tree.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCOPE_POLICY,
  isAncestorOrSelf,
  isOwnedBy,
  isSessionVisibleTo,
  isVisibleTo,
  normalizeSessionID,
  resolveScopeSessionIDs,
  sessionParentID,
  visibleOwnerIDsFor,
  visibleOwnersFor,
} from '../../src/client/state/session-scope.mjs';

import { tree, ids } from './session-scope-fixture.mjs';

// ---------------------------------------------------------------------------
// The primitive, asserted in both directions on purpose
// ---------------------------------------------------------------------------

test('isAncestorOrSelf is directed and includes self', () => {
  let sessions = tree();

  assert.equal(isAncestorOrSelf('root', 'root', sessions), true, 'self');
  assert.equal(isAncestorOrSelf('root', 'a1x', sessions), true, 'deep ancestor');
  assert.equal(isAncestorOrSelf('a', 'a1', sessions), true, 'direct parent');
  assert.equal(isAncestorOrSelf('a1x', 'root', sessions), false, 'descendant is not an ancestor');
  assert.equal(isAncestorOrSelf('a2', 'a1', sessions), false, 'sibling');
  assert.equal(isAncestorOrSelf('other', 'a', sessions), false, 'unrelated tree');
});

// ---------------------------------------------------------------------------
// The upward view: what may this viewer see?
// ---------------------------------------------------------------------------

test('a viewer sees items it owns, and items owned by every ancestor', () => {
  let sessions = tree();

  assert.equal(isSessionVisibleTo('a1', 'a1', sessions), true, 'own item');
  assert.equal(isSessionVisibleTo('a1', 'a', sessions), true, 'parent-owned item');
  assert.equal(isSessionVisibleTo('a1', 'root', sessions), true, 'project-root-owned item');

  assert.deepEqual(ids(visibleOwnersFor('a1', sessions)), [ 'a', 'a1', 'root' ]);
});

test('an ancestor IS visible while a sibling is not — this separates the rule from resolveVisibleSessionIDs', () => {
  // resolveVisibleSessionIDs('a1') returns { a1, a1x }; the ancestor 'a' and
  // 'root' would be OUT under it. Under the ownership rule they are IN.
  let sessions = tree();
  let owners = new Set(visibleOwnersFor('a1', sessions));

  assert.equal(owners.has('a'), true, 'ancestor must be visible — downward walk would say false');
  assert.equal(owners.has('root'), true, 'project root must be visible');
  assert.equal(owners.has('a2'), false, 'sibling must not be visible');
  assert.equal(owners.has('a1x'), false, 'own descendant is NOT visible here — that is the other question');

  // Same assertions through the predicate.
  assert.equal(isSessionVisibleTo('a1', 'a', sessions), true);
  assert.equal(isSessionVisibleTo('a1', 'a2', sessions), false);
  assert.equal(isSessionVisibleTo('a1', 'a1x', sessions), false);
});

test("the owner's project story: an agent created at the root is usable in a leaf session", () => {
  let sessions = tree();

  // Agent owned by 'root'; every session beneath it can use it.
  for (let viewer of [ 'root', 'a', 'a1', 'a1x', 'a2', 'b', 'b1' ])
    assert.equal(isSessionVisibleTo(viewer, 'root', sessions), true, viewer);

  // An agent created in 'a' reaches everything below 'a' but never above it.
  for (let viewer of [ 'a', 'a1', 'a1x', 'a2' ])
    assert.equal(isSessionVisibleTo(viewer, 'a', sessions), true, viewer);

  for (let viewer of [ 'root', 'b', 'b1', 'other' ])
    assert.equal(isSessionVisibleTo(viewer, 'a', sessions), false, viewer);
});

test('a parent cannot see its children\'s items — the rule is not symmetric', () => {
  let sessions = tree();

  assert.equal(isSessionVisibleTo('root', 'a', sessions), false);
  assert.equal(isSessionVisibleTo('root', 'b1', sessions), false);
  assert.equal(isSessionVisibleTo('a', 'a1', sessions), false);
  assert.equal(isSessionVisibleTo('a', 'a1x', sessions), false);
  assert.equal(isSessionVisibleTo('a1', 'a1x', sessions), false);

  // A root viewer sees only what it owns.
  assert.deepEqual(visibleOwnersFor('root', sessions), [ 'root' ]);
});

test('siblings and unrelated trees are excluded in both directions', () => {
  let sessions = tree();

  for (let [ viewer, owner ] of [
    [ 'a1', 'a2' ], [ 'a2', 'a1' ], [ 'a1', 'b' ], [ 'a1', 'b1' ],
    [ 'b1', 'a1x' ], [ 'a1', 'other' ], [ 'other', 'a1' ],
  ])
    assert.equal(isSessionVisibleTo(viewer, owner, sessions), false, `${viewer}->${owner}`);
});

// ---------------------------------------------------------------------------
// The two views are not the same set — pin that explicitly
// ---------------------------------------------------------------------------

test('the visible-owner set and the subtree set are different, and neither drifts', () => {
  let sessions = tree();
  let all = sessions.map((session) => session.id);

  for (let viewer of all) {
    let owners = new Set(visibleOwnerIDsFor(viewer, sessions));
    let subtree = new Set(resolveScopeSessionIDs(viewer, sessions));

    // Independent oracle for each.
    let expectOwners = new Set([ viewer ]);
    let expectSubtree = new Set([ viewer ]);
    let grew = true;
    while (grew) {
      grew = false;
      for (let session of sessions) {
        let parent = sessionParentID(session);
        if (!parent)
          continue;
        // Owners walk UP: a session's parent joins the owner set once the
        // session itself is in it.
        if (!expectOwners.has(parent) && expectOwners.has(session.id)) {
          expectOwners.add(parent);
          grew = true;
        }
        // Subtree walks DOWN: a session joins once its parent is in it.
        if (!expectSubtree.has(session.id) && expectSubtree.has(parent)) {
          expectSubtree.add(session.id);
          grew = true;
        }
      }
    }

    assert.deepEqual(ids([ ...owners ]), ids([ ...expectOwners ]), `owners ${viewer}`);
    assert.deepEqual(ids([ ...subtree ]), ids([ ...expectSubtree ]), `subtree ${viewer}`);

    // A session that is not an ancestor of the viewer is never in the owner set.
    for (let owner of all) {
      assert.equal(
        isSessionVisibleTo(viewer, owner, sessions),
        expectOwners.has(owner),
        `viewer=${viewer} owner=${owner}`,
      );
    }
  }

  // And the two sets genuinely differ somewhere, so a copy-paste cannot hide.
  assert.notDeepEqual(ids(visibleOwnersFor('a1', sessions)), ids(resolveScopeSessionIDs('a1', sessions)));
});

// ---------------------------------------------------------------------------
// Policy is one flag
// ---------------------------------------------------------------------------

test('the policy default is ancestors-visible, and it is the only switch', () => {
  assert.equal(SCOPE_POLICY.ancestorsVisible, true);
  assert.ok(Object.isFrozen(SCOPE_POLICY), 'policy must not be mutated at runtime');

  let sessions = tree();
  assert.deepEqual(
    ids(visibleOwnerIDsFor('a1', sessions)),
    ids(visibleOwnersFor('a1', sessions)),
    'with ancestorsVisible the policy entry point is the ancestry chain',
  );
});

// ---------------------------------------------------------------------------
// Corrupt input: terminate, do not hang, do not grant
// ---------------------------------------------------------------------------

test('a parent cycle terminates and does not leak out of the cycle', () => {
  let cyclic = [
    { id: 'a', parentSessionID: 'b' },
    { id: 'b', parentSessionID: 'a' },
    { id: 'c', parentSessionID: 'a' },
    { id: 'x', parentSessionID: null },
  ];

  // Must return, not spin.
  assert.deepEqual(ids(visibleOwnersFor('a', cyclic)), [ 'a', 'b' ]);
  assert.deepEqual(ids(visibleOwnersFor('b', cyclic)), [ 'a', 'b' ]);
  assert.equal(isSessionVisibleTo('a', 'b', cyclic), true);
  assert.equal(isSessionVisibleTo('b', 'a', cyclic), true);
  // The cycle is not a bridge to an unrelated session, either way.
  assert.equal(isSessionVisibleTo('a', 'x', cyclic), false);
  assert.equal(isSessionVisibleTo('x', 'a', cyclic), false);
  // Nor does it hand 'a' its descendant's items.
  assert.equal(isSessionVisibleTo('a', 'c', cyclic), false);
});

test('a self-parenting session terminates instead of hanging', () => {
  let selfLoop = [
    { id: 's', parentSessionID: 's' },
    { id: 't', parentSessionID: 's' },
  ];

  assert.deepEqual(visibleOwnersFor('s', selfLoop), [ 's' ]);
  assert.equal(isSessionVisibleTo('s', 't', selfLoop), false);
  assert.equal(isSessionVisibleTo('other', 's', selfLoop), false);
});

test('a cycle that does not contain the viewer is not a grant', () => {
  let sessions = [
    { id: 'a', parentSessionID: 'b' },
    { id: 'b', parentSessionID: 'a' },
    { id: 'viewer', parentSessionID: null },
  ];

  assert.equal(isSessionVisibleTo('viewer', 'a', sessions), false);
  assert.equal(isSessionVisibleTo('viewer', 'b', sessions), false);
  assert.deepEqual(visibleOwnersFor('viewer', sessions), [ 'viewer' ]);
});

test('a declared parent that is not loaded is still an ancestor; an owner off the chain is not', () => {
  // The parent link is the evidence. 'orphan' declares 'gone' as its parent, so
  // an item owned by 'gone' is in scope even when the 'gone' record is absent
  // from this (possibly partial) session list. That grants nothing sideways: it
  // admits one declared ancestor, not a branch.
  let sessions = [
    { id: 'orphan', parentSessionID: 'gone' },
    { id: 'sibling', parentSessionID: 'gone' },
    { id: 'viewer', parentSessionID: null },
  ];

  assert.equal(isSessionVisibleTo('orphan', 'gone', sessions), true, 'declared ancestor is in scope');
  assert.deepEqual(visibleOwnersFor('orphan', sessions), [ 'orphan', 'gone' ]);

  // The walk stops at the unloaded parent; it cannot invent a grandparent.
  assert.equal(isSessionVisibleTo('orphan', 'great-grandparent', sessions), false);
  assert.deepEqual(visibleOwnersFor('orphan', [ { id: 'orphan', parentSessionID: 'gone' } ]), [ 'orphan', 'gone' ]);

  // Sharing that parent does not make a sibling visible, either way round.
  assert.equal(isSessionVisibleTo('sibling', 'orphan', sessions), false);
  assert.equal(isSessionVisibleTo('orphan', 'sibling', sessions), false);

  // An owner nowhere on the chain is not granted.
  assert.equal(isSessionVisibleTo('viewer', 'orphan', sessions), false);
  assert.equal(isSessionVisibleTo('orphan', 'viewer', sessions), false);
});

test('fails closed on blank and unresolvable input', () => {
  let sessions = tree();

  for (let [ viewer, owner ] of [
    [ '', 'a' ], [ 'a', '' ], [ '   ', 'a' ], [ 'a', '   ' ],
    [ null, 'a' ], [ 'a', null ], [ undefined, 'a' ], [ 'a', undefined ],
    [ 'a1', 'not-loaded' ], [ 'not-loaded', 'a1' ],
  ])
    assert.equal(isSessionVisibleTo(viewer, owner, sessions), false, `${String(viewer)}->${String(owner)}`);

  assert.deepEqual(visibleOwnersFor('', sessions), []);
  assert.deepEqual(visibleOwnersFor(null, sessions), []);
  assert.deepEqual(visibleOwnerIDsFor('', sessions), []);
  assert.deepEqual(visibleOwnersFor('a1', null), [ 'a1' ], 'viewer alone, nothing inherited');
});

// ---------------------------------------------------------------------------
// Field and shape handling
// ---------------------------------------------------------------------------

test('the parent link is read from parentSessionID, with the parentSessionId alias', () => {
  assert.equal(sessionParentID({ id: 'a', parentSessionID: 'root' }), 'root');
  assert.equal(sessionParentID({ id: 'a', parentSessionId: 'root' }), 'root');
  assert.equal(sessionParentID({ id: 'a', parentSessionID: '  root  ' }), 'root');
  assert.equal(sessionParentID({ id: 'a', parentSessionID: null }), '');
  assert.equal(sessionParentID({ id: 'a', parentSessionID: '' }), '');
  assert.equal(sessionParentID({ id: 'a' }), '');
  assert.equal(sessionParentID(null), '');
  assert.equal(sessionParentID(undefined), '');

  assert.equal(normalizeSessionID('  x '), 'x');
  assert.equal(normalizeSessionID(null), '');
  assert.equal(normalizeSessionID(42), '');
});

test('session ids are trimmed and junk rows are tolerated', () => {
  let sessions = [
    { id: ' a ', parentSessionID: ' root ' },
    { id: 'root', parentSessionID: null },
    null,
    undefined,
    {},
    { id: '', parentSessionID: 'a' },
  ];

  assert.equal(isSessionVisibleTo('a', 'root', sessions), true);
  assert.deepEqual(ids(visibleOwnersFor('a', sessions)), [ 'a', 'root' ]);
});

test('a lookup function and a Map are accepted in place of the session array', () => {
  let sessions = tree();
  let byID = new Map(sessions.map((session) => [ session.id, session ]));
  let getSession = (id) => byID.get(id);

  for (let owner of [ 'a1', 'a', 'root' ]) {
    assert.equal(isSessionVisibleTo('a1', owner, byID), true, owner);
    assert.equal(isSessionVisibleTo('a1', owner, getSession), true, owner);
  }

  for (let owner of [ 'a1x', 'a2', 'b', 'b1', 'other', 'missing' ]) {
    assert.equal(isSessionVisibleTo('a1', owner, byID), false, owner);
    assert.equal(isSessionVisibleTo('a1', owner, getSession), false, owner);
  }
});
// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

test('a deep chain is walked iteratively, not recursively', () => {
  // 20k depth overflows the stack for a recursive implementation.
  let depth = 20000;
  let sessions = [ { id: 's0', parentSessionID: null } ];
  for (let index = 1; index <= depth; index++)
    sessions.push({ id: `s${index}`, parentSessionID: `s${index - 1}` });

  let leaf = `s${depth}`;

  assert.equal(isAncestorOrSelf('s0', leaf, sessions), true);
  assert.equal(isSessionVisibleTo(leaf, 's0', sessions), true, 'the leaf inherits the root\'s items');
  assert.equal(isSessionVisibleTo('s0', leaf, sessions), false, 'the root does not inherit the leaf\'s');

  let owners = visibleOwnersFor(leaf, sessions);
  assert.equal(owners.length, depth + 1);
  assert.deepEqual(visibleOwnersFor('s0', sessions), [ 's0' ]);
});

// ---------------------------------------------------------------------------
// The public contract handed to the shell: one behaviour, three names
// ---------------------------------------------------------------------------

test('isVisibleTo, isOwnedBy and isSessionVisibleTo are one behaviour, not three', () => {
  let sessions = tree();
  let all = [ 'root', 'a', 'a1', 'a1x', 'a2', 'b', 'b1', 'other' ];

  // An oracle written here, from the parent links, independently of every
  // helper in the module. Comparing the three names only to each other would
  // pass with all three inverted, so the expected answer is derived separately.
  let oracle = (viewer, owner) => {
    for (let cursor = viewer; cursor; ) {
      if (cursor === owner)
        return true;
      cursor = sessions.find((session) => session.id === cursor)?.parentSessionID ?? null;
    }
    return false;
  };

  for (let viewer of all) {
    for (let owner of all) {
      let expected = oracle(viewer, owner);
      assert.equal(isVisibleTo(viewer, owner, sessions), expected, `isVisibleTo ${viewer}->${owner}`);
      assert.equal(isOwnedBy(viewer, owner, sessions), expected, `isOwnedBy ${viewer}->${owner}`);
      assert.equal(isSessionVisibleTo(viewer, owner, sessions), expected, `isSessionVisibleTo ${viewer}->${owner}`);
    }
  }

  // Spelled out once so the aliases cannot quietly acquire another direction:
  // the leaf keeps its ancestors and drops its sibling and its child.
  assert.equal(isVisibleTo('a1', 'a', sessions), true, 'alias keeps the parent');
  assert.equal(isVisibleTo('a1', 'root', sessions), true, 'alias keeps the project root');
  assert.equal(isVisibleTo('a1', 'a2', sessions), false, 'alias drops the sibling');
  assert.equal(isVisibleTo('a1', 'a1x', sessions), false, 'alias drops the child');
  assert.equal(isOwnedBy('a2', 'a1', sessions), false, 'the sibling direction is closed too');
  assert.equal(isOwnedBy('a1', 'a2', sessions), false);
  assert.equal(isOwnedBy('a1x', 'root', sessions), true, 'isOwnedBy means the same thing');
});

test('the alias contract answers the shell question without a session array in hand', () => {
  // A sidebar builder holding only a viewer id and an owner id must still get
  // the self-grant; everything past self needs evidence, so it fails closed
  // rather than assuming ancestry.
  assert.equal(isVisibleTo('a1', 'a1'), true, 'own item, no lookup supplied');
  assert.equal(isOwnedBy('a1', 'a1'), true);
  assert.equal(isVisibleTo('a1', 'a'), false, 'no lookup, no proof of ancestry');
  assert.equal(isVisibleTo('', ''), false, 'blank ids never grant');
});

test('visibleOwnersFor returns the ancestry chain nearest-last and nothing outside it', () => {
  assert.deepEqual(visibleOwnersFor('a1x', tree()), [ 'a1x', 'a1', 'a', 'root' ]);
  assert.deepEqual(visibleOwnersFor('root', tree()), [ 'root' ]);
  assert.deepEqual(visibleOwnersFor('other', tree()), [ 'other' ], 'an unrelated tree contributes no owners');
  assert.deepEqual(visibleOwnersFor('', tree()), []);

  // every id it returns must pass the predicate, and a sibling must not be in it
  let owners = visibleOwnersFor('a1x', tree());
  for (let owner of owners)
    assert.equal(isVisibleTo('a1x', owner, tree()), true, owner);

  assert.equal(owners.includes('a2'), false);
  assert.equal(owners.includes('b1'), false);
});

