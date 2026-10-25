'use strict';

// Child sessions render inside their parent's session window.
//
// The defect this replaces: `c70aeb8` swapped the header's grid-of-dots toggle
// for the frame-filter popup, and the popup's footer carried a "Child sessions
// (n)" action wired to `showSubSessions`. That action set `collapsed` on the
// current stack entry, and `buildWindow` then rendered `buildChildGrid` *instead
// of* `buildThreadSection` -- the conversation was destroyed, and nothing in the
// collapsed grid cleared the flag again. `expandCurrent` existed, was bound on
// the app, and was rendered nowhere. `collapsed=1` round-tripped through the URL,
// so reload kept it.
//
// The escape hatch that a first attempt at this fix added (a `kikx-window__view-
// toggle` pressed-state button) was rejected: a session view is meant to show
// everything about that session, so a second surface is the bug, not a missing
// exit. The swap was deleted instead, and children moved inline.
//
// Verified in a real browser against :3001 before the swap was removed: the
// collapsed grid itself offered no control that returned to its own thread.
// "Close session" pops the entry and reopening goes through `pushThread`, which
// is leave-and-find-it-again -- which is why the owner experienced lock-in while
// a control technically existed.
//
// So these assert the outcome, in the order that matters:
//
//   1. the session view renders the thread and the children at the same time,
//   2. there is no view toggle and no popup footer action to re-enter the swap,
//   3. every level has a create button, to the right of the eyeball,
//   4. a legacy `?collapsed=1` URL lands on the thread, with no collapsed state
//      reachable from the parsed stack.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
document.addEventListener = () => {};
document.removeEventListener = () => {};
globalThis.document = document;

await import('../../src/client/components/kikx-frame-filter-popup.mjs');
// The grid is a custom element; importing it defines the tag so a built node
// actually renders cards instead of staying an inert unknown element.
await import('../../src/client/components/kikx-session-grid.mjs');

const { buildThreadSection, buildWindow, buildWindowHeader, buildChildSessionsRegion } =
  await import('../../src/client/components/kikx-shell-builders.mjs');
const { stackFromSearchParams } = await import('../../src/client/state/navigation-stack.mjs');

const SESSIONS = [
  { id: 'parent_1', parentSessionID: null, title: 'Parent' },
  { id: 'child_1', parentSessionID: 'parent_1', title: 'Child One' },
  { id: 'child_2', parentSessionID: 'parent_1', title: 'Child Two' },
  { id: 'unrelated', parentSessionID: null, title: 'Not A Child' },
];

// --- helpers ---------------------------------------------------------------

function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object')
    return found;

  if (predicate(node))
    found.push(node);

  for (let child of node.childNodes || [])
    walk(child, predicate, found);

  return found;
}

function classesOf(node) {
  return String(node?.className || '').split(/\s+/).filter(Boolean);
}

function byClass(root, className) {
  return walk(root, (node) => classesOf(node).includes(className));
}

function byTag(root, tagName) {
  return walk(root, (node) => String(node?.tagName || '').toLowerCase() === tagName.toLowerCase());
}

// Build through the framework builder so state-bound attributes are applied from
// the app state the real app would hand them, exactly as the browser does.
function build(node, app) {
  node = typeof node?.build === 'function' ? node.build(document, app?._state) : node;
  document.body.replaceChildren();
  document.body.appendChild(node);
  return node;
}

/**
 * A minimal app double. `_createSession` is the real entry the header button
 * calls (`kikx-app.mjs` binds it to `createSession`, which parents the new
 * session to `getGridParentSessionID` -- the current session). Recording the
 * call proves the button is wired to that handler rather than reimplementing
 * creation.
 */
