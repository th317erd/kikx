'use strict';

// S4: a stream drop in the middle of a frame burst must not lose the queued
// frames or open extra sockets. The connection module rebuilds the SSE stream on
// the reconnect ladder; the runtime-event queue keeps whatever arrived before the
// drop so the user's view does not silently regress to stale data.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const {
  connectRuntimeEvents,
  disconnectRuntimeEvents,
  onRuntimeEventsError,
  onRuntimeEventsOpen,
} = await import('../../src/client/components/runtime-events-connection.mjs');
const { flushFrameRuntimeEvents, onRuntimeEvent } = await import('../../src/client/components/kikx-runtime-events.mjs');
const { createSessionStateSnapshot } = await import('../../src/client/state/session-state-utils.mjs');

class FakeEventSource {
  static CONNECTING = 0;

  static OPEN = 1;

  static CLOSED = 2;

  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.CONNECTING;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type))
      this.listeners.set(type, []);

    this.listeners.get(type).push(listener);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type, event = {}) {
    if (type === 'open')
      this.readyState = FakeEventSource.OPEN;

    for (let listener of this.listeners.get(type) || [])
      listener({ type, target: this, ...event });
  }

  static reset() {
    FakeEventSource.instances = [];
  }
}

function withFakeTimers(callback) {
  let originalSetTimeout = globalThis.setTimeout;
  let originalClearTimeout = globalThis.clearTimeout;
  let scheduled = [];
  globalThis.setTimeout = (fn, delay) => {
    let handle = { cleared: false, delay, fn, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle)
      handle.cleared = true;
  };
  try {
    return callback(scheduled);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

function createApp() {
  let state = createSessionStateSnapshot({
    sessionIDs: [ 's1' ],
    sessionDetailsByID: { s1: { id: 's1' } },
    framesBySessionID: { s1: [] },
    sessionPagingByID: {},
  });
  state.selectedSessionID = 's1';

  let syncs = [];
  let resyncs = 0;
  let app = {
    isConnected: true,
    _state: state,
    _pendingFrameRuntimeEvents: [],
    _frameRuntimeFlushScheduled: false,
    _runtimeEventsDispatch: null,
    _syncFrameThread(sessionID, options) {
      syncs.push({ sessionID, options });
    },
    _requestRender() {},
    _schedulePreviewRefresh() {},
    _onRuntimeEventsReconnect() {
      resyncs += 1;
    },
    resyncs: () => resyncs,
    syncs,
  };
  app._onRuntimeEvent = (event) => onRuntimeEvent(app, event);
  app._onRuntimeEventsOpen = () => onRuntimeEventsOpen(app);
  app._onRuntimeEventsError = (event) => onRuntimeEventsError(app, event);
  app._runtimeEventsDispatch = (event) => {
    // Mirrors kikx-app.mjs: the dispatcher refreshes liveness, then hands the
    // raw event to onRuntimeEvent().
    app._onRuntimeEvent(event);
  };
  return app;
}

function frameEvent(index) {
  return {
    type: 'frame.added',
    data: JSON.stringify({
      type: 'frame.added',
      sessionID: 's1',
      frame: { id: `f${index}`, type: 'UserMessage', content: { text: `text ${index}` } },
    }),
  };
}

test('a stream drop mid-burst keeps the queued frames and reconnects once per rung', async () => {
  let original = globalThis.EventSource;
  FakeEventSource.reset();
  globalThis.EventSource = FakeEventSource;

  try {
    withFakeTimers((scheduled) => {
      let app = createApp();
      connectRuntimeEvents(app);
      app._eventSource.emit('open');

      // Hold the drain so the burst is still queued when the stream drops.
      app._frameRuntimeFlushScheduled = true;
      for (let index = 0; index < 3; index++)
        app._runtimeEventsDispatch(frameEvent(index));

      assert.equal(app._pendingFrameRuntimeEvents.length, 3, 'the burst must queue');

      let dropped = app._eventSource;
      dropped.close();
      onRuntimeEventsError(app, { target: dropped });

      assert.equal(app._state.connectionStatus, 'Disconnected');
      assert.equal(app._pendingFrameRuntimeEvents.length, 3, 'a drop must not discard queued frames');

      // One rung schedules three staggered timers; firing all of them (in order)
      // must still open exactly one replacement socket.
      let rung = scheduled.filter((timer) => !timer.cleared);
      assert.equal(rung.length, 3);
      for (let timer of rung)
        timer.fn();

      assert.equal(FakeEventSource.instances.length, 2, 'exactly one reconnect per rung');
      assert.notEqual(app._eventSource, dropped);

      app._eventSource.emit('open');
      assert.equal(app.resyncs(), 1, 'the re-open must resync the missed gap');

      // Now let the preserved burst drain into state.
      app._frameRuntimeFlushScheduled = false;
      flushFrameRuntimeEvents(app);

      assert.equal(app._pendingFrameRuntimeEvents.length, 0);
      assert.deepEqual(
        app._state.framesBySessionID.s1.map((frame) => frame.id),
        [ 'f0', 'f1', 'f2' ],
        'every frame from before the drop must still be applied',
      );
      assert.equal(app.syncs.length, 1, 'the selected thread syncs once for the drained batch');

      disconnectRuntimeEvents(app);
    });
  } finally {
    if (original === undefined)
      delete globalThis.EventSource;
    else
      globalThis.EventSource = original;
  }
});

test('repeated errors during the burst do not stack reconnect rungs', () => {
  let original = globalThis.EventSource;
  FakeEventSource.reset();
  globalThis.EventSource = FakeEventSource;

  try {
    withFakeTimers((scheduled) => {
      let app = createApp();
      connectRuntimeEvents(app);
      app._eventSource.emit('open');
      app._frameRuntimeFlushScheduled = true;
      app._runtimeEventsDispatch(frameEvent(0));

      let dropped = app._eventSource;
      dropped.close();
      onRuntimeEventsError(app, { target: dropped });
      onRuntimeEventsError(app, { target: dropped });
      onRuntimeEventsError(app, { target: dropped });

      assert.equal(scheduled.filter((timer) => !timer.cleared).length, 3, 'only one rung is ever pending');

      for (let timer of scheduled.filter((timer) => !timer.cleared))
        timer.fn();

      assert.equal(FakeEventSource.instances.length, 2, 'repeated errors must not open extra sockets');
      assert.equal(app._pendingFrameRuntimeEvents.length, 1, 'the queued frame survives the error storm');
      disconnectRuntimeEvents(app);
    });
  } finally {
    if (original === undefined)
      delete globalThis.EventSource;
    else
      globalThis.EventSource = original;
  }
});
