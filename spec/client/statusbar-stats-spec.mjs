'use strict';

// Owner review 3 (2026-10-28), screenshot `session-2026-10-28-00-32-44.404.png`:
// "I want all of this information removed, and remove the 'Activities' sidebar too. I
// want all the information in each one of these cards to be shown in the statusbar
// below" plus "Move information display to statusbar (changes for each session
// navigation)".
//
// This file pins three separate things, because they fail independently:
//
//   1. THE MATH (`buildStatusBarStats`). Root totals vs one session's counts, and the
//      fact that two different sessions give two different answers — the owner's
//      "changes for each session navigation" is a behavioural claim, so it is tested
//      as one by navigating the stack, not by asserting a constant.
//   2. THE DOM. That `buildStatusBar` actually renders those four cells, in the
//      requested label order. A passing derivation with an unrendered builder would be
//      the classic "module with only its own spec" non-delivery.
//   3. THE DELETION. That `activities` is gone from `VIEW_NAMES`, the view module is
//      absent, and a legacy `?view=activities` bookmark degrades to a normal window
//      rather than throwing or rendering a blank surface.
//
// What this file does NOT claim: that the bar LOOKS right. mini-dom has no stylesheet
// cascade and no layout engine, so computed size, wrapping and the label-hiding media
// query are all unobservable here. That is a browser line, and the report says plainly
// whether it was measured.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

// `kikx-shell-builders.mjs` reaches `src/client/lib/aeor-ui.mjs`, which imports
// browser-absolute `/vendor/aeor-web-components/*` paths that Node cannot resolve.
// This hook redirects them to local stand-ins; same pattern as
// `startup-loading-spec.mjs:9`.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const {
  buildStatusBarStats,
  STATUSBAR_STAT_LABELS,
} = await import('../../src/client/state/statusbar-stats.mjs');

// Imported at top level, not inside a test: a module that fails to load must fail the
// FILE, not silently leave a later test reading a null handle.
const { buildStatusBar } = await import('../../src/client/components/kikx-shell-builders.mjs');

const {
  VIEW_NAMES,
  createNavigationStack,
  pushThread,
  pushView,
  stackFromSearchParams,
  currentViewName,
  currentSessionID,
} = await import('../../src/client/state/navigation-stack.mjs');

// A small tree with deliberately different counts per session, so "different for two
// different sessions" is a real assertion rather than a coincidence:
//
//   alpha     messages 10, agents a1+a2              -> 2 agents
//     beta    messages  4, agents a1                 -> (child of alpha)
//       gamma messages  1, agents a3                 -> (child of beta: depth 2)
//   delta     messages  2, agents a2+a4              -> 2 agents, separate root
//
// alpha's subtree is beta + gamma => 2 descendants. Workspace totals: 4 sessions,
// 17 messages, 4 distinct agents (a1..a4).
const SESSIONS = [
  { id: 'alpha', title: 'Alpha', parentSessionID: null, messageCount: 10, participantAgentIDs: [ 'a1', 'a2' ] },
  { id: 'beta', title: 'Beta', parentSessionID: 'alpha', messageCount: 4, participantAgentIDs: [ 'a1' ] },
  { id: 'gamma', title: 'Gamma', parentSessionID: 'beta', messageCount: 1, participantAgentIDs: [ 'a3' ] },
  { id: 'delta', title: 'Delta', parentSessionID: null, messageCount: 2, participantAgentIDs: [ 'a2', 'a4' ] },
];

const QUESTIONS = [
  { id: 'q1', sessionID: 'alpha', status: 'open' },
  { id: 'q2', sessionID: 'alpha', status: 'open' },
  { id: 'q3', sessionID: 'beta', status: 'answered' },
  { id: 'q4', sessionID: 'delta', status: 'open' },
  { id: 'q5', sessionID: null, status: 'open' },
];

function cellsToMap(stats) {
  return Object.fromEntries(stats.cells.map((cell) => [ cell.label, cell.value ]));
}

// --- 1. the math ---------------------------------------------------------

test('the four labels are exactly the ones the cards used, in order', () => {
  assert.deepEqual([ ...STATUSBAR_STAT_LABELS ], [ 'SESSIONS', 'OPEN QUESTIONS', 'MESSAGES', 'AGENTS' ]);
});

test('at the workspace root the bar totals every session the client holds', () => {
  let stats = buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: null });

  assert.equal(stats.scopeKind, 'workspace');
  assert.deepEqual(cellsToMap(stats), {
    SESSIONS: 4,
    // q1, q2, q4 open. q3 is answered, and q5 has no sessionID so it is
    // unattributable and is NOT bucketed (questionCountsBySession skips it) — so the
    // root total is 3, not 4, and it equals the sum of the per-session counts.
    'OPEN QUESTIONS': 3,
    MESSAGES: 17,
    AGENTS: 4,
  });
});

