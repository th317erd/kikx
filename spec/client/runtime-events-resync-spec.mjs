'use strict';

// P2-b: a destroyed/reconnected SSE stream can miss frames and session changes
// emitted while it was down. onRuntimeEventsOpen() routes a re-open through the
// app's `_onRuntimeEventsReconnect` hook; these specs pin what that resync does
// (reload the session/preview list and merge the selected session's frames) and
// that it neither runs on the first connect nor stacks when reopens overlap.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { resyncAfterRuntimeEventsReconnect } = await import('../../src/client/components/kikx-data.mjs');

function createResyncApp(overrides = {}) {
  let calls = [];
  let app = {
    isConnected: true,
    calls,
    _state: { selectedSessionID: 's1', status: '', statusKind: 'pending' },
    async _loadSessions() {
      calls.push([ 'sessions' ]);
    },
    async _loadFrames(sessionID, options) {
      calls.push([ 'frames', sessionID, options ]);
    },
    _requestRender() {
      calls.push([ 'render' ]);
    },
    ...overrides,
  };
  return app;
}

test('a reconnect resyncs the session list and merges the selected session frames', async () => {
  let app = createResyncApp();
  await resyncAfterRuntimeEventsReconnect(app);

  assert.deepEqual(app.calls, [
    [ 'sessions' ],
    [ 'frames', 's1', { merge: true } ],
  ]);
});

test('a reconnect with no selected session reloads only the session list', async () => {
  let app = createResyncApp({ _state: { selectedSessionID: '' } });
  await resyncAfterRuntimeEventsReconnect(app);

  assert.deepEqual(app.calls, [ [ 'sessions' ] ]);
});

test('a detached app is not resynced', async () => {
  let app = createResyncApp({ isConnected: false });
  await resyncAfterRuntimeEventsReconnect(app);

  assert.deepEqual(app.calls, []);
});

test('overlapping reopens coalesce into a single resync', async () => {
  let releases = [];
  let app = createResyncApp({
    async _loadSessions() {
      this.calls.push([ 'sessions' ]);
      await new Promise((resolve) => releases.push(resolve));
    },
  });

  let first = resyncAfterRuntimeEventsReconnect(app);
  let second = resyncAfterRuntimeEventsReconnect(app);
  assert.equal(releases.length, 1, 'the second reopen must reuse the in-flight resync');

  releases[0]();
  await first;
  await second;
  assert.equal(app.calls.filter((call) => call[0] === 'sessions').length, 1);
  assert.equal(app._runtimeEventsResyncInFlight, false);
});

test('a failing frame reload is surfaced and the in-flight guard is cleared', async () => {
  let app = createResyncApp({
    async _loadFrames() {
      throw new Error('frames unavailable');
    },
  });

  await resyncAfterRuntimeEventsReconnect(app);

  assert.equal(app._state.status, 'frames unavailable');
  assert.equal(app._state.statusKind, 'error');
  assert.equal(app._runtimeEventsResyncInFlight, false, 'a failure must not wedge the guard');
});
