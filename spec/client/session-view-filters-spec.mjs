'use strict';

// View filters are PER SESSION, and survive a reload via localStorage.
//
// The bug this file pins (owner report, 2026-11-05): with the eyeball popup
// Ctrl+Clicked to "Child Sessions", clicking into one of those child sessions
// showed an EMPTY thread. The filter was never wrong -- it was global. The
// child session has no child sessions of its own, so a global "Child Sessions"
// selection is guaranteed to match nothing there. A view filter describes how
// ONE session is being looked at, so it has to travel with that session.
//
// Two properties matter and they are easy to half-implement:
//
//   1. ISOLATION. Entering a session must not carry the previous session's
//      selection in. The default for an unseen session is "everything on" --
//      NEVER "whatever the session I just left was showing".
//   2. SURVIVAL. A reload must not silently reset a deliberately narrowed
//      thread back to "everything on", or the second bug replaces the first.
//
// The grid is a scope of its own. Its search box is a title filter, not a frame
// query, so it must not be clobbered by a frame query typed inside a session.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRID_VIEW_SCOPE,
  SESSION_VIEW_SCOPE_PREFIX,
  applySessionViewScope,
  captureSessionViewScope,
  defaultViewScope,
  normalizeViewScope,
  readSessionViewScope,
  viewScopeKey,
  writeSessionViewScope,
} from '../../src/client/state/session-view-filters.mjs';
import {
  CATEGORY_KEYS,
  DELETED_ROW,
  defaultFrameFilters,
  everyFilterOn,
  onlyFilter,
} from '../../src/client/lib/frame-filters.mjs';

// A minimal localStorage stand-in. Deliberately not the real DOM one: these are
// state-layer tests, and the storage seam is what the caller varies.
function memoryStorage(initial = {}) {
  let map = new Map(Object.entries(initial));
  let writes = [];
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { writes.push(key); map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    key: (index) => [ ...map.keys() ][index] ?? null,
    get length() { return map.size; },
    _map: map,
    _writes: writes,
  };
}

// The exact state the owner was in: isolated to Child Sessions only.
function childSessionOnly() {
  return onlyFilter(defaultFrameFilters(), 'session');
}

test('a session with no stored filters defaults to every category on', () => {
  let scope = readSessionViewScope('ses_new', memoryStorage());
  assert.equal(everyFilterOn(scope.filters), true);
  assert.equal(scope.filters[DELETED_ROW.key], false, 'the Hidden gate stays off by default');
  assert.equal(scope.query, '');
});

test('entering a session does NOT inherit the previous session\'s narrowed filter', () => {
  // This is the reported bug, stated directly: the parent was isolated to Child
  // Sessions, and the child must open showing everything -- not an empty thread.
  let storage = memoryStorage();
  let state = { frameFilters: defaultFrameFilters(), sessionSearch: '' };

  // The parent narrowed itself and that narrowing was persisted under ITS id.
  state.frameFilters = childSessionOnly();
  state.sessionSearch = 'needle';
  captureSessionViewScope(state, 'ses_parent', storage);

  // Now navigate into a child that has never had a filter set.
  applySessionViewScope(state, 'ses_child', storage);

  assert.equal(everyFilterOn(state.frameFilters), true, 'child opens with every category on');
  assert.equal(state.sessionSearch, '', 'the parent\'s frame query does not follow either');
});

test('a session\'s own filter round-trips through storage', () => {
  let storage = memoryStorage();
  let state = { frameFilters: childSessionOnly(), sessionSearch: 'deploy' };
  captureSessionViewScope(state, 'ses_a', storage);

  // A fresh state object standing in for a page reload.
  let reloaded = { frameFilters: defaultFrameFilters(), sessionSearch: '' };
  applySessionViewScope(reloaded, 'ses_a', storage);

  assert.equal(reloaded.frameFilters.session, true, 'Child Sessions is still the selection');
  for (let key of CATEGORY_KEYS)
    assert.equal(reloaded.frameFilters[key], key === 'session', `${key} matches the stored scope`);
  assert.equal(reloaded.sessionSearch, 'deploy');
});

test('two sessions keep independent filters, and neither is lost by visiting the other', () => {
  let storage = memoryStorage();
  let state = { frameFilters: defaultFrameFilters(), sessionSearch: '' };

  state.frameFilters = childSessionOnly();
  captureSessionViewScope(state, 'ses_a', storage);

  applySessionViewScope(state, 'ses_b', storage);
  assert.equal(everyFilterOn(state.frameFilters), true, 'ses_b starts unfiltered');
  state.frameFilters = onlyFilter(defaultFrameFilters(), 'tools');
  captureSessionViewScope(state, 'ses_b', storage);

  applySessionViewScope(state, 'ses_a', storage);
  assert.equal(state.frameFilters.session, true, 'ses_a kept its Child Sessions isolation');

  applySessionViewScope(state, 'ses_b', storage);
  assert.equal(state.frameFilters.tools, true, 'ses_b kept its Tools isolation');
  assert.equal(state.frameFilters.session, false, 'ses_b did not absorb ses_a\'s selection');
});

