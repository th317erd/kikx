'use strict';

// The boundary the two existing scope specs both miss.
//
// `spec/ownership/sidebar-seam-spec.mjs` pins the CONTRACT: it supplies its own
// filter and receives `scopeSessionID` as the second argument, so it never calls
// `sessionIDOf`. `spec/ownership/session-scope-filter-spec.mjs` pins
// `sessionIDOf` against the four field names it already supported. Between those
// two green specs sits the real seam — a descriptor BUILT BY THE SIDEBAR arriving
// at the predicate that will filter it — and nobody tested it.
//
// Measured at HEAD ddfbc733: `buildSessionObjectItems` stamps every descriptor
// with `scopeSessionID`, while `sessionIDOf` read sessionID / sessionId /
// ownerSessionID / ownerSessionId. So every real descriptor resolved to '' and
//
//     createSessionScope(viewer).filter(buildSessionObjectItems(app))  -> 0 of 4
//
// for every viewer, which is a blank sidebar rather than a scoped one.
//
// This spec therefore asserts on REAL built descriptors, never on hand-written
// rows: a hand-written row is exactly how the blind spot survived. If someone
// renames the descriptor field again without teaching `sessionIDOf`, this fails.
//
// Importing the component directly does not work in Node (aeor-ui.mjs imports
// the browser-absolute `/vendor/aeor-web-components/elements.js`), so the loader
// below is the same harness the sibling specs use.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from '../client/support/mini-dom.mjs';

register(new URL('../client/support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { buildSessionObjectItems } =
  await import('../../src/client/components/kikx-sidebar-session-objects.mjs');
const { sessionIDOf, createSessionScope, isSessionVisibleTo } =
  await import('../../src/client/state/session-scope.mjs');

// P is the project root, C its child, G C's child, S P's other child (the aunt
// that must never leak into G's view).
const SESSIONS = [
  { id: 'P', parentSessionID: null },
  { id: 'C', parentSessionID: 'P' },
  { id: 'G', parentSessionID: 'C' },
  { id: 'S', parentSessionID: 'P' },
];

const appViewing = (sessionID) => ({
  _state: {
    navigationStack: sessionID ? [ { type: 'session', sessionID } ] : [],
    account: { name: 'w' },
  },
});

test('the descriptor field the sidebar writes is the field the predicate reads', () => {
  // This is the seam, stated as plainly as it can be. Both halves are read from
  // the real modules, so a rename on either side breaks this line.
  let items = buildSessionObjectItems(appViewing('G'));
  let agents = items.find((item) => item.id === 'agents');

  assert.equal(agents.scopeSessionID, 'G', 'the sidebar stamps scopeSessionID');
  assert.equal(sessionIDOf(agents), 'G', 'and the predicate must resolve it to the same id');
});

test('every built descriptor resolves to its own scope, not to empty', () => {
  for (let viewer of [ 'P', 'C', 'G', 'S' ]) {
    let items = buildSessionObjectItems(appViewing(viewer));
    for (let item of items) {
      if (item.id === 'account-chip')
        continue;                     // unscoped on purpose, asserted separately

      assert.equal(sessionIDOf(item), viewer,
        `${item.id} viewed from ${viewer} must resolve to ${viewer}`);
    }
  }
});

test('a real cluster survives the predicate at a leaf, and root keeps everything', () => {
  // THE REGRESSION, stated precisely. Two facts have to be asserted separately
  // because they fail for different reasons:
  //
  //   1. The four SCOPED controls must survive ownership. Before the field fix
  //      they resolved to '' and all four vanished — which is the blank sidebar.
  //   2. The account chip is unscoped (scopeSessionID === null), so ownership
  //      can never vouch for it. Keeping it needs the identity carve-out on top,
  //      which is the seam spec's trap 1.
  //
  // Asserting "5 of 5" from the bare scope would blur those together and, as
  // measured, fails at the leaf for the legitimate reason.
  let scopedIDs = [ 'account', 'agents', 'teams', 'sign-out' ];

  for (let viewer of [ 'G', 'C', 'P' ]) {
    let app = appViewing(viewer);
    let items = buildSessionObjectItems(app);
    let kept = createSessionScope(viewer, SESSIONS).filter(items);

    assert.deepEqual(kept.map((item) => item.id), scopedIDs,
      `viewer ${viewer} must keep all four scoped controls (pre-fix: none of them)`);
  }

  // The contract the shell owner must implement, exactly as sidebar-seam-spec
  // states it: identity carve-out first, then the rule.
  let scopeFilterFor = (viewer) => (item, scopeSessionID) => {
    if (item?.id === 'account-chip')
      return true;
    if (viewer == null)
      return true;
    return isSessionVisibleTo(viewer, scopeSessionID, SESSIONS);
  };

  for (let viewer of [ 'G', 'C', 'P', null ]) {
    let app = appViewing(viewer);
    let kept = buildSessionObjectItems(app).filter((item) => scopeFilterFor(viewer)(item, item.scopeSessionID));

    assert.equal(kept.length, 5,
      `viewer ${String(viewer)} keeps all five through the contract filter, kept: ${kept.map((i) => i.id).join(',') || '(none)'}`);
    assert.equal(kept[0].id, 'account-chip', 'the account chip stays first');
  }
});

test('the account chip is unscoped, so it is denied by ownership and kept by identity', () => {
  // Pins WHY the chip needs a carve-out rather than a null-grant: it carries no
  // owner at all, so no ownership predicate can ever vouch for it.
  let chip = buildSessionObjectItems(appViewing('G')).find((item) => item.id === 'account-chip');

  assert.equal(chip.scopeSessionID, null);
  assert.equal(sessionIDOf(chip), '', 'an unscoped item has no owner id');
  assert.equal(isSessionVisibleTo('G', chip.scopeSessionID), false,
    'ownership denies it, which is why the carve-out is by identity');
});

test('a sibling-owned descriptor is still denied, so the fix did not widen scope', () => {
  // The fix must make real rows survive WITHOUT making unrelated rows survive.
  let sibling = [ { id: 'ghost', kind: 'button', scopeSessionID: 'S' } ];

  assert.equal(createSessionScope('G', SESSIONS).filter(sibling).length, 0);
  assert.equal(createSessionScope('C', SESSIONS).filter(sibling).length, 0);
  assert.equal(createSessionScope('P', SESSIONS).filter(sibling).length, 0,
    'a parent may not use a child-branch item');
  assert.equal(createSessionScope('S', SESSIONS).filter(sibling).length, 1,
    'CONTROL: the same row IS visible to its own owner, so the denials above are not vacuous');
});

test('the descendant/sibling direction is unchanged by the field fix', () => {
  assert.equal(createSessionScope('C', SESSIONS).filter([ { id: 'x', scopeSessionID: 'G' } ]).length, 0,
    'a parent may not see a descendant-owned row');
  assert.equal(createSessionScope('G', SESSIONS).filter([ { id: 'x', scopeSessionID: 'C' } ]).length, 1,
    'a child may see its ancestor-owned row');
});
