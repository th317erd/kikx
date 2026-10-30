'use strict';

// The header search box and its clear-all control.
//
// Three behaviours are pinned here, all of them regressions that shipped:
//
//  1. Typing inside an open session did nothing. The box was wired to the grid
//     title filter only, and a session window has no grid, so the query had no
//     consumer at all.
//  2. A query change could never trigger a window refetch, because the
//     "has anything changed" guard compared `(filters, query)` against
//     `(filters, query)` -- the same query on both sides -- so the query could
//     not affect the comparison.
//  3. The field carried an eyeball that duplicated "show deleted" and there was
//     no way back to an unfiltered view short of opening the popup and
//     re-checking every row.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

// kikx-navigation.mjs reaches the declarative element builder through an
// absolute browser path ('/vendor/aeor-web-components/elements.js'), which no
// Node resolver can find. The loader maps it to the stub the other shell specs
// already use, so the module under test is the real one.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();

const { applyWindowQuery, setFrameFilters } = await import('../../src/client/components/kikx-navigation.mjs');
const { defaultFrameFilters, stateHasFilters } = await import('../../src/client/lib/frame-filters.mjs');
const { toggleFilter } = await import('../../src/client/lib/frame-filters.mjs');

// A stand-in app: only the members applyWindowQuery touches, plus a record of
// every frame load so we can tell "refetched" from "re-rendered".
function makeApp({ selectedSessionID = '', frames = [] } = {}) {
  let app = {
    _state: {
      selectedSessionID,
      sessionSearch: '',
      frameFilters: defaultFrameFilters(),
      showDeletedSessions: false,
      framesBySessionID: selectedSessionID ? { [selectedSessionID]: frames } : {},
    },
    loads: [],
    renders: 0,
    shellSyncs: 0,
    threadSyncs: 0,
    // 0 = run the deferred query inline, so the assertions below stay
    // synchronous. A dedicated test below covers the real timer.
    _queryDebounceMs: 0,
  };
  app._loadFrames = async (sessionID) => {
    app.loads.push(sessionID);
    app._state.framesBySessionID = { ...app._state.framesBySessionID, [sessionID]: [] };
    return [];
  };
  app._syncFrameThread = () => { app.threadSyncs += 1; };
  app._render = () => { app.renders += 1; };
  app._requestRender = () => { app.renders += 1; };
  app._syncSessionShell = () => { app.shellSyncs += 1; return true; };
  app.querySelector = () => null;
  return app;
}

test('typing on the grid keeps the cheap title-filter path', () => {
  let app = makeApp();

  applyWindowQuery(app, 'alp');

  assert.equal(app._state.sessionSearch, 'alp');
  assert.equal(app.shellSyncs, 1, 'the grid should repaint through the shell sync');
  assert.deepEqual(app.loads, [], 'no session is open, so there is no window to fetch');
});

test('typing inside a session asks the server for a filtered window', () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });

  applyWindowQuery(app, 'deploy');

  assert.equal(app._state.sessionSearch, 'deploy');
  assert.deepEqual(app.loads, ['ses_1'], 'the window must be refetched server-side');
  assert.equal(app.shellSyncs, 0, 'a session window has no grid to sync');
  assert.equal(app.renders, 0, 'typing must not rebuild the header and steal the caret');
});

test('the previous page stays mounted while the replacement window fetches', () => {
  let app = makeApp({ selectedSessionID: 'ses_1', frames: [ { id: 'a' }, { id: 'b' } ] });
  app._loadFrames = async (sessionID) => {
    app.loads.push({ sessionID, frames: [ ...app._state.framesBySessionID[sessionID] ] });
    return [];
  };

  applyWindowQuery(app, 'x');

  assert.deepEqual(app.loads, [ { sessionID: 'ses_1', frames: [ { id: 'a' }, { id: 'b' } ] } ],
    'the old view must stay mounted until the filtered result replaces it');
  assert.equal(app.renders, 0, 'the header/search input must not be rebuilt');
});

test('a query that does not change costs nothing', () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });

  applyWindowQuery(app, 'same');
  applyWindowQuery(app, 'same');

  assert.equal(app.loads.length, 1, 'the second identical query must not refetch');
});

