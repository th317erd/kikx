'use strict';

// A soft delete performed in ANOTHER tab arrives here as a `session.saved`
// runtime event carrying `deletedAt`. The card must vanish, and because this tab
// may still have the session in its navigation stack, the stack (and the
// address bar) must be pruned too -- otherwise this tab shows a thread for a
// card that no longer exists. This is the SSE half of the delete contract; the
// local half is covered by session-grid-deleting-spec.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
globalThis.document = document;

const { onRuntimeEvent } = await import('../../src/client/components/kikx-runtime-events.mjs');
const { createSessionStateSnapshot, mergeSessions, upsertSessionState } = await import('../../src/client/state/session-state-utils.mjs');

function createApp(state) {
  let app = {
    _state: state,
    _syncSessionShell: () => true,
    _requestRenderCalls: 0,
    _requestRender() {
      this._requestRenderCalls += 1;
    },
  };
  return app;
}

function sessionEvent(session) {
  return {
    type: 'message',
    data: JSON.stringify({ type: 'session.saved', session }),
  };
}

function makeState(sessionIDs, details, stack) {
  let state = createSessionStateSnapshot({
    sessionIDs: sessionIDs.slice(),
    sessionDetailsByID: details,
    framesBySessionID: {},
    sessionPagingByID: {},
  });
  state.navigationStack = stack;
  state.selectedSessionID = '';
  return state;
}

test('session.saved with deletedAt removes the card from state', () => {
  let session = { id: 's1', title: 'One' };
  let state = makeState([ 's1' ], { s1: session }, [
    { sessionID: null, collapsed: true },
    { sessionID: 's1', collapsed: false },
  ]);
  let app = createApp(state);

  onRuntimeEvent(app, sessionEvent({ ...session, deletedAt: '2026-10-06T00:00:00.000Z' }));

  assert.deepEqual(state.sessionIDs, []);
  assert.equal(state.sessionDetailsByID.s1, undefined);
});

test('session.saved with deletedAt prunes the deleted session from the stack', () => {
  let session = { id: 's1', title: 'One' };
  let state = makeState([ 's1' ], { s1: session }, [
    { sessionID: null, collapsed: true },
    { sessionID: 's1', collapsed: false },
  ]);
  let app = createApp(state);

  onRuntimeEvent(app, sessionEvent({ ...session, deletedAt: '2026-10-06T00:00:00.000Z' }));

  assert.deepEqual(state.navigationStack, [ { sessionID: null, collapsed: true } ]);
  assert.equal(state.selectedSessionID, '');
});

test('a normal session.saved for a live session does not prune the stack', () => {
  let state = makeState([ 's1', 's2' ], {
    s1: { id: 's1', title: 'One' },
    s2: { id: 's2', title: 'Two' },
  }, [
    { sessionID: null, collapsed: true },
    { sessionID: 's2', collapsed: false },
  ]);
  let app = createApp(state);

  onRuntimeEvent(app, sessionEvent({ id: 's2', title: 'Two renamed' }));

  assert.deepEqual(state.sessionIDs, [ 's1', 's2' ]);
  assert.deepEqual(state.navigationStack, [
    { sessionID: null, collapsed: true },
    { sessionID: 's2', collapsed: false },
  ]);
});

test('a deleted session that was never listed is a no-op', () => {
  let state = makeState([ 's1' ], { s1: { id: 's1', title: 'One' } }, [
    { sessionID: null, collapsed: true },
    { sessionID: 's1', collapsed: false },
  ]);
  let app = createApp(state);

  onRuntimeEvent(app, sessionEvent({ id: 'ghost', deletedAt: '2026-10-06T00:00:00.000Z' }));

  assert.deepEqual(state.sessionIDs, [ 's1' ]);
  assert.deepEqual(state.navigationStack, [
    { sessionID: null, collapsed: true },
    { sessionID: 's1', collapsed: false },
  ]);
});

test('mergeSessions and upsertSessionState ignore deleted sessions', () => {
  let state = createSessionStateSnapshot({});
  let merged = mergeSessions(state, [
    { id: 'live', title: 'Live' },
    { id: 'gone', title: 'Gone', deletedAt: '2026-10-06T00:00:00.000Z' },
  ]);
  assert.deepEqual(merged.sessionIDs, [ 'live' ]);

  let afterUpsert = upsertSessionState(merged, { id: 'live', title: 'Live', deletedAt: '2026-10-06T00:00:00.000Z' });
  assert.deepEqual(afterUpsert.sessionIDs, []);
});