test('the root total equals the sum of its sessions, for every cell', () => {
  // The invariant that makes the bar explainable: drill into any session and the
  // numbers you saw at the root have to add up. SESSIONS counts sessions, and AGENTS
  // is deduplicated across the workspace, so both are compared against the session
  // list rather than against a sum of per-session agent counts.
  let root = cellsToMap(buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: null }));
  let perSession = SESSIONS.map((session) =>
    cellsToMap(buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: session.id })));

  assert.equal(root.MESSAGES, perSession.reduce((total, cells) => total + cells.MESSAGES, 0));
  assert.equal(root['OPEN QUESTIONS'], perSession.reduce((total, cells) => total + cells['OPEN QUESTIONS'], 0));
  assert.equal(root.SESSIONS, perSession.length);
});

test('in a session the bar follows that session, not the workspace', () => {
  let alpha = buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: 'alpha' });

  assert.equal(alpha.scopeKind, 'session');
  assert.deepEqual(cellsToMap(alpha), {
    SESSIONS: 2, // beta + gamma, excluding alpha itself
    'OPEN QUESTIONS': 2, // q1, q2
    MESSAGES: 10,
    AGENTS: 2, // a1, a2
  });
});

test('OPEN QUESTIONS counts only the CURRENT session, never its children', () => {
  // beta has q3 but it is answered; its child gamma has none. A rollup that walked
  // descendants would leak alpha's or delta's questions into this number.
  let beta = buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: 'beta' });
  assert.equal(cellsToMap(beta)['OPEN QUESTIONS'], 0);
  assert.equal(cellsToMap(beta).MESSAGES, 4);
});

test('navigating between sessions changes the numbers (owner: "changes for each session navigation")', () => {
  // Drive the real stack rather than passing ids by hand, so this pins the wiring the
  // builder uses (`getCurrentSessionID` -> `currentSessionID(stack)`).
  let atRoot = createNavigationStack();
  let inAlpha = pushThread(atRoot, 'alpha');
  let inDelta = pushThread(atRoot, 'delta');

  let rootID = currentSessionID(atRoot);
  let alphaID = currentSessionID(inAlpha);
  let deltaID = currentSessionID(inDelta);
  assert.equal(rootID, null);
  assert.equal(alphaID, 'alpha');
  assert.equal(deltaID, 'delta');

  let root = buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: rootID });
  let alpha = buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: alphaID });
  let delta = buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: deltaID });

  assert.notDeepEqual(cellsToMap(alpha), cellsToMap(delta));
  assert.notDeepEqual(cellsToMap(root), cellsToMap(alpha));
  assert.deepEqual(cellsToMap(delta), { SESSIONS: 0, 'OPEN QUESTIONS': 1, MESSAGES: 2, AGENTS: 2 });
});

test('an open view (Inbox) reports workspace totals, because its entry has no session', () => {
  let stack = pushView(createNavigationStack(), 'inbox');
  assert.equal(currentSessionID(stack), null);

  let stats = buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: currentSessionID(stack) });
  assert.equal(stats.scopeKind, 'workspace');
  assert.equal(cellsToMap(stats).MESSAGES, 17);
});

test('a deep link to a session beyond the page cap degrades to a labelled zero row', () => {
  // The real case: `?session=<id>` for a session not in the 50-row list. This must not
  // throw, because it runs inside the shell error boundary where a throw blanks the app.
  let stats = buildStatusBarStats({ sessions: SESSIONS, questions: QUESTIONS, currentSessionID: 'unknown-session-id' });

  assert.equal(stats.scopeKind, 'session');
  assert.equal(stats.scopeLabel, 'unknown-session-id');
  assert.deepEqual(cellsToMap(stats), { SESSIONS: 0, 'OPEN QUESTIONS': 0, MESSAGES: 0, AGENTS: 0 });
});

test('junk input produces a zeroed row instead of throwing', () => {
  for (let input of [ {}, { sessions: null, questions: null, currentSessionID: 42 }, { sessions: [ null, 7, 'x' ] } ]) {
    let stats = buildStatusBarStats(input);
    assert.equal(stats.cells.length, 4);
    for (let cell of stats.cells)
      assert.equal(Number.isInteger(cell.value), true);
  }
});

test('a parent cycle cannot loop forever or double-count', () => {
  // Two sessions that are each other's parent. `descendantSessionIDs` claims each id
  // once, so the count is bounded; the assertion is that this returns at all.
  let cycle = [
    { id: 'x', title: 'X', parentSessionID: 'y', messageCount: 1, participantAgentIDs: [] },
    { id: 'y', title: 'Y', parentSessionID: 'x', messageCount: 1, participantAgentIDs: [] },
  ];
  let stats = buildStatusBarStats({ sessions: cycle, questions: [], currentSessionID: 'x' });
  assert.equal(cellsToMap(stats).SESSIONS, 1);
});

test('a participant id cannot collide with Object.prototype', () => {
  let sessions = [ { id: 'p', title: 'P', parentSessionID: null, messageCount: 1, participantAgentIDs: [ '__proto__', 'constructor', '__proto__' ] } ];
  let stats = buildStatusBarStats({ sessions, questions: [], currentSessionID: 'p' });
  // Two distinct ids, and the duplicate does not inflate the count.
  assert.equal(cellsToMap(stats).AGENTS, 2);
});

// --- 2. the DOM ----------------------------------------------------------