test('clearing the query is a change, and it refetches', () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });

  applyWindowQuery(app, 'temp');
  applyWindowQuery(app, '');

  assert.equal(app.loads.length, 2, 'going back to an empty query is a real transition');
  assert.equal(app._state.sessionSearch, '');
});

test('surrounding whitespace is not treated as a different query', () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });

  applyWindowQuery(app, 'deploy');
  applyWindowQuery(app, '  deploy  ');

  assert.equal(app.loads.length, 1, 'padding must not look like a new search');
});

test('a non-string value is normalised rather than stored verbatim', () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });

  applyWindowQuery(app, null);

  assert.equal(app._state.sessionSearch, '');
});

test('the clear control is only offered when something is actually filtered', () => {
  let state = { sessionSearch: '', frameFilters: defaultFrameFilters(), showDeletedSessions: false };
  assert.equal(stateHasFilters(state), false, 'an untouched shell has nothing to clear');

  assert.equal(stateHasFilters({ ...state, sessionSearch: 'a' }), true, 'search text counts');

  let narrowed = defaultFrameFilters();
  narrowed.tools = false;
  assert.equal(stateHasFilters({ ...state, frameFilters: narrowed }), true, 'a hidden category counts');

  assert.equal(
    stateHasFilters({ ...state, frameFilters: { ...defaultFrameFilters(), deleted: true } }),
    true,
    'the Deleted reveal counts',
  );

  // Soft-deleted sessions can be on screen even with every category enabled.
  assert.equal(stateHasFilters({ ...state, showDeletedSessions: true }), true);
});

test('a typing burst collapses into one scan, not one per keystroke', async () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });
  app._queryDebounceMs = 25;

  // Six keystrokes, faster than the debounce window.
  for (let value of [ 'd', 'de', 'dep', 'depl', 'deplo', 'deploy' ])
    applyWindowQuery(app, value);

  assert.equal(app.loads.length, 0, 'nothing is fetched while the typist is still typing');

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(app.loads.length, 1, 'exactly one scan for the whole burst');
  assert.equal(app._state.sessionSearch, 'deploy', 'the last value is the one that gets fetched');
});

test('pausing between words fetches each settled query once', async () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });
  app._queryDebounceMs = 25;

  applyWindowQuery(app, 'deploy');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(app.loads.length, 1);

  applyWindowQuery(app, 'deploy frame');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(app.loads.length, 2, 'a second settled query is a second scan');
});

test('a popup filter change discards a query that was still pending', async () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });
  app._queryDebounceMs = 30;

  applyWindowQuery(app, 'deploy');
  assert.equal(app.loads.length, 0);

  // The row click reloads immediately and is authoritative; the queued query
  // must not land afterwards and refetch under a stale filter set.
  setFrameFilters(app, toggleFilter(defaultFrameFilters(), 'tools'));
  let afterClick = app.loads.length;

  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(app.loads.length, afterClick, 'the pending query must not fire after a filter reload');
});

test('typing back to the already-loaded query does not scan again', async () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });
  app._queryDebounceMs = 25;

  applyWindowQuery(app, 'deploy');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(app.loads.length, 1);

  applyWindowQuery(app, 'deploy!');
  applyWindowQuery(app, 'deploy');
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(app.loads.length, 1, 'the burst settled back on the loaded query, so nothing to do');
});

test('a paged session filters its mounted pages instead of scanning the whole session', () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });
  app.querySelector = (selector) => (
    selector === 'kikx-chat-view' ? { usesPagedScrollview: true } : null
  );

  applyWindowQuery(app, 'deploy');

  assert.equal(app._state.sessionSearch, 'deploy');
  assert.deepEqual(app.loads, [], 'a paged thread must not run the whole-session body scan');
  assert.equal(app.threadSyncs, 1, 'the page source must be re-scoped with the new query');
});

test('a paged filter click re-scopes the page source without a body scan', () => {
  let app = makeApp({ selectedSessionID: 'ses_1' });
  app.querySelector = (selector) => (
    selector === 'kikx-chat-view' ? { usesPagedScrollview: true } : null
  );

  setFrameFilters(app, toggleFilter(defaultFrameFilters(), 'tools'));

  assert.deepEqual(app.loads, [], 'checkbox changes must stay local to the loaded pages');
  assert.equal(app.threadSyncs, 1, 'the page source must be re-scoped with the new filters');
});
