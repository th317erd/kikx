'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTED_STATUS,
  DISCONNECTED_STATUS,
  EVENT_SOURCE_ROUTE,
  RECONNECTING_STATUS,
  RUNTIME_EVENT_TYPES,
  checkRuntimeEventsConnection,
  connectRuntimeEvents,
  disconnectRuntimeEvents,
  isRuntimeEventsOpen,
  noteRuntimeEvent,
  onRuntimeEventsError,
  onRuntimeEventsOpen,
  setConnectionStatus,
} from '../../src/client/components/runtime-events-connection.mjs';

class FakeEventSource {
  static CONNECTING = 0;

  static OPEN = 1;

  static CLOSED = 2;

  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.CONNECTING;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type))
      this.listeners.set(type, []);

    this.listeners.get(type).push(listener);
  }

  close() {
    this.closed = true;
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

async function withFakeEventSource(callback) {
  let original = globalThis.EventSource;
  FakeEventSource.reset();
  globalThis.EventSource = FakeEventSource;
  try {
    return await callback();
  } finally {
    if (original === undefined)
      delete globalThis.EventSource;
    else
      globalThis.EventSource = original;
  }
}

function createApp() {
  let app = {
    isConnected: true,
    handled: [],
    _state: { connectionStatus: DISCONNECTED_STATUS, connectionStatusKind: 'error', status: '', statusKind: 'pending' },
  };

  // Mirror how kikx-app.mjs wires the element's bound handlers.
  app._onRuntimeEventsOpen = () => onRuntimeEventsOpen(app);
  app._onRuntimeEventsError = (event) => onRuntimeEventsError(app, event);
  app._onRuntimeEvent = (event) => app.handled.push(event);
  app._runtimeEventsDispatch = (event) => {
    noteRuntimeEvent(app);
    app._onRuntimeEvent(event);
  };
  return app;
}

// The manual reconnect path schedules through setTimeout; capture the delays
// instead of waiting on the real clock.
function withFakeTimers(callback) {
  let originalSetTimeout = globalThis.setTimeout;
  let originalClearTimeout = globalThis.clearTimeout;
  let scheduled = [];
  globalThis.setTimeout = (fn, delay) => {
    let handle = { delay, fn, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  globalThis.clearTimeout = () => {};
  try {
    return callback(scheduled);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test('connectRuntimeEvents opens the SSE route and subscribes to every runtime event', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);

    let source = app._eventSource;
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(source.url, EVENT_SOURCE_ROUTE);
    for (let type of RUNTIME_EVENT_TYPES)
      assert.equal(source.listeners.get(type)?.length, 1, `missing listener for ${type}`);
    assert.equal(source.listeners.get('open')?.length, 1);
    assert.equal(source.listeners.get('error')?.length, 1);
    disconnectRuntimeEvents(app);
  });
});

test('a missing EventSource global reports Disconnected without throwing', () => {
  let original = globalThis.EventSource;
  delete globalThis.EventSource;
  try {
    let app = createApp();
    connectRuntimeEvents(app);
    assert.equal(app._eventSource, null);
    assert.equal(app._state.connectionStatus, DISCONNECTED_STATUS);
    assert.equal(app._state.connectionStatusKind, 'error');
  } finally {
    globalThis.EventSource = original;
  }
});

test('open marks the stream Connected', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    app._eventSource.emit('open');

    assert.equal(app._state.connectionStatus, CONNECTED_STATUS);
    assert.equal(app._state.connectionStatusKind, 'ready');
    assert.equal(isRuntimeEventsOpen(app), true);
    assert.equal(app._runtimeEventsConnectingSince, 0);
    disconnectRuntimeEvents(app);
  });
});

test('a transient drop while still CONNECTING shows Reconnecting, not Disconnected', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    onRuntimeEventsOpen(app);

    app._eventSource.readyState = FakeEventSource.CONNECTING;
    onRuntimeEventsError(app, { target: app._eventSource });

    assert.equal(app._state.connectionStatus, RECONNECTING_STATUS);
    assert.equal(app._state.connectionStatusKind, 'pending');
    assert.equal(app._runtimeEventsReconnectTimer, undefined);
    disconnectRuntimeEvents(app);
  });
});

test('a late error from a replaced EventSource cannot poison the current status', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    let stale = app._eventSource;
    onRuntimeEventsOpen(app);

    connectRuntimeEvents(app);
    let current = app._eventSource;
    assert.notEqual(stale, current);
    onRuntimeEventsOpen(app);

    onRuntimeEventsError(app, { target: stale });
    assert.equal(app._state.connectionStatus, CONNECTED_STATUS);
    assert.equal(app._state.connectionStatusKind, 'ready');
    disconnectRuntimeEvents(app);
  });
});

test('a CLOSED stream is reported Disconnected and rebuilt without the browser retrying', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    onRuntimeEventsOpen(app);
    let first = app._eventSource;

    first.close();
    onRuntimeEventsError(app, { target: first });

    assert.equal(app._state.connectionStatus, DISCONNECTED_STATUS);
    assert.equal(app._state.connectionStatusKind, 'error');
    assert.ok(app._runtimeEventsReconnectTimer, 'expected a scheduled manual reconnect');

    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(FakeEventSource.instances.length, 2);
    assert.notEqual(app._eventSource, first);
    disconnectRuntimeEvents(app);
  });
});

test('the watchdog rebuilds a CLOSED stream', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    onRuntimeEventsOpen(app);

    app._eventSource.readyState = FakeEventSource.CLOSED;
    assert.equal(checkRuntimeEventsConnection(app), true);
    assert.equal(FakeEventSource.instances.length, 2);
    disconnectRuntimeEvents(app);
  });
});