function makeApp({ sessions = SESSIONS, selectedSessionID = 'parent_1' } = {}) {
  let calls = { create: 0 };
  return {
    calls,
    _state: {
      // The shape kikx-state reads: live sessions are ids resolved through a
      // details map, and the soft-deleted bucket is a separate id list.
      sessionIDs: sessions.map((session) => session.id),
      sessionDetailsByID: Object.fromEntries(sessions.map((session) => [ session.id, session ])),
      deletedSessionIDs: [],
      deletedSessionDetailsByID: {},
      selectedSessionID,
      navigationStack: [
        { sessionID: null, collapsed: true },
        { sessionID: 'parent_1', collapsed: false },
      ],
      editingSessionNameID: '',
      sessionSearch: '',
      previewsLoading: false,
      previewStatus: '',
      debugMode: false,
      frameFilters: null,
      frameCountsBySessionID: {},
      deletedSessions: [],
      sessionPreviews: new Map(),
      framesBySessionID: { parent_1: [] },
      agentDetailsByID: {},
    },
    _createSession() { calls.create += 1; },
    _selectedSession: () => sessions.find((s) => s.id === 'parent_1') || null,
    _beginSessionNameEdit: () => {},
    _onSessionNameKeydown: () => {},
    _commitSessionName: () => {},
    _toggleComposerHistory: () => {},
    _onComposerKeydown: () => {},
    _syncDraft: () => {},
    _onSubmit: () => {},
    _cancelAgents: () => {},
    _openSessionFromCard: () => {},
    _deleteSession: () => {},
    _restoreSession: () => {},
    _setFrameFilters: () => {},
    _activeComposerDraftSessionID: '',
    _deletingSessionIDs: new Set(),
  };
}

// --- 1. the thread and its children are on screen together -----------------

test('a session view renders its thread and its child sessions at the same time', () => {
  let app = makeApp();
  let view = build(buildThreadSection(app, 'parent_1'), app);

  // Both halves, in one window. The old swap could satisfy only one of these:
  // the collapsed grid replaced `.kikx-thread__body` outright.
  assert.equal(byClass(view, 'kikx-thread__body').length, 1,
    'the conversation must still be rendered inside the session view');
  assert.equal(byClass(view, 'kikx-thread__children').length, 1,
    'child sessions must be rendered inline, inside the same window');
});

test('the inline row sits between the header and the thread body', () => {
  let app = makeApp();
  let view = build(buildThreadSection(app, 'parent_1'), app);

  let order = (view.childNodes || []).map((child) => classesOf(child)[0] || String(child.tagName || '').toLowerCase());
  let header = order.indexOf('kikx-window__header');
  let region = order.indexOf('kikx-thread__children');
  let body = order.indexOf('kikx-thread__body');

  assert.ok(header >= 0, 'the window header is rendered');
  assert.ok(region > header, 'the child row comes after the header');
  assert.ok(body > region, 'the thread body comes after the child row');
});

test('the inline row lists exactly this session\'s children, narrowed by the grid', () => {
  let app = makeApp();
  let region = build(buildChildSessionsRegion(app, 'parent_1'), app);

  // Query the mounted tree rather than walking `childNodes`: the grid element
  // re-parents its cards while painting (`textContent = ''` then append), so a
  // snapshot walk taken mid-paint can miss them. `querySelector` reads the live
  // tree, which is what a person actually sees.
  let grid = region.querySelector('kikx-session-grid');
  assert.ok(grid, 'the row reuses the session grid rather than a bespoke component');

  let ids = Array.from(grid.querySelectorAll('kikx-session-card')).map((card) => card.sessionID);
  assert.deepEqual(ids, [ 'child_1', 'child_2' ],
    'children of this session only -- not siblings, not the parent');
  assert.equal(ids.includes('unrelated'), false);
});

test('the row always carries the add card, even when the session has no children', () => {
  let empty = makeApp({
    sessions: [ { id: 'parent_1', parentSessionID: null, title: 'Parent' } ],
  });
  let region = build(buildChildSessionsRegion(empty, 'parent_1'), empty);
  let grid = region.querySelector('kikx-session-grid');

  assert.ok(grid.querySelector('.kikx-session-card--add'),
    'without the add card a childless session would have no inline route to creating a child');
});

test('opening the add card asks the app to create a child session', () => {
  let app = makeApp();
  let region = build(buildChildSessionsRegion(app, 'parent_1'), app);
  let grid = region.querySelector('kikx-session-grid');

  grid.querySelector('.kikx-session-card--add')
    .dispatchEvent(new Event('kikx-card-add', { bubbles: true, composed: true }));

  assert.equal(app.calls.create, 1, 'creation goes through the app handler');
});

