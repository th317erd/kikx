'use strict';

// The scope seam has three call shapes and only ONE of them is correct. All
// three were measured against the real sidebar descriptors (built from the real
// `buildSessionObjectItems` over a real navigation stack) before this file
// existed, and two of them were wrong-and-silent in opposite directions:
//
//   filterSessionObjectItems(items, scope.predicate)  -> 4 of 5 kept   (correct)
//   filterSessionObjectItems(items, scope.filter)     -> 5 of 5 kept   (leak)
//   filterSessionObjectItems(items, scope.owns)       -> 0 of 5 kept   (blank)
//
// Why the wrong ones were silent:
//
//   - `scope.filter` is a COLLECTION filter. Called once per item it answered
//     `[]`, and `Boolean([]) === true`, so every item survived. A leaking
//     sidebar that looks correct is the worst failure mode here.
//   - `scope.owns` takes a SESSION ID, not a row. Given a row it normalized to
//     '' and answered false for every item -- a blank sidebar.
//
// This file pins two things: the correct pairing produces the right answer, and
// both wrong pairings now fail loudly instead of guessing. A refactor that
// quietly restores the silent behaviour has to break a named test to do it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from '../client/support/mini-dom.mjs';

register(new URL('../client/support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
assert.ok(document);

const { createNavigationStack, pushThread } =
  await import('../../src/client/state/navigation-stack.mjs');
const { buildSessionObjectItems, filterSessionObjectItems } =
  await import('../../src/client/components/kikx-sidebar-session-objects.mjs');
const { createSessionScope } = await import('../../src/client/state/session-scope.mjs');

// A two-level tree: G is the root, S-VIEW is its child, and the sidebar is
// showing S-VIEW. `createSessionScope` walks `parentSessionID`, so the tree has
// to be real or the walk silently degenerates to "nothing is visible".
const SESSIONS = [
  { id: 'G', parentSessionID: null },
  { id: 'S-VIEW', parentSessionID: 'G' },
];

function appViewing(leafSessionID) {
  let stack = createNavigationStack();
  if (leafSessionID)
    stack = pushThread(stack, leafSessionID);

  return {
    _state: { navigationStack: stack },
    _openAccountEditor() {},
    _openAgentManager() {},
    _openTeamManager() {},
    _signOut() {},
  };
}

const ALL_IDS = [ 'account-chip', 'account', 'agents', 'teams', 'sign-out' ];

test('the sidebar descriptors carry the viewed session id on every non-chip row', () => {
  let items = buildSessionObjectItems(appViewing('S-VIEW'));

  assert.deepEqual(items.map((item) => item.id), ALL_IDS);
  // The account chip is the one global carve-out; everything else is scoped to
  // the session the sidebar is showing, which is what makes trickle-down
  // expressible at all.
  assert.deepEqual(
    items.map((item) => item.scopeSessionID),
    [ null, 'S-VIEW', 'S-VIEW', 'S-VIEW', 'S-VIEW' ],
  );
});

test('scope.predicate is the seam-shaped pairing and keeps the scoped rows', () => {
  let items = buildSessionObjectItems(appViewing('S-VIEW'));
  let scope = createSessionScope('S-VIEW', SESSIONS);

  let kept = filterSessionObjectItems(items, scope.predicate);

  // The chip is unscoped by owner point 5, so a scope filter drops it. That is
  // the documented answer, and it is why the shipped sidebar does NOT wire this
  // filter yet: see the note at the end of this file.
  assert.deepEqual(kept.map((item) => item.id), [ 'account', 'agents', 'teams', 'sign-out' ]);
});

test('scope.filter passed as the per-item predicate throws instead of keeping everything', () => {
  let items = buildSessionObjectItems(appViewing('S-VIEW'));
  let scope = createSessionScope('S-VIEW', SESSIONS);

  // Measured before the guard: all five were kept, because `[]` is truthy.
  assert.throws(
    () => filterSessionObjectItems(items, scope.filter),
    (error) => error instanceof TypeError && /takes an ARRAY/.test(error.message),
  );
});

test('scope.owns passed as the per-item predicate throws instead of blanking the sidebar', () => {
  let items = buildSessionObjectItems(appViewing('S-VIEW'));
  let scope = createSessionScope('S-VIEW', SESSIONS);

  // Measured before the guard: zero of five kept, with no error anywhere.
  assert.throws(
    () => filterSessionObjectItems(items, scope.owns),
    (error) => error instanceof TypeError && /session ID string/.test(error.message),
  );
});

test('owns rejects a row-shaped argument but still answers for every real id shape', () => {
  let scope = createSessionScope('S-VIEW', SESSIONS);

  assert.throws(() => scope.owns({ id: 'agents' }), TypeError);
  assert.throws(() => scope.owns([ 'S-VIEW' ]), TypeError);

  // The shipped callers pass strings, null, or undefined; none may throw.
  assert.equal(scope.owns('S-VIEW'), true);
  assert.equal(scope.owns('G'), true, 'an ancestor is visible to the viewer');
  assert.equal(scope.owns('other'), false);
  assert.equal(scope.owns(''), false);
  assert.equal(scope.owns(null), false);
  assert.equal(scope.owns(undefined), false);
});

test('filter takes a collection, and a single row is a shape error', () => {
  let scope = createSessionScope('S-VIEW', SESSIONS);

  assert.throws(() => scope.filter({ id: 'agents' }), TypeError);

  // `filter(null)` meaning "nothing to filter" is public and stays quiet.
  assert.deepEqual(scope.filter(null), []);
  assert.deepEqual(scope.filter([]), []);
});

test('an unscoped viewer keeps nothing, loudly or quietly, never everything', () => {
  let items = buildSessionObjectItems(appViewing('S-VIEW'));
  let nullScope = createSessionScope(null, SESSIONS);

  // A null viewer is the empty scope: it answers false, and it must not be the
  // shape that accidentally returns `true` for every row.
  assert.deepEqual(filterSessionObjectItems(items, nullScope.predicate), []);
  assert.throws(() => nullScope.filter(items[1]), TypeError);
  assert.equal(nullScope.owns('S-VIEW'), false);
});

test('the shipped sidebar is unwired, so all five controls still render', () => {
  let items = buildSessionObjectItems(appViewing('S-VIEW'));

  // No scopeFilter supplied: `filterSessionObjectItems` is identity. Wiring
  // `scope.predicate` here today would drop the account chip, and at the tree
  // root it would drop all five (every descriptor is unscoped there), so the
  // seam stays unwired and documented rather than wired and wrong.
  assert.deepEqual(filterSessionObjectItems(items).map((item) => item.id), ALL_IDS);

  let rootItems = buildSessionObjectItems(appViewing(null));
  assert.deepEqual(
    rootItems.map((item) => item.scopeSessionID),
    [ null, null, null, null, null ],
    'at the root every descriptor is unscoped, so a scope filter would blank the sidebar',
  );
  assert.deepEqual(
    filterSessionObjectItems(rootItems, createSessionScope(null, SESSIONS).predicate),
    [],
  );
});
