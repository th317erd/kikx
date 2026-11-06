'use strict';

// The sidebar scope seam: the contract the shell owner implements.
//
// This spec pins the CONTRACT, not the shell. It runs the real
// `filterSessionObjectItems` seam (kikx-sidebar-session-objects.mjs:83) with the
// real visibility predicate, so an implementation that gets the contract wrong
// fails here before it reaches the shell.
//
// Why this file exists at all: the obvious test — "the cluster has 5 rows" —
// CANNOT detect a broken predicate. Measured at HEAD d402558, the cluster has 5
// rows for every viewer, including for a filter that always returns true.
// The assertions that actually discriminate are the denials below: a sibling's
// row and a descendant's row must be dropped. A no-op filter passes the count
// test and fails these.
//
// Two traps this pins, both of which I got wrong myself before measuring:
//
//   1. `scopeSessionID === null` means BOTH "the global account item" AND
//      "root view, no session selected". Granting on that null hides Account,
//      Agents, Teams and Sign out at the project root (measured count=1).
//      The carve-out must be by item identity.
//   2. At root there is no viewer id, so the visibility predicate fails closed
//      and would hide the whole cluster. Root genuinely owns everything below
//      it, so root must grant.
//
// Importing the component directly does not work in Node: src/client/lib/
// aeor-ui.mjs imports the browser-absolute `/vendor/aeor-web-components/
// elements.js`. The loader below is the same harness the other client specs
// use (spec/client/inbox-view-rebuild-spec.mjs:41-44).

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from '../client/support/mini-dom.mjs';

register(new URL('../client/support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { buildSessionObjectItems, filterSessionObjectItems } =
  await import('../../src/client/components/kikx-sidebar-session-objects.mjs');
const { isSessionVisibleTo } = await import('../../src/client/state/session-scope.mjs');

// The tree: P is the project root. C is P's child. G is C's child.
// S is P's other child -- G's aunt, and the sibling that must never leak.
const SESSIONS = [
  { id: 'P', parentSessionID: null },
  { id: 'C', parentSessionID: 'P' },
  { id: 'G', parentSessionID: 'C' },
  { id: 'S', parentSessionID: 'P' },
];

// The contract under test, exactly as the shell owner must write it.
function scopeFilterFor(viewerSessionID) {
  return (item, scopeSessionID) => {
    if (item?.id === 'account-chip')
      return true;                                 // 1. the global carve-out, by identity
    if (viewerSessionID == null)
      return true;                                 // 2. root view owns everything below
    return isSessionVisibleTo(viewerSessionID, scopeSessionID, SESSIONS); // 3. rule
  };
}

const rowOwnedBy = (sessionID) => [{ id: 'x', kind: 'button', scopeSessionID: sessionID }];

const survives = (viewerSessionID, ownerSessionID) =>
  filterSessionObjectItems(rowOwnedBy(ownerSessionID), scopeFilterFor(viewerSessionID), {}).length;

test('a sibling-owned row is denied', () => {
  // S and G are both two levels under P but in different branches.
  assert.equal(survives('G', 'S'), 0);
  assert.equal(survives('S', 'G'), 0);
  assert.equal(survives('C', 'S'), 0);
});

test('a descendant-owned row is denied: a parent may not use a child item', () => {
  assert.equal(survives('P', 'C'), 0);
  assert.equal(survives('C', 'G'), 0);
  assert.equal(survives('P', 'G'), 0);
});

test('self, parent and grandparent owned rows are granted', () => {
  assert.equal(survives('G', 'G'), 1);
  assert.equal(survives('G', 'C'), 1);
  assert.equal(survives('G', 'P'), 1);
  assert.equal(survives('C', 'P'), 1);
});

test('the account chip is granted at every viewer, including the root view', () => {
  let chip = [{ id: 'account-chip', kind: 'chip', scopeSessionID: null }];
  for (let viewer of ['P', 'C', 'G', null])
    assert.equal(filterSessionObjectItems(chip, scopeFilterFor(viewer), {}).length, 1,
      `account chip must survive for viewer ${String(viewer)}`);
});

test('the root view keeps its whole cluster', () => {
  // navigationStack empty -> every row's scopeSessionID is null.
  let app = { _state: { navigationStack: [], account: { name: 'w' } } };
  let items = buildSessionObjectItems(app);
  assert.equal(items.length, 5);
  assert.equal(items.every((item) => item.scopeSessionID === null), true);

  let kept = filterSessionObjectItems(items, scopeFilterFor(null), app._state);
  assert.equal(kept.length, 5);
});

test('a leaf view keeps the cluster and leaves the account chip first', () => {
  let app = { _state: { navigationStack: [{ sessionID: 'G' }], account: { name: 'w' } } };
  let kept = filterSessionObjectItems(buildSessionObjectItems(app), scopeFilterFor('G'), app._state);
  assert.equal(kept.length, 5);
  assert.equal(kept[0].id, 'account-chip');
});

test('CONTROL: a constant-true filter passes the count and fails the denials', () => {
  // This is what makes the tests above worth having. If this control asserted 0,
  // the denial tests would be vacuous.
  let alwaysTrue = () => true;

  let count = filterSessionObjectItems(rowOwnedBy('S'), alwaysTrue, {}).length;
  assert.equal(count, 1, 'a no-op filter must keep the sibling row');

  // And the same no-op filter is indistinguishable by count on the real cluster.
  let app = { _state: { navigationStack: [{ sessionID: 'G' }], account: { name: 'w' } } };
  assert.equal(filterSessionObjectItems(buildSessionObjectItems(app), alwaysTrue, app._state).length, 5);
});

test('CONTROL: the null-grant variant is wrong at root, and this spec says so', () => {
  // The variant I first recommended: grant every null scopeSessionID as "the
  // account carve-out". It survives the leaf case, so only the root case
  // catches it. Measured: root drops to 1.
  let nullGrant = (item, scopeSessionID) =>
    scopeSessionID === null ? true : isSessionVisibleTo('G', scopeSessionID, SESSIONS);

  // Leaf view: looks fine (the cluster is all self-scoped, plus the chip).
  let leaf = { _state: { navigationStack: [{ sessionID: 'G' }], account: { name: 'w' } } };
  assert.equal(filterSessionObjectItems(buildSessionObjectItems(leaf), nullGrant, leaf._state).length, 5);

  // Root view: every scoped row is null too, so this variant cannot tell the
  // global chip from a root-owned row and would grant an unrelated null row.
  let unrelated = [{ id: 'ghost', kind: 'button', scopeSessionID: null }];
  assert.equal(filterSessionObjectItems(unrelated, nullGrant, {}).length, 1,
    'null-grant keeps an unscoped row it should not vouch for');
  // The contract under test denies it, because identity is the only carve-out.
  assert.equal(filterSessionObjectItems(unrelated, scopeFilterFor('G'), {}).length, 0);
});
