'use strict';

// W8: while a tab is hidden, requestAnimationFrame is paused. The old queue
// pushed one entry per frame.added / frame.updated and only drained on a rAF,
// so a busy session grew the queue without bound and the UI was frozen until
// the user returned. These specs pin the fix: hidden tabs schedule via
// setTimeout, repeated updates for one frame coalesce, the queue has a hard cap
// that marks dropped sessions for a re-fetch, and a visibilitychange drain
// flushes anything still pending when the tab comes back.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
globalThis.document = document;

const {
  MAX_PENDING_FRAME_RUNTIME_EVENTS,
  flushFrameRuntimeEvents,
  installFrameRuntimeVisibilityDrain,
  queueFrameRuntimeEvent,
  uninstallFrameRuntimeVisibilityDrain,
} = await import('../../src/client/components/kikx-runtime-events.mjs');
const { scheduleAnimationFrame } = await import('../../src/client/components/kikx-app-helpers.mjs');
const { createSessionStateSnapshot } = await import('../../src/client/state/session-state-utils.mjs');

function quietConsole(callback) {
  let original = console.error;
  console.error = () => {};
  try {
    return callback();
  } finally {
    console.error = original;
  }
}

function frameEvent(sessionID, frame) {
  return { type: 'frame.updated', sessionID, frame };
}

function frame(id) {
  return { id, type: 'UserMessage', content: { text: id } };
}

function createQueueApp(overrides = {}) {
  return {
    _state: createSessionStateSnapshot({
      sessionIDs: [ 's1', 's2', 's3' ],
      sessionDetailsByID: { s1: { id: 's1' }, s2: { id: 's2' }, s3: { id: 's3' } },
      framesBySessionID: {},
      sessionPagingByID: {},
    }),
    _pendingFrameRuntimeEvents: [],
    // Keep the queue from draining so the assertions see it at rest.
    _frameRuntimeFlushScheduled: true,
    _syncFrameThread() {},
    _schedulePreviewRefresh() {},
    _loadFrames() {},
    ...overrides,
  };
}

function createVisibilityTarget(visibility = 'visible') {
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
    listenerCount() {
      return listeners.size;
    },
    changeTo(state) {
      this.visibilityState = state;
      for (let listener of [ ...listeners ])
        listener();
    },
  };
}

test('scheduleAnimationFrame falls back to setTimeout while the tab is hidden', () => {
  let rafCalls = 0;
  let timeoutCalls = 0;
  let originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  let originalSetTimeout = globalThis.setTimeout;
  let originalVisibility = document.visibilityState;
  globalThis.requestAnimationFrame = () => {
    rafCalls += 1;
    return 1;
  };
  globalThis.setTimeout = () => {
    timeoutCalls += 1;
    return 1;
  };

  try {
    document.visibilityState = 'hidden';
    scheduleAnimationFrame(() => {});
    document.visibilityState = 'visible';
    scheduleAnimationFrame(() => {});
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.setTimeout = originalSetTimeout;
    if (originalVisibility === undefined)
      delete document.visibilityState;
    else
      document.visibilityState = originalVisibility;
  }

  assert.equal(timeoutCalls, 1, 'a hidden tab must not wait on a paused rAF');
  assert.equal(rafCalls, 1, 'a visible tab keeps the cheaper rAF path');
});

test('repeated updates for the same frame coalesce to the newest payload', () => {
  let app = createQueueApp();

  queueFrameRuntimeEvent(app, frameEvent('s1', { id: 'f1', type: 'UserMessage', content: { text: 'old' } }));
  queueFrameRuntimeEvent(app, frameEvent('s1', { id: 'f1', type: 'UserMessage', content: { text: 'new' } }));

  assert.equal(app._pendingFrameRuntimeEvents.length, 1);
  assert.equal(app._pendingFrameRuntimeEvents[0].frame.content.text, 'new');
});

test('the pending queue is hard-capped and dropped sessions are marked for refresh', () => {
  let app = createQueueApp();
  let total = MAX_PENDING_FRAME_RUNTIME_EVENTS + 25;
  for (let index = 0; index < total; index += 1)
    queueFrameRuntimeEvent(app, frameEvent(`s${index % 3}`, frame(`f${index}`)));

  assert.equal(app._pendingFrameRuntimeEvents.length, MAX_PENDING_FRAME_RUNTIME_EVENTS);
  assert.deepEqual([ ...app._frameRuntimeRefreshSessionIDs ].sort(), [ 's0', 's1', 's2' ]);
});

test('flushing a capped queue reloads the sessions whose updates were dropped', () => {
  let loaded = [];
  let app = createQueueApp({ _loadFrames: (sessionID) => { loaded.push(sessionID); } });
  let total = MAX_PENDING_FRAME_RUNTIME_EVENTS + 25;
  for (let index = 0; index < total; index += 1)
    queueFrameRuntimeEvent(app, frameEvent(`s${index % 3}`, frame(`f${index}`)));

  flushFrameRuntimeEvents(app);

  assert.deepEqual(loaded.sort(), [ 's0', 's1', 's2' ]);
  assert.equal(app._frameRuntimeRefreshSessionIDs.size, 0, 'the refresh marker is drained');
});

// P3-d: the dropped-session reload goes through _loadFrames, and
// syncFrameThread() early-returns for non-selected sessions, so without an
// explicit preview refresh the session card previews stay stale after a capped
// (hidden-tab) flush. The queue is empty here so the normal per-event preview
// path cannot mask the dropped-session path.
test('flushing dropped-session refreshes also refreshes their previews', () => {
  let previews = [];
  let app = createQueueApp({
    _loadFrames: () => {},
    _schedulePreviewRefresh: (sessionIDs) => { previews.push(...sessionIDs); },
  });
  app._frameRuntimeRefreshSessionIDs = new Set([ 's0', 's1', 's2' ]);

  flushFrameRuntimeEvents(app);

  assert.deepEqual(previews.sort(), [ 's0', 's1', 's2' ]);
});

test('becoming visible drains events queued while the tab was hidden', () => {
  let target = createVisibilityTarget('hidden');
  let app = createQueueApp();
  installFrameRuntimeVisibilityDrain(app, target);

  queueFrameRuntimeEvent(app, frameEvent('s1', frame('f1')));
  assert.equal(app._pendingFrameRuntimeEvents.length, 1, 'queued while hidden, not yet drained');

  target.changeTo('visible');

  assert.equal(app._pendingFrameRuntimeEvents.length, 0);
  uninstallFrameRuntimeVisibilityDrain(app);
  assert.equal(target.listenerCount(), 0, 'the drain listener is removed with the app');
});

test('the flush-scheduled flag is reset even when processing throws', () => {
  let app = createQueueApp({ _state: null });
  app._pendingFrameRuntimeEvents = [ frameEvent('s1', frame('f1')) ];

  quietConsole(() => assert.doesNotThrow(() => flushFrameRuntimeEvents(app)));

  assert.equal(app._frameRuntimeFlushScheduled, false);
});
