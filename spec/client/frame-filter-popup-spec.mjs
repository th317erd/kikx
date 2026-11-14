'use strict';

// DOM wiring for the eyeball filter popup. mini-dom has no CSS cascade and no
// layout, so these tests assert structure, state and handler behaviour only.
// Anything about how it *looks* belongs in the browser lane.

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

const { document } = installDom();
document.addEventListener = () => {};
document.removeEventListener = () => {};
globalThis.document = document;

const { KikxFrameFilterPopup, framesWouldRender } = await import('../../src/client/components/kikx-frame-filter-popup.mjs');
const { CATEGORY_ROWS, FILTER_KEYS, FILTER_ROWS, defaultFrameFilters, everyFilterOn, noFilterOn } =
  await import('../../src/client/lib/frame-filters.mjs');

// The view-level toggles the panel renders under its Hidden gate, in the order
// the owner named them. Declared here rather than imported because they are the
// popup's own DOM contract, not part of the filter model in frame-filters.mjs:
// they never enter `frameFilters`.
const VIEW_ROW_KEYS = [ 'raw', 'debug' ];

// Counts come from the server (`GET /frame-counts`), never from the frames the
// browser happens to hold: the panel used to show Agent 60 beside User 0 and
// Tools 0 because it described the loaded page instead of the session. So the
// fake app carries `frameCountsBySessionID`, and `frames` here only models what
// has been loaded -- it must not move a badge.
function makeApp(frames = [], counts = null) {
  let app = {
    _state: {
      framesBySessionID: { ses_1: frames },
      frameCountsBySessionID: counts ? { ses_1: { counts } } : {},
      frameFilters: defaultFrameFilters(),
      // View-level toggles, not filters: they change HOW frames render.
      rawMarkdown: false,
      debugMode: false,
    },
    _frameFilterPopupOpen: false,
    applied: [],
    countRequests: [],
  };
  app._loadFrameCounts = (sessionID) => {
    app.countRequests.push(sessionID);
    return Promise.resolve(counts);
  };
  app._setFrameFilters = (next) => {
    app.applied.push(next);
    app._state.frameFilters = next;
  };
  return app;
}

function mount(app) {
  let popup = document.createElement('kikx-frame-filter-popup');
  popup.configure({ app, appState: app._state, sessionID: 'ses_1' });
  document.body.appendChild(popup);
  return popup;
}

function click(input, init = {}) {
  let event = new Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey === true });
  Object.defineProperty(event, 'metaKey', { value: init.metaKey === true });
  Object.defineProperty(event, 'shiftKey', { value: init.shiftKey === true });
  input.dispatchEvent(event);
  return event;
}

test('the popup button carries an eyeball glyph, not the old dot grid', () => {
  let popup = mount(makeApp());
  let button = popup.querySelector('.kikx-frame-filter__button');
  assert.ok(button, 'button exists');
  assert.equal(button.querySelectorAll('.kikx-grid-icon').length, 0, 'no dot grid remains');
  assert.ok(button.querySelector('svg'), 'an svg glyph is present');
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
});

test('the panel starts closed, every category is checked, and the Hidden gate is not', () => {
  let popup = mount(makeApp());
  let panel = popup.querySelector('.kikx-frame-filter__panel');
  assert.equal(panel.hidden, true);
  // Every checkbox in the panel: one per category, the pinned master, the Hidden
  // gate, and the two view toggles (Raw/Debug). The view rows keep the checkbox
  // idiom for keyboard and AT parity, but they are not filters -- see the
  // view-toggle tests at the foot of this file.
  assert.equal(popup.querySelectorAll('.kikx-frame-filter__checkbox').length,
    FILTER_ROWS.length + 1 + VIEW_ROW_KEYS.length,
    'one row per filter, the pinned master, the Hidden gate and the two view toggles');

  for (let row of popup.querySelectorAll('.kikx-frame-filter__list .kikx-frame-filter__row'))
    assert.equal(row.querySelector('.kikx-frame-filter__checkbox').checked, true, 'every category starts on');

  let master = popup.querySelector('.kikx-frame-filter__pinned .kikx-frame-filter__checkbox');
  assert.equal(master.checked, true, 'the master reads all-on, because every category is on');

  let gate = popup.querySelector('.kikx-frame-filter__gate .kikx-frame-filter__checkbox');
  assert.equal(gate.checked, false, 'the Hidden gate starts off');
});

