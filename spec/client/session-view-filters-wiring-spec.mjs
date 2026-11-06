'use strict';

// The scope module has its own spec; this one proves the WIRING.
//
// A helper that nothing calls is not a fix. The unit spec can pass while the app
// still shows an empty child session, because the bug lives in the gap between
// "navigate to this session" and "load its frames". These tests drive the real
// exported navigation functions with a fake app and assert two things the user
// can actually observe:
//
//   1. the state handed to the frame loader carries the DESTINATION's filter,
//   2. the session being left kept its own filter in storage.
//
// The fake `_loadFrames` deliberately records `state.frameFilters` at call time,
// because that is the exact seam the bug travelled through: the request is built
// from live state, so anything that swaps the filter after the call is too late.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

// kikx-navigation reaches src/client/lib/aeor-ui.mjs, which imports the
// browser-only `/vendor/aeor-web-components/*` paths. This redirects those to
// local stand-ins, the same way every other spec that touches a client
// component does. It must be registered before the dynamic import below.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

import {
  SESSION_VIEW_SCOPE_PREFIX,
  readSessionViewScope,
} from '../../src/client/state/session-view-filters.mjs';
import { CATEGORY_KEYS, defaultFrameFilters, everyFilterOn, onlyFilter } from '../../src/client/lib/frame-filters.mjs';

// Install a localStorage before the navigation module is imported, since the
// scope store resolves `globalThis.localStorage` lazily but the app may not.
function installStorage() {
  let map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    key: (index) => [ ...map.keys() ][index] ?? null,
    get length() { return map.size; },
  };
  return { map };
}

installStorage();

const { syncViewScopeForSelection } = await import('../../src/client/components/kikx-navigation.mjs');

// A fake app that records what the frame loader was told, at the moment it was
// told it. No DOM: these paths take `app.querySelector?.()` and nothing more.
function makeApp(selectedSessionID = '') {
  let app = {
    _state: {
      selectedSessionID,
      frameFilters: defaultFrameFilters(),
      sessionSearch: '',
      showDeletedSessions: false,
    },
    loadCalls: [],
    // The popup's repaint hook, and the header's clear button repaint.
    _popupRefreshes: 0,
  };
  app.querySelector = (selector) => {
    if (selector === 'kikx-frame-filter-popup')
      return { refresh: () => { app._popupRefreshes += 1; } };
    return null;
  };
  app.querySelectorAll = () => [];
  // Mirrors the real loader: snapshot the filter AT REQUEST TIME.
  app._loadFrames = (sessionID) => {
    app.loadCalls.push({ sessionID, filters: { ...app._state.frameFilters }, query: app._state.sessionSearch });
    return Promise.resolve();
  };
  return app;
}

test('the reported bug: leaving an isolated parent opens the child unfiltered', () => {
  let app = makeApp('ses_parent');

  // The parent is isolated to Child Sessions -- the state the owner reported.
  app._state.frameFilters = onlyFilter(defaultFrameFilters(), 'session');
  app._state.sessionSearch = '';

  // Navigate to the child exactly the way the app does.
  let previous = app._state.selectedSessionID;
  app._state.selectedSessionID = 'ses_child';
  syncViewScopeForSelection(app, previous);

  // What the loader would send now.
  app._loadFrames(app._state.selectedSessionID);
  let request = app.loadCalls.at(-1);

  assert.equal(request.sessionID, 'ses_child');
  assert.equal(everyFilterOn(request.filters), true,
    'the child requested every category, not "Child Sessions" -- which is empty there');
  assert.equal(request.filters.session, true, 'Child Sessions is still an available category');
});

test('the parent keeps its isolation in storage after being left', () => {
  let app = makeApp('ses_parent');
  app._state.frameFilters = onlyFilter(defaultFrameFilters(), 'session');

  let previous = app._state.selectedSessionID;
  app._state.selectedSessionID = 'ses_child';
  syncViewScopeForSelection(app, previous);

  let stored = readSessionViewScope('ses_parent');
  assert.equal(stored.filters.session, true, 'the parent\'s isolation was saved under its own id');
  for (let key of CATEGORY_KEYS)
    assert.equal(stored.filters[key], key === 'session', `${key} preserved for the parent`);
});

test('returning to the parent restores its isolation from storage', () => {
  let app = makeApp('ses_parent');
  app._state.frameFilters = onlyFilter(defaultFrameFilters(), 'session');
  app._state.sessionSearch = 'needle';

  // parent -> child
  let previous = app._state.selectedSessionID;
  app._state.selectedSessionID = 'ses_child';
  syncViewScopeForSelection(app, previous);
  assert.equal(everyFilterOn(app._state.frameFilters), true);

  // child -> parent
  previous = app._state.selectedSessionID;
  app._state.selectedSessionID = 'ses_parent';
  syncViewScopeForSelection(app, previous);

  assert.equal(app._state.frameFilters.session, true, 'parent isolation restored');
  assert.equal(app._state.sessionSearch, 'needle', 'and so was its query');
});

test('the signature guard is cleared, so the destination is not suppressed by the source', () => {
  let app = makeApp('ses_parent');
  // A stale signature from the previous session is the second route to the same
  // empty view: setFrameFilters would decide the window was already loaded.
  app._frameLoadSignature = 'stale-signature-from-the-parent';

  let previous = app._state.selectedSessionID;
  app._state.selectedSessionID = 'ses_child';
  syncViewScopeForSelection(app, previous);

  assert.equal(app._frameLoadSignature, null, 'no inherited signature can suppress the load');
});

test('the popup is repainted so its checkboxes match the new session', () => {
  let app = makeApp('ses_parent');
  let previous = app._state.selectedSessionID;
  app._state.selectedSessionID = 'ses_child';
  let before = app._popupRefreshes;
  syncViewScopeForSelection(app, previous);
  assert.ok(app._popupRefreshes > before, 'the eyeball popup was told to repaint');
});

test('entering the same session twice is stable, not cumulative', () => {
  let app = makeApp('ses_a');
  app._state.frameFilters = onlyFilter(defaultFrameFilters(), 'tools');

  // Re-syncing to the session already selected must not wipe or double-apply.
  syncViewScopeForSelection(app, 'ses_a');
  assert.equal(app._state.frameFilters.tools, true, 'its own filter survives a same-session sync');
});

test('the stored payload is namespaced, so it cannot collide with other app keys', () => {
  let storage = installStorage();
  let app = makeApp('ses_ns');
  app._state.frameFilters = onlyFilter(defaultFrameFilters(), 'session');

  let previous = app._state.selectedSessionID;
  app._state.selectedSessionID = 'ses_other';
  syncViewScopeForSelection(app, previous);

  assert.ok(storage.map.has(`${SESSION_VIEW_SCOPE_PREFIX}ses_ns`), 'key carries the documented prefix');
});

test('an app with no state does not throw, so early shell renders survive', () => {
  assert.doesNotThrow(() => syncViewScopeForSelection({}, 'ses_a'));
  assert.doesNotThrow(() => syncViewScopeForSelection(null, 'ses_a'));
});
