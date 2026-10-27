'use strict';

// Owner item 3 (2026-10-27): "I would like the 'eye' filter to be hugged up next
// to the 'Search' field, to the right, just next to it (group 'search' items
// together on the UI)."
//
// THE MEASURED DEFECT: search was `div.kikx-session-search` mounted in the bar's
// centre `div.kikx-topbar__rest`, while the eyeball (`<kikx-frame-filter-popup>`)
// was created inside `buildTopbarActions` and therefore lived in the TRAILING
// `div.kikx-window__actions` -- far right, past the participants popup and
// `+ Add`. Two controls that both narrow what you see, at opposite ends of the bar.
//
// WHAT MUST NOT REGRESS, and is the reason this file exists rather than a pixel
// assertion alone:
//
//   The eye must still render at ROOT with `sessionID === null`. The Projects grid
//   is where soft-deleted sessions are listed, so gating the eye on a session
//   would strand "show deleted" on the one screen that needs it. A refactor that
//   moves the popup and "tidies" it behind the session guard passes a naive
//   adjacency test and breaks the owner's deleted-session workflow.
//
// Adjacency ITSELF is the browser probe's line -- there is no layout here. What
// this asserts is the structural precondition that makes the pixel claim true:
// the eye is a SIBLING of the field inside ONE group, with nothing between them.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const { buildTopbarSearch, buildTopbarActions, buildUnifiedTopbar } =
  await import('../../src/client/components/kikx-topbar.mjs');

// --- helpers ---------------------------------------------------------------

function makeApp(state = {}) {
  return {
    _state: {
      authToken: 'token',
      navigationStack: [ { sessionID: 's1', collapsed: false } ],
      sessionIDs: [ 's1' ],
      sessionDetailsByID: { s1: { id: 's1', title: 'A session' } },
      sessionSearch: '',
      frameFilters: {},
      account: { name: 'w' },
      ...state,
    },
    _onSessionSearchInput() {},
    _clearFrameFilters() {},
    _minimizeCurrent() {},
    _navigateToDepth() {},
    _beginSessionNameEdit() {},
  };
}

function classesOf(node) {
  return String(node.className || '').split(/\s+/).filter(Boolean);
}

function childNames(node) {
  return node.childNodes
    .filter((child) => child.nodeType === 1)
    .map((child) => child.localName);
}

// --- the grouping ----------------------------------------------------------

test('search and the eye share ONE group, with the field first', () => {
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);

  assert.ok(classesOf(group).includes('kikx-topbar__search-group'),
    `the search controls must live in one group; got "${group.className}"`);

  // Exactly the two controls, field container then eye, nothing between them.
  assert.deepEqual(childNames(group), [ 'div', 'kikx-frame-filter-popup' ],
    'the group must hold the field container directly followed by the eyeball');
  assert.ok(classesOf(group.childNodes[0]).includes('kikx-session-search'),
    'the first child must be the search field container');
});

test('the eye is a SIBLING of the field, not nested inside it', () => {
  // If the eye were moved INSIDE `.kikx-session-search`, the field's own
  // `clear` button would sit between the two controls the owner wants adjacent,
  // and the group would look right in the DOM order test while rendering wrong.
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);
  let field = group.querySelector('.kikx-session-search');

  assert.equal(field.querySelector('kikx-frame-filter-popup'), null,
    'the eyeball must not be nested inside the search field container');
  assert.ok(group.querySelector('kikx-frame-filter-popup'),
    'the eyeball must still be reachable inside the group');
});

test('the field container still holds exactly the input and the clear button', () => {
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);
  let field = group.querySelector('.kikx-session-search');

  assert.ok(field.querySelector('.kikx-session-search__input'), 'the search input must still render');
  assert.ok(field.querySelector('.kikx-session-search__clear'), 'the clear-filters button must still render');
});

// --- the root case: the reason the popup is not session-gated ---------------

test('the eye renders at ROOT with no session selected', () => {
  // THE regression this guards. The Projects grid lists soft-deleted sessions,
  // so an eye gated on sessionID would remove "show deleted" from the one screen
  // that needs it. `buildTopbarSearch(app, null)` is the root call.
  let app = makeApp();
  let group = buildTopbarSearch(app, null).build(document);

  let eye = group.querySelector('kikx-frame-filter-popup');
  assert.ok(eye, 'the eyeball must render at the project root, where there is no sessionID');

  // And it must be functional, not just present: configure() must have been
  // given the app and state so the popup can read and write frame filters.
  assert.equal(eye._app, app, 'the root eyeball must be configured with the app');
  assert.equal(eye._appState, app._state, 'the root eyeball must be configured with app state');
});