// --- 2. the swap is gone ----------------------------------------------------

test('the header no longer offers a chat/child-grid view toggle', () => {
  let app = makeApp();
  let header = build(buildWindowHeader(app, { title: 'Parent', sessionID: 'parent_1' }), app);

  assert.equal(byClass(header, 'kikx-window__view-toggle').length, 0,
    'a toggle is the deviation the owner rejected: everything belongs in the session view');
});

test('the frame filter popup no longer carries a child-sessions entry point', () => {
  let app = makeApp();
  let header = build(buildWindowHeader(app, { title: 'Parent', sessionID: 'parent_1' }), app);
  let [popup] = byTag(header, 'kikx-frame-filter-popup');

  assert.ok(popup, 'the eyeball stays: it narrows the thread, it is not a mode switch');
  popup.configure({ app, appState: app._state, sessionID: 'parent_1' });
  popup._open({ focus: false });

  assert.equal(popup.querySelector('[data-filter-action="child-sessions-grid"]'), null,
    'the footer action existed only because the grid was the only place "+ Add Session" lived');
  assert.equal(popup.querySelector('.kikx-frame-filter__footer'), null);
});

// --- 3. a create button at every level, right of the eyeball ---------------

test('a session window offers "+ Add Session" to the right of the eyeball', () => {
  let app = makeApp();
  let header = build(buildWindowHeader(app, { title: 'Parent', sessionID: 'parent_1' }), app);

  let [add] = byClass(header, 'kikx-window__add');
  assert.ok(add, 'there must always be a way to create a session');
  assert.equal(add.tagName, 'BUTTON');
  assert.equal(add.getAttribute('type'), 'button');
  assert.match(add.textContent, /Add Session/);

  let actions = byClass(header, 'kikx-window__actions')[0];
  let children = Array.from(actions.childNodes || []);
  let eye = children.findIndex((node) => String(node.tagName || '').toLowerCase() === 'kikx-frame-filter-popup');
  let addIndex = children.indexOf(byClass(actions, 'kikx-window__add')[0]);
  assert.ok(eye >= 0 && addIndex > eye, 'the create button sits to the right of the eyeball');

  add.dispatchEvent({ type: 'click', bubbles: true });
  assert.equal(app.calls.create, 1, 'it creates through the app, not a bespoke path');
});

test('the root grid offers "+ Add Project" instead, and still offers something', () => {
  let app = makeApp({ selectedSessionID: '' });
  let header = build(buildWindowHeader(app, { title: 'Projects' }), app);

  let [add] = byClass(header, 'kikx-window__add');
  assert.ok(add, 'the root is a level too');
  assert.match(add.textContent, /Add Project/);

  add.dispatchEvent({ type: 'click', bubbles: true });
  assert.equal(app.calls.create, 1);
});

// --- 4. old URLs land on the thread ----------------------------------------

test('a legacy ?collapsed=1 URL parses without producing a collapsed session entry', () => {
  let parsed = stackFromSearchParams('?session=parent_1&collapsed=1');

  assert.equal(parsed.stack.at(-1).sessionID, 'parent_1', 'the session still opens');
  assert.equal(parsed.stack.at(-1).collapsed, false,
    'the flag must be ignored, not honoured: the view it selected no longer exists');
});

test('a bookmarked ?collapsed=1 URL renders the thread, not a child grid', () => {
  let app = makeApp();
  let parsed = stackFromSearchParams('?session=parent_1&collapsed=1');
  let entry = parsed.stack.at(-1);

  let view = build(buildWindow(app, entry), app);

  assert.equal(byClass(view, 'kikx-thread__body').length, 1,
    'a trapped tab that reloads must land in the conversation');
  assert.equal(byClass(view, 'kikx-workspace').length, 0,
    'the replaced-view container must not come back for a session');
});

test('the legacy ?view=sub-sessions flag is ignored the same way', () => {
  let parsed = stackFromSearchParams('?session=parent_1&view=sub-sessions');

  assert.equal(parsed.stack.at(-1).collapsed, false);
  assert.notEqual(parsed.view, 'sub-sessions', 'it is not a view name the stack can address');
});
