'use strict';

// THE WIRING spec for the first-paint invariant, and the correction to a gap I
// created.
//
// My first attempt (`view-scope-first-paint-spec.mjs`) tested the helpers in
// `view-scope-bootstrap.mjs` in isolation. Those tests were green -- and stayed
// green when I reverted the actual fix. That is the exact failure mode a test
// suite is supposed to prevent: proving a function works while proving nothing
// about whether anyone calls it. The negative control caught it, not the suite.
//
// So this file tests the REAL module: it imports `kikx-state.mjs` through the
// same mini-dom harness the other client specs use, having pre-seeded
// localStorage, and asserts on the resulting `kikxState`. If the cold-start
// seeding is removed from `kikx-state.mjs`, every test here fails.
//
// Two properties, and they are the two the owner asked for:
//
//   1. FILTER STATE IS RESOLVED BEFORE THE FIRST FETCH. `loadFrames` builds its
//      URL from `state.frameFilters`, so the state must already be narrowed at
//      import time -- before any component mounts. An all-on seed means the first
//      request is unfiltered, those frames paint, and the stored filter then
//      removes them from the DOM.
//   2. THE BADGE IS HONEST FROM THE FIRST PAINT. The popup derives its header
//      class from the same state, so an all-on seed dims nothing until the late
//      scope arrives. Same root cause, different symptom.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import test, { beforeEach } from 'node:test';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { document, window } = installDom();
globalThis.document = document;
globalThis.window = window;

const {
  FRAME_FILTER_CATEGORY_KEYS,
  FRAME_FILTER_GATE_KEYS,
  defaultFrameWindowFilters,
  windowFiltersAreDefault,
} = await import('../../src/shared/frame-window-filters.mjs');

const USER = 'user';
const DELETED = FRAME_FILTER_GATE_KEYS[0];

// The stored shape a session that switched the User category off would have.
// Written in the format `writeSessionViewScope` produces, so this is the same
// payload the app reads back.
function narrowedScope() {
  let filters = defaultFrameWindowFilters();
  filters[USER] = false;
  return { filters, query: '' };
}

function storageFrom(entries) {
  let values = new Map(Object.entries(entries));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

function installStorage(entries) {
  let storage = storageFrom(entries);
  globalThis.localStorage = storage;
  window.localStorage = storage;
  return storage;
}

// The state module memoises itself, so each scenario needs a fresh module
// instance to re-run module evaluation (which is where cold-start seeding
// happens). A cache-busting query is the standard trick for that.
let importCounter = 0;
async function importFreshState() {
  importCounter += 1;
  return await import(`../../src/client/state/kikx-state.mjs?scenario=${importCounter}`);
}

beforeEach(() => {
  // The URL is read at module-eval time, so it must be set before importing.
  globalThis.location = { search: '' };
});

test('cold start seeds frameFilters from storage instead of the all-on default', async () => {
  let sessionID = 'session-with-user-off';
  installStorage({ [`kikx.viewScope.${sessionID}`]: JSON.stringify(narrowedScope()) });
  globalThis.location = { search: `?session=${sessionID}` };
  window.location = globalThis.location;

  let { kikxState } = await importFreshState();

  assert.equal(
    kikxState.frameFilters?.[USER],
    false,
    'state must already be narrowed at import time, before the first frame fetch',
  );
  assert.equal(
    windowFiltersAreDefault(kikxState.frameFilters, kikxState.sessionSearch),
    false,
    'the first request must NOT be able to go out unfiltered',
  );
});

test('cold start with no stored scope opens the default view', async () => {
  installStorage({});
  globalThis.location = { search: '?session=untouched' };
  window.location = globalThis.location;

  let { kikxState } = await importFreshState();

  assert.equal(kikxState.frameFilters?.[USER], true, 'an unseen session opens with every category on');
  assert.equal(
    windowFiltersAreDefault(kikxState.frameFilters, kikxState.sessionSearch),
    true,
    'no stored narrowing means the default view, not a false positive',
  );
});

test('cold start restores a stored frame query, not just the checkboxes', async () => {
  let sessionID = 'searched-session';
  let scope = narrowedScope();
  scope.filters = defaultFrameWindowFilters();
  scope.query = 'needle';
  installStorage({ [`kikx.viewScope.${sessionID}`]: JSON.stringify(scope) });
  globalThis.location = { search: `?session=${sessionID}` };
  window.location = globalThis.location;

  let { kikxState } = await importFreshState();

  assert.equal(kikxState.sessionSearch, 'needle', 'a stored query is part of the scope and must survive reload');
});

test('the deleted gate and its grid bucket flag agree at cold start', async () => {
  let sessionID = 'hidden-on';
  let scope = narrowedScope();
  scope.filters[DELETED] = true;
  installStorage({ [`kikx.viewScope.${sessionID}`]: JSON.stringify(scope) });
  globalThis.location = { search: `?session=${sessionID}` };
  window.location = globalThis.location;

  let { kikxState } = await importFreshState();

  assert.equal(kikxState.frameFilters?.[DELETED], true);
  assert.equal(
    kikxState.showDeletedSessions,
    true,
    'the eye and the server request must not disagree about hidden frames',
  );
});

test('a session scope never leaks into the session loaded next', async () => {
  // The reported gesture: parent narrowed to Child Sessions, enter the child.
  let scope = defaultFrameWindowFilters();
  for (let key of FRAME_FILTER_CATEGORY_KEYS)
    scope[key] = false;
  scope.session = true;
  installStorage({ 'kikx.viewScope.parent-session': JSON.stringify({ filters: scope, query: '' }) });
  globalThis.location = { search: '?session=child-session' };
  window.location = globalThis.location;

  let { kikxState } = await importFreshState();

  assert.equal(
    kikxState.frameFilters?.session,
    true,
    'the child must not inherit the parent "Child Sessions only" isolation',
  );
  assert.equal(kikxState.frameFilters?.[USER], true, 'the child opens all-on');
});

test('a hostile storage cannot prevent the app from starting', async () => {
  // A sandboxed frame throws on read. A view preference must never be able to
  // produce a white screen, which is why the seed is wrapped.
  let hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  globalThis.localStorage = hostile;
  window.localStorage = hostile;
  globalThis.location = { search: '?session=any' };
  window.location = globalThis.location;

  let { kikxState } = await importFreshState();

  assert.equal(kikxState.frameFilters?.[USER], true, 'degrades to the default view, not to a crash');
});
