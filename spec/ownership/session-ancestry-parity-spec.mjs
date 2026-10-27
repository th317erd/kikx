'use strict';

// Parity between the two public ownership surfaces.
//
// Both surfaces now re-export one walk from src/shared/session-ancestry.mjs.
// This spec is the guard that keeps it that way. It exists because the
// duplication it replaced was invisible to per-copy testing: each copy had its
// own green suite while the two disagreed in two behaviours (empty-string
// `parentSessionID` falling through to the camel-case alias, and
// ownerScopeFor ignoring the policy flag the client honoured).
//
// The tree below is the three-level one from the owner's own example:
//
//     P            the "Kikx" project: agents created here
//     |- C         a session in the project
//     |  |- G      a sub-session of C
//     |  `- CS     G's sibling
//     `- PS        C's sibling
//     X            an unrelated tree
//
// The pair (P -> C) is the one that distinguishes the ownership rule from the
// subtree rule: an ancestor is visible to its descendant.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as client from '../../src/client/state/session-scope.mjs';
import * as core from '../../src/core/ownership/session-ownership.mjs';
import {
  ancestryChain,
  descendantSessionIDs,
  isAncestorOrSelf,
  isOwnedBy,
  isVisibleTo,
  normalizeSessionID,
  sessionParentID,
} from '../../src/shared/session-ancestry.mjs';

function threeLevelTree() {
  return [
    { id: 'P', parentSessionID: null },
    { id: 'C', parentSessionID: 'P' },
    { id: 'G', parentSessionID: 'C' },
    { id: 'CS', parentSessionID: 'C' },
    { id: 'PS', parentSessionID: 'P' },
    { id: 'X', parentSessionID: null },
    { id: 'X1', parentSessionID: 'X' },
  ];
}

const ids = (value) => value.slice().sort();

// ---------------------------------------------------------------------------
// The guard: the two surfaces must answer identically, always
// ---------------------------------------------------------------------------

test('client and core surfaces agree on every ordered pair of a 3-level tree', () => {
  const tree = threeLevelTree();
  const names = tree.map((s) => s.id);

  for (let viewer of names) {
    for (let owner of names) {
      assert.equal(
        core.isOwnedBy(viewer, owner, tree),
        client.isOwnedBy(viewer, owner, tree),
        `isOwnedBy disagrees for viewer=${viewer} owner=${owner}`,
      );
      assert.equal(
        core.isVisibleTo(viewer, owner, tree),
        client.isVisibleTo(viewer, owner, tree),
        `isVisibleTo disagrees for viewer=${viewer} owner=${owner}`,
      );
      assert.equal(
        core.isSessionVisibleTo(viewer, owner, tree),
        client.isSessionVisibleTo(viewer, owner, tree),
        `isSessionVisibleTo disagrees for viewer=${viewer} owner=${owner}`,
      );
    }

    // The chain and both directions, per viewer.
    assert.deepEqual(
      ids(core.visibleOwnerIDsFor(viewer, tree)),
      ids(client.visibleOwnerIDsFor(viewer, tree)),
      `visible owners disagree for viewer=${viewer}`,
    );
    assert.deepEqual(
      ids(core.ownerScopeFor(viewer, tree)),
      ids(client.visibleOwnerIDsFor(viewer, tree)),
      `ownerScopeFor and visibleOwnerIDsFor disagree for viewer=${viewer}`,
    );
    assert.deepEqual(
      ids(core.resolveScopeSessionIDs(viewer, tree)),
      ids(client.resolveScopeSessionIDs(viewer, tree)),
      `downward view disagrees for viewer=${viewer}`,
    );
  }
});

test('the two surfaces expose one policy object, not two that can drift', () => {
  assert.equal(
    client.SCOPE_POLICY,
    core.OWNERSHIP_POLICY,
    'the policy must be the same object; two objects can be flipped independently',
  );
  assert.ok(Object.isFrozen(client.SCOPE_POLICY));
});

// ---------------------------------------------------------------------------
// The distinction the parity must not flatten
// ---------------------------------------------------------------------------

