'use strict';

// FIRST-PAINT INVARIANT: a frame the active view filter excludes must never
// exist in the DOM, not even for one frame of paint.
//
// Owner report (2026-11-05, follow-up to the per-session filter fix): on reload,
// a message appeared for about a second and then VANISHED. Nothing was lost --
// the server had it, the store had it, every later page load filtered it out
// correctly. The damage was done once, at boot:
//
//   kikxState.frameFilters seeded as `null` (all-on). The first frame fetch in
//   connectedCallback built its URL from that state, so it went out UNFILTERED.
//   Those frames arrived and painted. Then the session resolved from the URL, its
//   stored scope was applied, the page source re-scoped, and the store-side
//   predicate dropped the message. It left the DOM and -- because every later
//   page load is filtered server-side -- could not come back by scrolling.
//
// The fix has to be ordering, not paint suppression. Holding the paint until the
// filter resolves still transmits and holds the frame; it just hides it. The
// invariant only holds if the frame is never REQUESTED under a filter that would
// later exclude it.
//
// These tests are written against that ordering and are expected to fail on the
// pre-fix tree: `seedInitialViewScope` did not exist and the state seeded all-on.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_VIEW_SCOPE_PREFIX,
  defaultViewScope,
  seedInitialViewScope,
  writeSessionViewScope,
} from '../../src/client/state/session-view-filters.mjs';
import {
  coldStartSessionID,
  resolveColdStartViewScope,
  storedScopeIsNarrowing,
} from '../../src/client/state/view-scope-bootstrap.mjs';
import { FRAME_FILTER_CATEGORY_KEYS, FRAME_FILTER_GATE_KEYS } from '../../src/shared/frame-window-filters.mjs';

const USER_OFF = 'user';

// Minimal localStorage stand-in. `session-view-filters.mjs` accepts an injected
// storage object precisely so this needs no jsdom.
function memoryStorage(initial = {}) {
  let map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _map: map,
  };
}

// The one that matters: a filter that switches the User category OFF, exactly as
// the topbar badge in the report showed.
function userOffScope() {
  let filters = {};
  for (let key of FRAME_FILTER_CATEGORY_KEYS)
    filters[key] = true;
  filters[USER_OFF] = false;
  filters[FRAME_FILTER_GATE_KEYS[0]] = false;
  return { filters, query: '' };
}

function stateWithStore(userOffForSessionID, sessionID) {
  let storage = memoryStorage();
  writeSessionViewScope(sessionID, userOffScope(), storage);
  // The pre-fix seed: all-on, which is what made the first request unfiltered.
  return { state: { frameFilters: null, sessionSearch: '', showDeletedSessions: false }, storage };
}

test('cold start resolves the deep-linked session id from the URL', () => {
  assert.equal(coldStartSessionID('?session=abc-123'), 'abc-123');
  // ?view=thread with no session is the thread window with no session in it,
  // which is the grid -- not "unknown".
  assert.equal(coldStartSessionID('?view=thread'), '');
  assert.equal(coldStartSessionID(''), '');
  assert.equal(coldStartSessionID('?code=xyz'), '');
  // A session id in the query string is not the same as a deep link to it.
  assert.equal(coldStartSessionID('?session='), '');
});

test('seedInitialViewScope returns the stored narrowing scope, not the default', () => {
  let storage = memoryStorage();
  writeSessionViewScope('sess-1', userOffScope(), storage);

  let seed = seedInitialViewScope('?session=sess-1', storage);
  assert.equal(seed.filters[USER_OFF], false, 'user filter must be off at cold start');
  assert.equal(seed.filters.agent, true, 'other categories keep their stored value');

  // The control: without the stored scope the answer is the all-on default, and
  // `null` (the old seed) meant all-on too. Both are why the first request was
  // sent unfiltered.
  let fresh = seedInitialViewScope('?session=sess-2', storage);
  assert.equal(fresh.filters[USER_OFF], true, 'an unseen session opens all-on');
});

test('seedInitialViewScope degrades to the default instead of throwing', () => {
  // A sandboxed frame throws on read. A white screen is not an acceptable
  // degradation for a view preference.
  let hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  let seed = seedInitialViewScope('?session=sess-1', hostile);
  assert.deepEqual(seed, defaultViewScope());

  // Garbage in storage must not reach the filters either.
  let garbage = memoryStorage({ [`${SESSION_VIEW_SCOPE_PREFIX}sess-1`]: '{not json' });
  assert.deepEqual(seedInitialViewScope('?session=sess-1', garbage), defaultViewScope());
});

test('resolveColdStartViewScope applies the session scope synchronously', () => {
  let { state, storage } = stateWithStore(null, 'sess-1');

  // The whole point: after this call returns, and BEFORE any fetch, the state
  // already excludes what the stored scope excludes.
  let scope = resolveColdStartViewScope(state, 'sess-1', storage);

  assert.equal(scope.filters[USER_OFF], false);
  assert.equal(state.frameFilters[USER_OFF], false, 'state must carry the narrowing before first paint');
  assert.equal(state.showDeletedSessions, false);
});

test('resolveColdStartViewScope keeps the deleted gate and its bucket flag in step', () => {
  let storage = memoryStorage();
  let scope = userOffScope();
  scope.filters[FRAME_FILTER_GATE_KEYS[0]] = true;
  writeSessionViewScope('sess-1', scope, storage);

  let state = { frameFilters: null, sessionSearch: '', showDeletedSessions: false };
  resolveColdStartViewScope(state, 'sess-1', storage);

  assert.equal(state.frameFilters[FRAME_FILTER_GATE_KEYS[0]], true);
  assert.equal(
    state.showDeletedSessions,
    true,
    'the eye and the server request must not disagree about hidden frames',
  );
});

test('a narrowing stored scope is distinguishable from no scope', () => {
  let storage = memoryStorage();
  writeSessionViewScope('narrowed', userOffScope(), storage);

  // This is what separates "your filter is hiding it" from "the thread is
  // broken" -- the two states look identical on screen, which is why the
  // original report read as data loss.
  assert.equal(storedScopeIsNarrowing('narrowed', storage), true);
  assert.equal(storedScopeIsNarrowing('unseen', storage), false);

  let queryOnly = memoryStorage();
  writeSessionViewScope('searched', { filters: null, query: 'anything' }, queryOnly);
  assert.equal(storedScopeIsNarrowing('searched', queryOnly), true);
});

test('per-session scopes do not leak between sessions at cold start', () => {
  // The reported gesture: session A narrowed, enter child B, B must not inherit.
  let storage = memoryStorage();
  writeSessionViewScope('parent', userOffScope(), storage);

  let childState = { frameFilters: null, sessionSearch: '', showDeletedSessions: false };
  resolveColdStartViewScope(childState, 'child', storage);
  assert.equal(childState.frameFilters[USER_OFF], true, 'child must not inherit the parent filter');

  // And the parent's own scope survives untouched.
  assert.equal(storedScopeIsNarrowing('parent', storage), true);
});
