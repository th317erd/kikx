'use strict';

// S4: the hidden -> visible transition. A tab that was hidden long enough can
// accumulate a backlog (past the hard cap, so the oldest events were dropped and
// their sessions marked for re-fetch). On becoming visible the backlog must
// drain, the retained events must land in state, and the capped sessions must be
// reloaded so nothing is lost.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const {
  MAX_PENDING_FRAME_RUNTIME_EVENTS,
  installFrameRuntimeVisibilityDrain,
  queueFrameRuntimeEvent,
  uninstallFrameRuntimeVisibilityDrain,
} = await import('../../src/client/components/kikx-runtime-events.mjs');
const { createSessionStateSnapshot } = await import('../../src/client/state/session-state-utils.mjs');

function createVisibilityTarget(visibility = 'hidden') {
  let listeners = new Set();
  return {
    visibilityState: visibility,
    addEventListener(type, listener) {
      if (type === 'visibilitychange')
        listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'visibilitychange')
        listeners.delete(listener);
    },
    changeTo(state) {
      this.visibilityState = state;
      for (let listener of [ ...listeners ])
        listener();
    },
  };
}

function frameEvent(sessionID, frame) {
  return { type: 'frame.updated', sessionID, frame };
}

function frame(id) {
  return { id, type: 'UserMessage', content: { text: id } };
}

function createApp() {
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1', 's2' ],
    sessionDetailsByID: { s1: { id: 's1' }, s2: { id: 's2' } },
    framesBySessionID: { s1: [], s2: [] },
    sessionPagingByID: {},
  });
  state.selectedSessionID = 's2';

  let loaded = [];
  let syncs = [];
  let app = {
    isConnected: true,
    _state: state,
    _pendingFrameRuntimeEvents: [],
    // Hold the drain so the backlog survives the transition to visible.
    _frameRuntimeFlushScheduled: true,
    _syncFrameThread(sessionID, options) {
      syncs.push({ sessionID, options });
    },
    _schedulePreviewRefresh() {},
    _loadFrames(sessionID, options) {
      loaded.push({ sessionID, options });
    },
    loaded,
    syncs,
    _requestRender() {},
  };
  return app;
}

test('a hidden backlog drains on visible, retained frames apply, capped sessions reload', () => {
  let target = createVisibilityTarget('hidden');
  let app = createApp();
  installFrameRuntimeVisibilityDrain(app, target);

  // Overflow the cap entirely with one session: its oldest frames are dropped
  // and the session is marked for a full re-fetch.
  let overflow = 5;
  for (let index = 0; index < MAX_PENDING_FRAME_RUNTIME_EVENTS + overflow; index += 1)
    queueFrameRuntimeEvent(app, frameEvent('s1', frame(`s1-${index}`)));

  // A second session arrives after the cap was reached; its frames are retained.
  for (let index = 0; index < 3; index += 1)
    queueFrameRuntimeEvent(app, frameEvent('s2', frame(`s2-${index}`)));

  assert.equal(app._pendingFrameRuntimeEvents.length, MAX_PENDING_FRAME_RUNTIME_EVENTS);
  assert.equal(app._frameRuntimeRefreshSessionIDs.has('s1'), true, 'the capped session is marked for refresh');
  assert.equal(app.loaded.length, 0, 'nothing drains while the tab is still hidden');

  target.changeTo('visible');

  assert.equal(app._pendingFrameRuntimeEvents.length, 0, 'the backlog must drain on visible');
  assert.equal(app._frameRuntimeRefreshSessionIDs.size, 0, 'the refresh marker is consumed');
  assert.deepEqual(app.loaded, [ { sessionID: 's1', options: { merge: true } } ], 'the capped session is reloaded');

  // The retained frames for the newly active session reached state, and the
  // selected thread synced exactly once for the drained batch.
  assert.deepEqual(app._state.framesBySessionID.s2.map((entry) => entry.id), [ 's2-0', 's2-1', 's2-2' ]);
  assert.equal(app.syncs.length, 1);
  assert.equal(app.syncs[0].sessionID, 's2');

  uninstallFrameRuntimeVisibilityDrain(app);
});

test('a visibilitychange while still hidden does not drain the backlog', () => {
  let target = createVisibilityTarget('hidden');
  let app = createApp();
  installFrameRuntimeVisibilityDrain(app, target);

  queueFrameRuntimeEvent(app, frameEvent('s2', frame('f1')));
  target.changeTo('hidden');
  target.changeTo('hidden');

  assert.equal(app._pendingFrameRuntimeEvents.length, 1, 'only a visible transition may drain');
  uninstallFrameRuntimeVisibilityDrain(app);
});