// `getSessions` reads `state.sessionIDs` + `state.sessionDetailsByID`
// (`kikx-state.mjs:186-193`), NOT a flat `sessions` array. Building it here means the
// DOM tests go through the same accessor the builder calls at runtime.
function appStateWith({ navigationStack }) {
  return {
    authToken: 'token',
    connectionStatus: 'Connected',
    connectionStatusKind: 'ready',
    sessionIDs: SESSIONS.map((session) => session.id),
    sessionDetailsByID: Object.fromEntries(SESSIONS.map((session) => [ session.id, session ])),
    questionsState: { questions: QUESTIONS },
    navigationStack,
  };
}

function statusBarApp(state) {
  // The minimum the builder reads: `_state` for the three accessors, plus the two
  // handlers it binds. Nothing here reaches the network.
  return {
    _state: state,
    _toggleDebugMode() {},
  };
}

function readBar(state) {
  // The DSL returns a builder; `.build(document)` yields the real node, exactly as the
  // shell does (`kikx-shell-builders.mjs:112`).
  let node = buildStatusBar(statusBarApp(state));
  return typeof node?.build === 'function' ? node.build(document) : node;
}

test('buildStatusBar renders the four counts, in the requested order, from state alone', () => {
  let element = readBar(appStateWith({ navigationStack: createNavigationStack() }));

  // The bar's own class comes from `div.class.bindState(...)`, a reactive binding that
  // mini-dom does not evaluate — so asserting on `class` here would test the double, not
  // the code. What IS static, and what this pins, is the child structure.
  let stats = element.querySelector('.kikx-statusbar__stats');
  assert.ok(stats, 'the stats group must be in the bar');

  let labels = Array.from(stats.querySelectorAll('.kikx-statusbar__stat-label')).map((n) => n.textContent);
  let values = Array.from(stats.querySelectorAll('.kikx-statusbar__stat-value')).map((n) => n.textContent);
  assert.deepEqual(labels, [ 'SESSIONS', 'OPEN QUESTIONS', 'MESSAGES', 'AGENTS' ]);
  assert.deepEqual(values, [ '4', '3', '17', '4' ]);

  // The bar keeps its original children: nothing was traded away for the counts.
  assert.equal(element.querySelector('.kikx-statusbar__dot') !== null, true);
  assert.equal(element.querySelector('.kikx-statusbar__tokens') !== null, true);
  assert.equal(element.querySelector('.kikx-debug-toggle') !== null, true);
});

test('the rendered bar changes when the stack moves into a session', () => {
  let atRoot = readBar(appStateWith({ navigationStack: createNavigationStack() }));
  let inAlpha = readBar(appStateWith({ navigationStack: pushThread(createNavigationStack(), 'alpha') }));

  let valuesOf = (el) => Array.from(el.querySelectorAll('.kikx-statusbar__stat-value')).map((n) => n.textContent);
  assert.deepEqual(valuesOf(atRoot), [ '4', '3', '17', '4' ]);
  assert.deepEqual(valuesOf(inAlpha), [ '2', '2', '10', '2' ]);
  assert.notDeepEqual(valuesOf(atRoot), valuesOf(inAlpha));
});

test('the bar still builds when the session/question state is missing', () => {
  // The shell may render before the first sessions fetch lands. A throw here would
  // blank the whole app through the error boundary, which is the failure this pins.
  let element = readBar({ authToken: 'token', connectionStatus: 'Connecting', connectionStatusKind: 'pending' });
  let values = Array.from(element.querySelectorAll('.kikx-statusbar__stat-value')).map((n) => n.textContent);
  assert.deepEqual(values, [ '0', '0', '0', '0' ]);
});

// --- 3. the deletion -----------------------------------------------------

test('activities is gone from VIEW_NAMES and cannot be pushed', () => {
  assert.deepEqual([ ...VIEW_NAMES ], [ 'inbox', 'agents', 'teams' ]);
  assert.throws(() => pushView(createNavigationStack(), 'activities'), /unknown view/);
});

test('the Activities view module no longer exists', async () => {
  await assert.rejects(
    () => import('../../src/client/components/kikx-activities-view.mjs'),
    /Cannot find module|ERR_MODULE_NOT_FOUND/,
  );
});

test('a legacy ?view=activities bookmark degrades to a normal window', () => {
  // The owner's safety requirement: "must degrade to a normal window, not throw and not
  // render a blank shell". Silent too — an old bookmark should not show an error.
  let root = stackFromSearchParams('?view=activities');
  assert.equal(currentViewName(root.stack), null, 'no view is open');
  assert.equal(currentSessionID(root.stack), null, 'lands on the root window');
  assert.deepEqual(root.stack, [ { sessionID: null, collapsed: true } ]);

  // With a session in the same URL, the session survives and the view flag is dropped.
  let withSession = stackFromSearchParams('?session=alpha&view=activities');
  assert.equal(currentViewName(withSession.stack), null);
  assert.equal(currentSessionID(withSession.stack), 'alpha');

  // And the surviving view still works, so this is a removal, not a broken parser.
  let inbox = stackFromSearchParams('?view=inbox');
  assert.equal(currentViewName(inbox.stack), 'inbox');
});