test('P cannot use what C owns, and C can use what P owns -- on both surfaces', () => {
  const tree = threeLevelTree();

  for (let surface of [client, core]) {
    // Ancestor's items reach the descendant.
    assert.equal(surface.isVisibleTo('C', 'P', tree), true, 'C must see P-owned items');
    assert.equal(surface.isVisibleTo('G', 'P', tree), true, 'G must see P-owned items');
    // Descendant's items do NOT reach the ancestor.
    assert.equal(surface.isVisibleTo('P', 'C', tree), false, 'P must not see C-owned items');
    assert.equal(surface.isVisibleTo('C', 'G', tree), false, 'C must not see G-owned items');
    // Siblings in both directions.
    assert.equal(surface.isVisibleTo('C', 'CS', tree), false);
    assert.equal(surface.isVisibleTo('G', 'CS', tree), false);
    assert.equal(surface.isVisibleTo('CS', 'G', tree), false);
    // CS is a child of C, not a sibling of it: it must still see C's items.
    assert.equal(surface.isVisibleTo('CS', 'C', tree), true, 'CS is a child of C');
    // PS is a sibling of C, so neither may see the other.
    assert.equal(surface.isVisibleTo('PS', 'C', tree), false);
    assert.equal(surface.isVisibleTo('C', 'PS', tree), false);
    // Unrelated tree.
    assert.equal(surface.isVisibleTo('X1', 'G', tree), false);
    assert.equal(surface.isVisibleTo('G', 'X1', tree), false);
  }
});

test('the two directions are genuinely different sets on this tree', () => {
  const tree = threeLevelTree();

  assert.deepEqual(ids(ancestryChain('C', tree)), [ 'C', 'P' ]);
  assert.deepEqual(ids(descendantSessionIDs('C', tree)), [ 'C', 'CS', 'G' ]);
  assert.notDeepEqual(
    ids(ancestryChain('C', tree)),
    ids(descendantSessionIDs('C', tree)),
  );
});

// ---------------------------------------------------------------------------
// The two behaviours that had already drifted
// ---------------------------------------------------------------------------

test('a malformed empty parentSessionID falls through to the alias, identically', () => {
  const malformed = { id: 'm', parentSessionID: '', parentSessionId: 'P' };

  assert.equal(sessionParentID(malformed), 'P');
  assert.equal(client.sessionParentID(malformed), 'P');
  assert.equal(core.parentSessionIDOf(malformed), 'P');

  // And it is honoured as ancestry, not silently dropped.
  assert.equal(client.isVisibleTo('m', 'P', [ malformed ]), true);
  assert.equal(core.isVisibleTo('m', 'P', [ malformed ]), true);
});

test('both surfaces terminate on a cycle rather than hanging', () => {
  const cyclic = [
    { id: 'P', parentSessionID: 'G' },
    { id: 'C', parentSessionID: 'P' },
    { id: 'G', parentSessionID: 'C' },
  ];

  for (let surface of [client, core]) {
    assert.equal(surface.isVisibleTo('G', 'C', cyclic), true, 'C is on the chain');
    assert.equal(surface.isVisibleTo('G', 'P', cyclic), true, 'P is on the chain');
    // A cycle that does not contain the owner grants nothing.
    assert.equal(surface.isVisibleTo('G', 'X', cyclic), false);
    assert.deepEqual(ids(surface.visibleOwnerIDsFor('G', cyclic)), [ 'C', 'G', 'P' ]);
  }
});

// ---------------------------------------------------------------------------
// Structural guard: one implementation, two surfaces
// ---------------------------------------------------------------------------

test('the shared walk is the implementation both surfaces delegate to', () => {
  // Re-exported primitives are the same function objects, not lookalikes.
  assert.equal(client.isAncestorOrSelf, core.isAncestorOrSelf);
  assert.equal(client.normalizeSessionID, core.normalizeSessionID);
  assert.equal(client.isVisibleTo, core.isVisibleTo);
  assert.equal(client.isOwnedBy, core.isOwnedBy);

  // And the shared module is what they all point at.
  const tree = threeLevelTree();
  for (let viewer of [ 'P', 'C', 'G' ]) {
    for (let owner of [ 'P', 'C', 'G' ]) {
      assert.equal(
        isAncestorOrSelf(owner, viewer, tree),
        isOwnedBy(viewer, owner, tree),
      );
    }
    assert.equal(normalizeSessionID(` ${viewer} `), viewer);
  }
});