test('the watchdog rebuilds a handshake that never completes', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    let started = app._runtimeEventsConnectingSince;

    assert.equal(checkRuntimeEventsConnection(app, started + 1000), false);
    assert.equal(FakeEventSource.instances.length, 1);

    assert.equal(checkRuntimeEventsConnection(app, started + 60000), true);
    assert.equal(FakeEventSource.instances.length, 2);
    disconnectRuntimeEvents(app);
  });
});

test('the watchdog leaves a healthy stream alone', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    onRuntimeEventsOpen(app);

    assert.equal(checkRuntimeEventsConnection(app), false);
    assert.equal(FakeEventSource.instances.length, 1);
    disconnectRuntimeEvents(app);
  });
});

test('the watchdog ignores a detached element', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    app.isConnected = false;
    app._eventSource.readyState = FakeEventSource.CLOSED;

    assert.equal(checkRuntimeEventsConnection(app), false);
    assert.equal(FakeEventSource.instances.length, 1);
    disconnectRuntimeEvents(app);
  });
});

test('the watchdog rebuilds a stream that went silent while still OPEN', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    app._eventSource.emit('open');
    assert.equal(isRuntimeEventsOpen(app), true);

    // A half-open socket stays OPEN forever; only the missing traffic gives it
    // away.
    app._runtimeEventsLastEventAt = Date.now() - 120000;
    assert.equal(checkRuntimeEventsConnection(app), true);
    assert.equal(app._state.connectionStatus, RECONNECTING_STATUS);
    assert.equal(FakeEventSource.instances.length, 2);
    disconnectRuntimeEvents(app);
  });
});

test('a heartbeat keeps a quiet but live stream open', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    app._eventSource.emit('open');

    app._runtimeEventsLastEventAt = Date.now() - 120000;
    app._eventSource.emit('heartbeat', { data: '{"ok":true}' });
    let lastEventAt = app._runtimeEventsLastEventAt;
    assert.ok(Date.now() - lastEventAt < 1000, 'expected the heartbeat to refresh liveness');

    assert.equal(checkRuntimeEventsConnection(app, lastEventAt + 60000), false);
    assert.equal(FakeEventSource.instances.length, 1);
    disconnectRuntimeEvents(app);
  });
});

test('disconnectRuntimeEvents closes the stream and stops the watchdog', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    let source = app._eventSource;

    disconnectRuntimeEvents(app);

    assert.equal(source.closed, true);
    assert.equal(app._eventSource, null);
    assert.ok(!app._runtimeEventsWatchdog);
    assert.ok(!app._runtimeEventsReconnectTimer);
  });
});

test('setConnectionStatus skips redundant writes so bindings are not woken needlessly', () => {
  let writes = [];
  let target = { connectionStatus: CONNECTED_STATUS, connectionStatusKind: 'ready' };
  let app = { _state: new Proxy(target, {
    set(object, key, value) {
      writes.push(key);
      object[key] = value;
      return true;
    },
  }) };

  setConnectionStatus(app, CONNECTED_STATUS, 'ready');
  assert.deepEqual(writes, []);

  setConnectionStatus(app, RECONNECTING_STATUS, 'pending');
  assert.deepEqual(writes, [ 'connectionStatus', 'connectionStatusKind' ]);
  assert.equal(target.connectionStatus, RECONNECTING_STATUS);
  assert.equal(target.connectionStatusKind, 'pending');
});

test('every stream event reaches the app handler after refreshing liveness', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    app._eventSource.emit('open');
    app._runtimeEventsLastEventAt = Date.now() - 120000;

    app._eventSource.emit('frame.added', { data: '{"type":"frame.added"}' });

    assert.equal(app.handled.length, 1, 'the event must still be handed to onRuntimeEvent');
    assert.ok(Date.now() - app._runtimeEventsLastEventAt < 1000);
    disconnectRuntimeEvents(app);
  });
});

test('a drop after the first open re-arms the stale-handshake watchdog', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    app._eventSource.emit('open');
    assert.equal(app._runtimeEventsConnectingSince, 0);

    app._eventSource.readyState = FakeEventSource.CONNECTING;
    onRuntimeEventsError(app, { target: app._eventSource });

    assert.equal(app._state.connectionStatus, RECONNECTING_STATUS);
    assert.ok(app._runtimeEventsConnectingSince > 0, 'expected the handshake clock to be re-armed');
    assert.equal(checkRuntimeEventsConnection(app, app._runtimeEventsConnectingSince + 60000), true);
    assert.equal(FakeEventSource.instances.length, 2);
    disconnectRuntimeEvents(app);
  });
});

test('a permanently closed stream backs off instead of retrying every second', () => {
  withFakeTimers((scheduled) => {
    withFakeEventSource(() => {
      let app = createApp();
      connectRuntimeEvents(app);

      for (let i = 0; i < 6; i++) {
        app._eventSource.close();
        onRuntimeEventsError(app, { target: app._eventSource });
        let timer = scheduled[scheduled.length - 1];
        assert.ok(timer, 'expected a scheduled reconnect');
        timer.fn();
      }

      assert.deepEqual(scheduled.map((timer) => timer.delay), [ 1000, 2000, 4000, 8000, 16000, 30000 ]);
      assert.equal(app._runtimeEventsRetryCount, 6);
      disconnectRuntimeEvents(app);
    });
  });
});

test('a successful open resets the reconnect backoff', async () => {
  await withFakeEventSource(async () => {
    let app = createApp();
    connectRuntimeEvents(app);
    app._runtimeEventsRetryCount = 5;

    app._eventSource.emit('open');
    assert.equal(app._runtimeEventsRetryCount, 0);
    disconnectRuntimeEvents(app);
  });
});
