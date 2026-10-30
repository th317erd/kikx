'use strict';

// The sidebar scope seam is WIRED -- pinned through the real call path.
//
// Background, measured. `kikx-shell-builders.mjs` called
// `buildSidebarSessionObjects(app, { group: 'view' })` and `{ group: 'footer' }`
// with no `scopeFilter`. `filterSessionObjectItems` short-circuits to grant-all
// when handed no filter, so the whole session-scoping layer
// (`createSessionScope` / `filterItemsInScope` / `filterSessionsInScope`) had
// ZERO production callers: built, tested in isolation, and unreachable.
//
// It went unnoticed because the existing coverage cannot see it:
//
//   * `spec/ownership/sidebar-seam-spec.mjs` self-describes as pinning "the
//     CONTRACT, not the shell", and calls `filterSessionObjectItems` directly
//     with a filter it writes itself. It stays green against a dead seam.
//   * A rendered-output assertion cannot help either. Every non-chip descriptor
//     carries the VIEWED session's own id, so a correct predicate grants all of
//     them and the sidebar renders identically wired or not. "Looks the same"
//     is the expected outcome, not evidence.
//
// So these tests ask the only answerable question -- did the shell hand the seam
// a working predicate? -- at the module boundary, and then drive that captured
// predicate through the real filter. Everything here fails against a shell that
// passes nothing.
//
// The two traps the predicate must get right, both previously measured wrong:
//
//   1. `scopeSessionID === null` means BOTH "the global account chip" and
//      "project root, no session selected". Granting on null hides the
//      distinction; denying on null hides the chip. Carve out by item identity.
//   2. Root has no viewer id, so `createSessionScope(null)` yields an EMPTY
//      owner set (owners=[], owns(undefined)=false) and the raw predicate fails
//      closed. Root owns everything below it, so root must GRANT.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
// Records what the shell passes to the seam. Must be registered before the shell
// module is imported, or the shell would bind to the unrecorded original.
register(new URL('./support/sidebar-scope-spy-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const {
  seamCalls,
  resetSeamCalls,
  filterSessionObjectItems,
  buildSessionObjectItems,
  sidebarScopePredicateFor,
} = await import('./support/sidebar-scope-spy.mjs');
const { buildRunnerShell } = await import('../../src/client/components/kikx-shell-builders.mjs');
const { createNavigationStack, pushThread, pushView } =
  await import('../../src/client/state/navigation-stack.mjs');

// --- fixture ---------------------------------------------------------------

// P is the project root. C is P's child. G is C's child. S is P's other child --
// G's aunt, and the sibling that must never leak into G's scope.
const SESSIONS = [
  { id: 'P', parentSessionID: null },
  { id: 'C', parentSessionID: 'P' },
  { id: 'G', parentSessionID: 'C' },
  { id: 'S', parentSessionID: 'P' },
];

/**
 * The smallest app that can survive `buildRunnerShell`.
 *
 * The builders ask their selectors for real data; anything unimplemented here
 * returns null/[] exactly as the real selectors do when nothing has loaded.
 * `_state` is a plain object because every accessor takes it as an argument.
 *
 * Two fixture details that cost a debugging round each:
 *
 *   * `pushThread(stack, sessionID)` takes the ID STRING. Handed an object it
 *     ignores the argument and returns the stack unchanged, so every "inside a
 *     session" case silently rendered the project root instead.
 *   * The work area is always the Inbox view. `buildRunnerShell` otherwise falls
 *     through to `buildWindow`, and the root branch builds the session grid,
 *     which mini-dom cannot execute (`grid.update is not a function`). The Inbox
 *     view needs only `questionsState`, and it keeps the assertion aimed at the
 *     SIDEBAR rather than at an unrelated work-area builder.
 *
 * A view entry contributes no session id (`scopeSessionID` skips view entries),
 * so `appAt('G')` below is still "viewing G" and `appAt(null)` is still the
 * project root with no session selected.
 */
function appAt(sessionID) {
  let stack = createNavigationStack();
  if (sessionID)
    stack = pushThread(stack, sessionID);
  stack = pushView(stack, 'inbox');

  return {
    _state: {
      navigationStack: stack,
      sessions: SESSIONS,
      sessionIDs: SESSIONS.map((session) => session.id),
      sessionDetailsByID: Object.fromEntries(SESSIONS.map((session) => [ session.id, session ])),
      deletedSessionIDs: [],
      deletedSessionDetailsByID: {},
      sessionPreviews: {},
      account: { name: 'Wyatt' },
      questionsState: { questions: [], counts: {}, loaded: true },
      selectedSessionID: sessionID || null,
      openViewNames: [],
      frames: {},
      thinkingState: {},
      filterState: {},
    },
    _openAccountEditor() {},
    _openAgentManager() {},
    _openTeamManager() {},
    _signOut() {},
  };
}

function buildShellAt(sessionID) {
  resetSeamCalls();
  let nodes = buildRunnerShell(appAt(sessionID));

  return { nodes, calls: seamCalls.slice() };
}

// --- the seam is reached from a production entry point ---------------------

test('buildRunnerShell passes a real scope predicate to BOTH sidebar clusters', () => {
  let { calls } = buildShellAt('G');

  assert.equal(calls.length, 2,
    'the shell builds exactly two session-object clusters (view + footer)');

  let byGroup = Object.fromEntries(calls.map((call) => [ call.group, call ]));
  assert.ok(byGroup.view, 'the view cluster was built');
  assert.ok(byGroup.footer, 'the footer cluster was built');

  for (let group of [ 'view', 'footer' ]) {
    assert.equal(typeof byGroup[group].scopeFilter, 'function',
      `the ${group} cluster must be handed a scope filter, not left to grant-all`);
  }

  // Not just "some function": the thing handed over must actually scope.
  assert.equal(byGroup.view.scopeFilter({ id: 'agents', scopeSessionID: 'S' }, 'S'), false,
    'a row owned by an unrelated sibling session must be denied');
  assert.equal(byGroup.footer.scopeFilter({ id: 'account-chip', scopeSessionID: null }, null), true,
    'the global account chip survives at every level');
});

test('the predicate the shell hands over is the one this module defines', () => {
  // Guards against the shell passing a hand-rolled lambda that happens to answer
  // these two cases: the shipped predicate is the single source of truth, so a
  // change to its rules must be a change in one place.
  let { calls } = buildShellAt('G');
  let shellPredicate = calls.find((call) => call.group === 'view').scopeFilter;

  let reference = sidebarScopePredicateFor('G', SESSIONS);

  let probes = [
    [ { id: 'account-chip', scopeSessionID: null }, null ],
    [ { id: 'agents', scopeSessionID: 'G' }, 'G' ],
    [ { id: 'teams', scopeSessionID: 'C' }, 'C' ],
    [ { id: 'sign-out', scopeSessionID: 'S' }, 'S' ],
  ];

  for (let [ item, owner ] of probes) {
    assert.equal(shellPredicate(item, owner), reference(item, owner),
      `the shell's predicate disagrees with the module's for "${item.id}"`);
  }
});

// --- the two traps ---------------------------------------------------------

test('root grants the whole cluster, chip included -- it owns everything below it', () => {
  let { calls } = buildShellAt(null);
  let scopeFilter = calls.find((call) => call.group === 'view').scopeFilter;

  let items = buildSessionObjectItems(appAt(null));
  let kept = filterSessionObjectItems(items, scopeFilter);

  assert.equal(items.length, 5, 'the cluster has five descriptors');
  assert.equal(kept.length, 5,
    'root must not be filtered to nothing: createSessionScope(null) has an empty owner set, so a raw predicate would blank the sidebar here');

  let ids = kept.map((item) => item.id);
  for (let expected of [ 'account-chip', 'account', 'agents', 'teams', 'sign-out' ])
    assert.ok(ids.includes(expected), `root kept "${expected}"`);
});

test('the account chip is granted by IDENTITY, not by its null scope id', () => {
  // A viewer in the middle of the tree. Every non-chip row is owned by that
  // viewer, so granting them proves nothing about the null case; the chip is the
  // only row whose scope id is null, and it must still pass.
  let { calls } = buildShellAt('G');
  let scopeFilter = calls.find((call) => call.group === 'view').scopeFilter;

  assert.equal(scopeFilter({ id: 'account-chip', scopeSessionID: null }, null), true,
    'the global chip is granted because of what it IS');

  // A different row carrying the same null scope id is NOT global, and a viewer
  // with an id must not be granted it by accident.
  assert.equal(scopeFilter({ id: 'agents', scopeSessionID: null }, null), false,
    'null scope is not a blanket grant -- only the named global rows are');
});

test('a viewer sees its own rows and is denied a foreign one', () => {
  let { calls } = buildShellAt('G');
  let scopeFilter = calls.find((call) => call.group === 'view').scopeFilter;

  assert.equal(scopeFilter({ id: 'agents', scopeSessionID: 'G' }, 'G'), true, 'own row');
  assert.equal(scopeFilter({ id: 'teams', scopeSessionID: 'C' }, 'C'), true,
    'an ancestor owns rows the descendant may see');
  assert.equal(scopeFilter({ id: 'sign-out', scopeSessionID: 'S' }, 'S'), false,
    'an aunt session is not visible to G');
  assert.equal(scopeFilter({ id: 'sign-out', scopeSessionID: 'G' }, 'G2'), false,
    'a sibling is not visible either');
});

test('the seam this spec drives is the one the shell builds, and it keeps order', () => {
  let { calls } = buildShellAt('G');
  let scopeFilter = calls.find((call) => call.group === 'view').scopeFilter;

  let items = buildSessionObjectItems(appAt('G'));
  let kept = filterSessionObjectItems(items, scopeFilter);

  assert.deepEqual(kept.map((item) => item.id), items.map((item) => item.id),
    'a filter, never a re-sort: the sidebar order the builder chose survives');

  // The reachability claim, stated directly: a row owned by a session outside
  // `{G} + ancestors(G)` is dropped by the SAME predicate the shell passed in.
  // This is the behaviour the wiring exists for; no builder emits such a row
  // today, which is why the rendered sidebar cannot demonstrate it.
  let withForeign = [ ...items, { id: 'foreign', kind: 'button', group: 'view', scopeSessionID: 'S', label: 'S' } ];
  let filtered = filterSessionObjectItems(withForeign, scopeFilter);

  assert.equal(filtered.length, items.length, 'exactly the foreign row was dropped');
  assert.ok(!filtered.some((item) => item.id === 'foreign'),
    'a row owned by an invisible session must not reach the sidebar');
});