test('the pinned row is outside the scrolling list', () => {
  let popup = mount(makeApp());
  let pinned = popup.querySelector('.kikx-frame-filter__pinned');
  let list = popup.querySelector('.kikx-frame-filter__list');
  assert.ok(pinned, 'a pinned row exists');
  assert.ok(list, 'a list exists');
  assert.equal(list.contains(pinned), false, 'the pinned row is not a member of the list');
  assert.equal(pinned.querySelectorAll('.kikx-frame-filter__checkbox').length, 1);
});

test('one row exists per filter, in declared order, labelled and counted', () => {
  let frames = [
    { type: 'UserMessage', authorType: 'user' },
    { type: 'ToolCall' },
    { type: 'UserMessage', authorType: 'user', deleted: true },
  ];
  // Deliberately not the page-derived tallies (2 user, 1 tool): a badge is a
  // fact about the whole session, so these are what the server would return.
  let popup = mount(makeApp(frames, {
    user: 412, agent: 388, question: 7, session: 3, tools: 12998, commands: 12564,
    compaction: 55, deleted: 50,
  }));
  let keys = [ ...popup.querySelectorAll('.kikx-frame-filter__list .kikx-frame-filter__row') ]
    .map((row) => row.getAttribute('data-filter-key'));
  assert.deepEqual(keys, CATEGORY_ROWS.map((row) => row.key), 'the list holds the categories, in order');
  assert.equal(keys.includes('deleted'), false, 'the reveal is rendered outside the list');

  for (let row of popup.querySelectorAll('.kikx-frame-filter__list .kikx-frame-filter__row'))
    assert.ok(row.querySelector('.kikx-frame-filter__label').textContent.trim() !== '', 'every row has a label');

  let counts = Object.fromEntries([ ...popup.querySelectorAll('.kikx-frame-filter__list .kikx-frame-filter__row') ]
    .map((row) => [ row.getAttribute('data-filter-key'), row.querySelector('.kikx-frame-filter__count')?.textContent ]));
  assert.equal(counts.user, '412', 'the session total, not the loaded page');
  assert.equal(counts.tools, '12998');

  // The gate carries its own count but is not a member of the category list.
  let gate = popup.querySelector('.kikx-frame-filter__gate .kikx-frame-filter__row');
  assert.equal(gate.getAttribute('data-filter-key'), 'deleted');
  assert.equal(gate.querySelector('.kikx-frame-filter__count').textContent, '50');
  assert.equal(popup.querySelector('.kikx-frame-filter__list [data-filter-key="deleted"]'), null, 'the reveal is not in the list');
});

test('a plain click flips only that row', () => {
  let app = makeApp();
  let popup = mount(app);
  let tools = popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__checkbox');

  click(tools);
  let filters = app._state.frameFilters;
  assert.equal(filters.tools, false);
  assert.equal(filters.user, true);
  assert.equal(filters.question, true);
  assert.equal(app.applied.length, 1, 'the app hook is used exactly once');
});

test('Ctrl+Click leaves only the clicked row checked in the DOM', () => {
  let app = makeApp();
  let popup = mount(app);
  click(popup.querySelector('[data-filter-key="question"] .kikx-frame-filter__checkbox'), { ctrlKey: true });

  let checked = [ ...popup.querySelectorAll('.kikx-frame-filter__list .kikx-frame-filter__row') ]
    .filter((row) => row.querySelector('.kikx-frame-filter__checkbox')?.checked === true)
    .map((row) => row.getAttribute('data-filter-key'));
  assert.deepEqual(checked, [ 'question' ], 'exactly one row is checked');
});

