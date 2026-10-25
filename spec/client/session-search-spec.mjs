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

const { applyWindowQuery } = await import('../../src/client/components/kikx-navigation.mjs');
const { defaultFrameFilters, stateHasFilters } = await import('../../src/client/lib/frame-filters.mjs');

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
  };
  app._loadFrames = async (sessionID) => {
    app.loads.push(sessionID);
    app._state.framesBySessionID = { ...app._state.framesBySessionID, [sessionID]: [] };
    return [];
  };
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
});

test('the cached page is dropped before the refetch, so two selections never mix', () => {
  let app = makeApp({ selectedSessionID: 'ses_1', frames: [ { id: 'a' }, { id: 'b' } ] });
  app._loadFrames = async (sessionID) => {
    app.loads.push({ sessionID, frames: [ ...app._state.framesBySessionID[sessionID] ] });
    return [];
  };

  applyWindowQuery(app, 'x');

  assert.deepEqual(app.loads, [ { sessionID: 'ses_1', frames: [] } ],
    'the old page must be gone before the new fetch starts');
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