test('the eye is configured for the session when there IS one', () => {
  let app = makeApp();
  let group = buildTopbarSearch(app, 's1').build(document);
  let eye = group.querySelector('kikx-frame-filter-popup');

  assert.ok(eye, 'the eyeball must render inside a session too');
  assert.equal(eye._sessionID, 's1', 'inside a session the eyeball is scoped to it');
});

test('the eye still renders at root through the WHOLE bar, not just the builder', () => {
  // The end-to-end root case: an unauthenticated-shaped stack with no session
  // entry. This is the path buildUnifiedTopbar takes, so it covers a future
  // change that special-cases the bar rather than the builder.
  let app = makeApp({ navigationStack: [ { sessionID: null, collapsed: true } ], sessionIDs: [], sessionDetailsByID: {} });
  let bar = buildUnifiedTopbar(app).build(document);

  let group = bar.querySelector('.kikx-topbar__search-group');
  assert.ok(group, 'the whole bar must render the search group');
  assert.ok(group.querySelector('kikx-frame-filter-popup'),
    'the eyeball must exist at the project root through the real bar');
});

// --- the eye must be gone from the trailing actions -------------------------

test('the eye is no longer in the trailing actions cluster', () => {
  // The defect was a DUPLICATE-or-misplaced eye. Moving it without removing the
  // old one would leave two eyeballs and two different filter sources.
  let app = makeApp();
  let actions = buildTopbarActions(app, 's1').build(document);

  assert.equal(actions.querySelector('kikx-frame-filter-popup'), null,
    'the trailing actions must not still contain the eyeball');
});

test('the whole bar contains EXACTLY ONE eyeball', () => {
  let app = makeApp();
  let bar = buildUnifiedTopbar(app).build(document);
  assert.equal(bar.querySelectorAll('kikx-frame-filter-popup').length, 1,
    'one eyeball, one source of truth for the frame filters');
});

test('the search group is not inside the trailing actions', () => {
  let app = makeApp();
  let bar = buildUnifiedTopbar(app).build(document);

  let actions = bar.querySelector('.kikx-window__actions');
  assert.ok(actions, 'the trailing actions cluster must still render');
  assert.equal(actions.querySelector('.kikx-topbar__search-group'), null,
    'the search group must not live inside the trailing actions');

  let group = bar.querySelector('.kikx-topbar__search-group');
  let field = group.querySelector('.kikx-session-search');
  // DOM-order guarantee: the field precedes the eye. The owner said "to the
  // right, just next to it"; left-to-right reading order is DOM order here.
  let order = group.childNodes.filter((child) => child.nodeType === 1);
  assert.equal(order.indexOf(field), 0, 'the field comes first');
  assert.equal(order.indexOf(group.querySelector('kikx-frame-filter-popup')), 1, 'the eye comes second');
});

// --- the group must be the centred element now ------------------------------

test('the sheet centres and gaps the GROUP, not the bare field', async () => {
  // The field used to carry `margin-left/right: auto`, which is what centred it.
  // Once the eye sits beside it, centring the FIELD alone splits the pair across
  // the bar again: the field centres on itself and the eye hangs off its right.
  // The group must therefore be the centred, gapped element.
  let css = await readFile(fileURLToPath(new URL('../../src/client/styles/topbar-unified.css', import.meta.url)), 'utf8');
  let stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  let groupRule = /\.kikx-topbar__search-group\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(groupRule, 'the search group must have a layout rule in topbar-unified.css');
  let body = groupRule[1];

  assert.match(body, /(^|[;\s])gap\s*:/, 'the group must set the gap that makes the two controls hug');
  assert.match(body, /margin-left\s*:\s*auto/, 'the group must be the centred element');
  assert.match(body, /margin-right\s*:\s*auto/);

  // A "hugged up next to" gap, not the bar's normal rhythm: the two must read as
  // one control pair. 8px is the ceiling the owner's wording allows.
  let gap = /(^|[;\s])gap\s*:\s*(\d+(?:\.\d+)?)px/.exec(body);
  assert.ok(gap, 'the gap must be an explicit px value so this can be checked');
  assert.ok(Number(gap[2]) <= 8,
    `the search/eye gap must be small enough to read as one pair; got ${gap[2]}px`);

  // The field must no longer centre itself -- that is the whole point.
  let fieldRule = /\.kikx-topbar\.kikx-window__header\s+\.kikx-session-search\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(fieldRule, 'the field must still have its own sizing rule');
  assert.doesNotMatch(fieldRule[1], /margin-left\s*:\s*auto/,
    'the field must not centre itself now that the group does');
});