test('Shift+Click turns every row back on', () => {
  let app = makeApp();
  let popup = mount(app);

  click(popup.querySelector('[data-filter-key="user"] .kikx-frame-filter__checkbox'), { ctrlKey: true });
  assert.equal(everyFilterOn(app._state.frameFilters), false);

  click(popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__checkbox'), { shiftKey: true });
  assert.equal(everyFilterOn(app._state.frameFilters), true, 'Shift+Click restores everything');
});

test('the click does not also toggle the checkbox natively', () => {
  let app = makeApp();
  let popup = mount(app);
  let tools = popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__checkbox');
  let event = click(tools);
  assert.equal(event.defaultPrevented, true, 'the browser default is suppressed so state is the only source of truth');
});

// The checkbox is not the click target a person actually hits. The row is a
// <label>, so its text and its badge are the biggest targets on screen - and
// they are precisely the ones that used to route through label activation,
// which forwards a synthetic click to the input with the modifier flags gone.
// These three lock the row-level listener that keeps Ctrl and Shift intact.
test('Ctrl+Click on the row text focuses that row', () => {
  let app = makeApp();
  let popup = mount(app);
  click(popup.querySelector('[data-filter-key="question"] .kikx-frame-filter__label'), { ctrlKey: true });

  let filters = app._state.frameFilters;
  assert.equal(filters.question, true);
  assert.equal(filters.user, false, 'the other rows are forced off');
  assert.equal(filters.tools, false);
});

test('Shift+Click on the row badge turns everything on', () => {
  // Counts are required for a badge to exist at all: a row without a server
  // count renders no number, which is why this fixture supplies them.
  let app = makeApp([], { user: 1, agent: 1, question: 1, session: 0, tools: 1, commands: 1, compaction: 0, deleted: null });
  let popup = mount(app);

  click(popup.querySelector('[data-filter-key="user"] .kikx-frame-filter__label'), { ctrlKey: true });
  assert.equal(everyFilterOn(app._state.frameFilters), false);

  click(popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__count'), { shiftKey: true });
  assert.equal(everyFilterOn(app._state.frameFilters), true);
});

test('a plain click on the row text flips only that row', () => {
  let app = makeApp();
  let popup = mount(app);
  click(popup.querySelector('[data-filter-key="agent"] .kikx-frame-filter__label'));

  assert.equal(app._state.frameFilters.agent, false);
  assert.equal(app._state.frameFilters.user, true);
});

test('the pinned row toggles everything off, then back on', () => {
  let app = makeApp();
  let popup = mount(app);
  let master = popup.querySelector('.kikx-frame-filter__pinned .kikx-frame-filter__checkbox');

  click(master);
  assert.equal(noFilterOn(app._state.frameFilters), true);
  assert.equal(master.checked, false);
  assert.equal(master.indeterminate, false);

  click(master);
  assert.equal(everyFilterOn(app._state.frameFilters), true);
  assert.equal(master.checked, true);
});

test('the pinned row is indeterminate while the selection is mixed', () => {
  let app = makeApp();
  let popup = mount(app);
  let master = popup.querySelector('.kikx-frame-filter__pinned .kikx-frame-filter__checkbox');
  assert.equal(master.indeterminate, false);

  click(popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__checkbox'));
  assert.equal(master.indeterminate, true, 'mixed renders as indeterminate');
  assert.equal(master.checked, false, 'and not as checked');

  click(master);
  assert.equal(master.indeterminate, false);
  assert.equal(master.checked, true, 'clicking from mixed turns everything on');
});

test('rows paint an is-off class so the styling can dim them', () => {
  let app = makeApp();
  let popup = mount(app);
  click(popup.querySelector('[data-filter-key="agent"] .kikx-frame-filter__checkbox'));
  let row = popup.querySelector('[data-filter-key="agent"]');
  assert.equal(row.classList.contains('is-off'), true);
  assert.equal(popup.querySelector('[data-filter-key="user"]').classList.contains('is-off'), false);
});

test('the button opens and closes the panel and reports it on app state', () => {
  let app = makeApp();
  let popup = mount(app);
  let button = popup.querySelector('.kikx-frame-filter__button');

  click(button);
  assert.equal(popup.querySelector('.kikx-frame-filter__panel').hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(app._frameFilterPopupOpen, true);

  click(button);
  assert.equal(popup.querySelector('.kikx-frame-filter__panel').hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(app._frameFilterPopupOpen, false);
});

test('a render while open restores the open panel', () => {
  let app = makeApp();
  let popup = mount(app);
  click(popup.querySelector('.kikx-frame-filter__button'));
  assert.equal(popup.isOpen, true);

  popup.configure({ app, appState: app._state, sessionID: 'ses_1' });
  assert.equal(popup.isOpen, true, 'a shell rebuild does not silently close the popup');
});

test('filters survive a re-render and repaint from state', () => {
  let app = makeApp();
  let popup = mount(app);
  click(popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__checkbox'));

  popup.configure({ app, appState: app._state, sessionID: 'ses_1' });
  let tools = popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__checkbox');
  assert.equal(tools.checked, false, 'the unchecked row comes back unchecked');
  assert.equal(popup.querySelector('[data-filter-key="tools"]').classList.contains('is-off'), true);
});

test('framesWouldRender answers whether anything matched', () => {
  let frames = [ { type: 'ToolCall' } ];
  assert.equal(framesWouldRender(frames, defaultFrameFilters()), true);
  assert.equal(framesWouldRender(frames, { ...defaultFrameFilters(), tools: false }), false);
  assert.equal(framesWouldRender([], defaultFrameFilters()), false);
});

// Shift is a TOGGLE for the whole set. It used to be hard-coded to all-on, and
// because all-on is the default state, pressing Shift on a fresh popup changed
// nothing at all -- the gesture read as dead. The existing Shift test missed it
// by always isolating a row with Ctrl first.
test('Shift+Click turns everything off when everything is already on', () => {
  let app = makeApp();
  let popup = mount(app);

  assert.equal(everyFilterOn(app._state.frameFilters), true, 'the popup starts with every category on');

  click(popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__label'), { shiftKey: true });

  assert.equal(everyFilterOn(app._state.frameFilters), false, 'Shift+Click must clear the set it was already showing');
});

test('Shift+Click alternates the whole set on and off', () => {
  let app = makeApp();
  let popup = mount(app);
  let row = () => popup.querySelector('[data-filter-key="tools"] .kikx-frame-filter__label');

  click(row(), { shiftKey: true });
  assert.equal(everyFilterOn(app._state.frameFilters), false, 'first press clears');

  click(row(), { shiftKey: true });
  assert.equal(everyFilterOn(app._state.frameFilters), true, 'second press restores');
});

// --- view-level toggles: Raw / Debug at the foot of the panel ---------------
//
// Owner change (2026-11-14): "I want the RAW and DEBUG items to be under the
// Filter popup menu with the Eye icon ... put these two items down at the bottom
// with Hidden."
//
// They are deliberately NOT category rows: a category narrows WHICH frames
// render (frameFilters), a view toggle changes HOW the same frames render.

test('the view toggles sit below the Hidden gate, in the order the owner named them', () => {
  let popup = mount(makeApp());
  let panel = popup.querySelector('.kikx-frame-filter__panel');

  // Deliberately index arithmetic over `panel.children`, NOT element identity.
  // mini-dom implements neither `previousElementSibling` nor `lastElementChild`,
  // and `assert.equal` handed two MiniElement instances never returns: node's
  // assertion machinery spins in its diff instead of failing. Comparing the
  // POSITIONS of the blocks is available here and cannot hang, and it asserts
  // exactly the ordering the owner asked for.
  let blocks = panel.children;
  let classOf = (node) => String(node?.className || '');
  let gateIndex = blocks.findIndex((node) => classOf(node).includes('kikx-frame-filter__gate'));
  let viewIndex = blocks.findIndex((node) => classOf(node).includes('kikx-frame-filter__view'));

  assert.ok(gateIndex >= 0, 'the Hidden gate still exists');
  assert.ok(viewIndex >= 0, 'the view block exists');
  assert.equal(viewIndex, gateIndex + 1,
    'the view block sits directly after the gate -- "down at the bottom with Hidden"');
  assert.equal(viewIndex, blocks.length - 1, 'and it is the LAST block in the panel');
  let view = blocks[viewIndex];

  let rows = Array.from(view.querySelectorAll('[data-view-key]'));
  assert.deepEqual(rows.map((row) => row.getAttribute('data-view-key')), VIEW_ROW_KEYS,
    'Raw then Debug, in the order the owner listed them');
  assert.deepEqual(rows.map((row) => row.querySelector('.kikx-frame-filter__label').textContent),
    [ 'Raw', 'Debug' ]);
});

test('the view toggles are not category filters', () => {
  // The regression this guards: pushing Raw/Debug into the category `_rows` map
  // would make them write `frameFilters`, so switching Debug on would narrow the
  // thread to a key no frame type owns -- an empty conversation, blamed on the
  // filter. They also carry no badge, because "how many frames are in raw mode"
  // is not a fact about the session.
  let popup = mount(makeApp());
  let view = popup.querySelector('.kikx-frame-filter__view');

  assert.equal(view.querySelectorAll('.kikx-frame-filter__count').length, 0, 'no count badges');
  assert.equal(popup.querySelector('.kikx-frame-filter__list .kikx-frame-filter__row--view'), null,
    'the view rows are not inside the scrolling category list');
  assert.equal(popup.querySelectorAll('[data-filter-key="raw"], [data-filter-key="debug"]').length, 0,
    'nothing claims a frameFilter key');
});

test('clicking a view row calls the app handler for that view, then paints', () => {
  let app = makeApp();
  app.calls = [];
  app._toggleRawMarkdown = () => {
    app.calls.push('raw');
    app._state.rawMarkdown = !app._state.rawMarkdown;
  };
  app._toggleDebugMode = () => {
    app.calls.push('debug');
    app._state.debugMode = !app._state.debugMode;
  };
  let popup = mount(app);

  click(popup.querySelector('[data-view-key="raw"] .kikx-frame-filter__checkbox'));

  assert.deepEqual(app.calls, [ 'raw' ],
    'Raw goes through the ONE app handler, not a second private implementation');
  let raw = popup.querySelector('[data-view-key="raw"]');
  assert.equal(raw.querySelector('.kikx-frame-filter__checkbox').checked, true, 'the checkbox follows state');
  assert.equal(raw.classList.contains('is-on'), true, 'and so does the styling hook');
  assert.equal(popup.querySelector('[data-view-key="debug"]').classList.contains('is-on'), false,
    'the other view is untouched');
  assert.deepEqual(app.applied, [], 'and no frameFilter was written');

  click(popup.querySelector('[data-view-key="debug"] .kikx-frame-filter__checkbox'));
  assert.deepEqual(app.calls, [ 'raw', 'debug' ]);
  assert.equal(popup.querySelector('[data-view-key="debug"]').classList.contains('is-on'), true);
  assert.deepEqual(app.applied, [], 'still no frameFilter written');
});

test('the view rows repaint from app state, not from their own click', () => {
  // Debug mode re-renders the whole app, which recreates this popup mid-callback;
  // raw mode only flips classes on chips that no longer exist. Neither updates
  // this checkbox, so the row must read state on every paint or it comes back
  // looking off while the app is in that mode.
  let app = makeApp();
  let popup = mount(app);
  assert.equal(popup.querySelector('[data-view-key="debug"]').classList.contains('is-on'), false,
    'Debug starts off');

  app._state.debugMode = true;
  popup.configure({ app, appState: app._state, sessionID: 'ses_1' });

  let debug = popup.querySelector('[data-view-key="debug"]');
  assert.equal(debug.querySelector('.kikx-frame-filter__checkbox').checked, true,
    'a rebuild repaints Debug from state');
  assert.equal(debug.classList.contains('is-on'), true);
});