test('the grid is its own scope, so a frame query cannot clobber the title filter', () => {
  let storage = memoryStorage();
  assert.equal(viewScopeKey(''), GRID_VIEW_SCOPE);
  assert.equal(viewScopeKey('ses_a'), 'ses_a');

  let state = { frameFilters: defaultFrameFilters(), sessionSearch: 'title needle' };
  captureSessionViewScope(state, '', storage);

  // Type a frame query inside a session, then go back to the grid.
  applySessionViewScope(state, 'ses_a', storage);
  state.sessionSearch = 'frame needle';
  captureSessionViewScope(state, 'ses_a', storage);

  applySessionViewScope(state, '', storage);
  assert.equal(state.sessionSearch, 'title needle', 'the grid title search survived');
  assert.equal(everyFilterOn(state.frameFilters), true);
});

test('the stored key is namespaced per session, so scopes cannot collide', () => {
  let storage = memoryStorage();
  let state = { frameFilters: childSessionOnly(), sessionSearch: '' };
  captureSessionViewScope(state, 'ses_a', storage);

  assert.deepEqual(storage._writes, [`${SESSION_VIEW_SCOPE_PREFIX}ses_a`]);
  assert.ok(storage._map.has(`${SESSION_VIEW_SCOPE_PREFIX}ses_a`));
});

test('malformed stored JSON degrades to the default scope instead of throwing', () => {
  let storage = memoryStorage({ [`${SESSION_VIEW_SCOPE_PREFIX}ses_bad`]: '{not json' });
  let scope = readSessionViewScope('ses_bad', storage);
  assert.equal(everyFilterOn(scope.filters), true);
  assert.equal(scope.query, '');
});

test('a partially corrupt scope is normalised, not trusted wholesale', () => {
  let storage = memoryStorage({
    [`${SESSION_VIEW_SCOPE_PREFIX}ses_partial`]: JSON.stringify({ filters: { session: true } }),
  });
  let scope = readSessionViewScope('ses_partial', storage);
  // Unknown/absent keys resolve to their defaults rather than to undefined.
  for (let key of CATEGORY_KEYS)
    assert.equal(typeof scope.filters[key], 'boolean', `${key} is a boolean`);
  assert.equal(scope.query, '');
});

test('storage that throws is survivable, because localStorage does in private mode', () => {
  let hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  let scope = readSessionViewScope('ses_x', hostile);
  assert.equal(everyFilterOn(scope.filters), true);

  let state = { frameFilters: childSessionOnly(), sessionSearch: 'q' };
  assert.doesNotThrow(() => captureSessionViewScope(state, 'ses_x', hostile));
});

test('a missing storage object is survivable, for the server-render and test paths', () => {
  let scope = readSessionViewScope('ses_y', null);
  assert.equal(everyFilterOn(scope.filters), true);

  let state = { frameFilters: defaultFrameFilters(), sessionSearch: '' };
  assert.doesNotThrow(() => applySessionViewScope(state, 'ses_y', null));
});

test('normalizeViewScope repairs a scope built from a foreign object', () => {
  // A non-boolean is NOT coerced by truthiness: `normalizeWindowFilters` replaces
  // it with that key's default. `session` defaults to true, so asserting `false`
  // here would be asserting the wrong contract and would pass for the wrong
  // reason. The `deleted` gate defaults to false, which makes it the honest
  // discriminator -- `'yes'` there must come back false, not truthily true.
  let scope = normalizeViewScope({
    filters: { session: 'yes', deleted: 'yes', user: false, nonsense: true },
    query: 42,
  });
  assert.equal(scope.filters.session, true, 'non-boolean falls back to that key\'s default');
  assert.equal(scope.filters.deleted, false, 'and it is the default, not the truthiness of "yes"');
  assert.equal(scope.filters.user, false, 'a real boolean is kept');
  assert.equal('nonsense' in scope.filters, false, 'unknown keys are dropped');
  assert.equal(scope.query, '', 'a non-string query falls back to empty');
});

test('defaultViewScope hands back a fresh object each call, so callers cannot share one', () => {
  let first = defaultViewScope();
  let second = defaultViewScope();
  assert.notEqual(first.filters, second.filters);
  first.filters.session = false;
  assert.equal(second.filters.session, true, 'mutating one default does not poison the next');
});

test('write then read is stable for the deleted gate as well as the categories', () => {
  let storage = memoryStorage();
  let filters = defaultFrameFilters();
  filters[DELETED_ROW.key] = true;
  writeSessionViewScope('ses_del', { filters, query: '' }, storage);

  let scope = readSessionViewScope('ses_del', storage);
  assert.equal(scope.filters[DELETED_ROW.key], true, 'the Hidden reveal is per-session too');
});
