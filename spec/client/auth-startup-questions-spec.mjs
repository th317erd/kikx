'use strict';

// Regression guard for a real bug found by the browser spec on 2026-10-18.
//
// The startup load list exists TWICE:
//   1. `kikx-app.mjs` `startupLoads` (the already-authenticated mount path)
//   2. `kikx-editors.mjs` `applyAuth` (the magic-link sign-in path)
//
// P3 added `_loadQuestions()` only to (1). A magic-link sign-in — the normal
// real-world path — therefore never fetched questions, so a freshly signed-in
// user saw a permanently empty Inbox until a runtime-events reconnect happened
// to fire. Every mini-DOM spec passed, because they call the state functions
// directly and cannot observe a missing call in an auth path.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

// The modules under test reach the element DSL through aeor-ui.mjs, whose
// /vendor/... imports are browser-only. Redirect them to local stand-ins first.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

// `installDom()` does not provide Web Storage, and `applyAuth` writes the auth
// blob to `sessionStorage`. Stub it before the module under test can use it.
if (typeof globalThis.sessionStorage === 'undefined') {
  let store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

installDom();

const { applyAuth } = await import('../../src/client/components/kikx-editors.mjs');

function createAppStub(calls) {
  return {
    _state: {
      authToken: null,
      refreshToken: '',
      status: 'Signed out',
      statusKind: 'none',
      questionsState: { questions: [], counts: {}, loaded: false, loading: false, error: null },
    },
    _render: () => calls.push('render'),
    _connectRuntimeEvents: () => calls.push('connectRuntimeEvents'),
    _loadClientComponents: () => calls.push('loadClientComponents'),
    _loadAccount: () => calls.push('loadAccount'),
    _loadAgents: () => calls.push('loadAgents'),
    _loadSessions: () => calls.push('loadSessions'),
    _loadTokenUsage: () => calls.push('loadTokenUsage'),
    _loadQuestions: () => calls.push('loadQuestions'),
  };
}

test('applyAuth (magic-link sign-in) fetches questions on load', () => {
  let calls = [];
  let app = createAppStub(calls);

  applyAuth(app, { token: 'token-abc', refresh_token: 'refresh-abc' });

  // The bug: `loadQuestions` was absent from this list entirely, so the Inbox
  // stayed empty after every fresh sign-in.
  assert.ok(
    calls.includes('loadQuestions'),
    `applyAuth must trigger a questions fetch; it called: ${JSON.stringify(calls)}`,
  );

  // Guard against a "fix" that adds questions but drops another loader. Pin the
  // whole set, not just the new entry.
  for (let expected of [
    'loadClientComponents',
    'loadAccount',
    'loadAgents',
    'loadSessions',
    'loadTokenUsage',
    'loadQuestions',
  ])
    assert.ok(calls.includes(expected), `applyAuth must still call ${expected}`);
});

test('applyAuth still applies the returned token and reconnects runtime events', () => {
  let calls = [];
  let app = createAppStub(calls);

  applyAuth(app, { token: 'token-xyz', refresh_token: 'refresh-xyz' });

  assert.equal(app._state.authToken, 'token-xyz', 'the auth token is stored on state');
  assert.equal(app._state.refreshToken, 'refresh-xyz', 'the refresh token is stored on state');
  assert.ok(calls.includes('connectRuntimeEvents'), 'runtime events reconnect after sign-in');
  assert.ok(calls.includes('render'), 'the shell repaints after sign-in');
});

test('applyAuth refuses to start loaders without an auth token', () => {
  let calls = [];
  let app = createAppStub(calls);

  assert.throws(
    () => applyAuth(app, { refresh_token: 'refresh-abc' }),
    /auth token/i,
    'applyAuth without a token must throw',
  );
  assert.ok(
    !calls.includes('loadQuestions'),
    'no questions fetch may happen without an auth token',
  );
});
