'use strict';

// S2 lifecycle audit: no timer, listener, or observer may be registered per
// render or per reconnect without a matching teardown. These specs render and
// reconnect repeatedly and assert the counts stay flat.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, window } = installDom();
globalThis.document = document;
globalThis.window = window;

await import('../../src/client/components/kikx-frame-item.mjs');
await import('../../src/client/components/kikx-chat-view.mjs');
await import('../../src/client/components/kikx-app.mjs');
const { connectFrameListObserver, disconnectFrameListObserver } = await import('../../src/client/components/kikx-frame-scroll.mjs');
const { connectRuntimeEvents, disconnectRuntimeEvents } = await import('../../src/client/components/runtime-events-connection.mjs');
const { createSessionStateSnapshot } = await import('../../src/client/state/session-state-utils.mjs');

class FakeResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    let list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    let list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

function installTimerCounters() {
  let active = new Set();
  let originals = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  globalThis.setInterval = (callback, ms) => {
    let handle = { callback, ms, unref() {} };
    active.add(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    active.delete(handle);
  };
  globalThis.setTimeout = (callback, ms) => {
    let handle = { callback, ms, unref() {} };
    active.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    active.delete(handle);
  };

  return {
    active,
    restore() {
      globalThis.setInterval = originals.setInterval;
      globalThis.clearInterval = originals.clearInterval;
      globalThis.setTimeout = originals.setTimeout;
      globalThis.clearTimeout = originals.clearTimeout;
    },
  };
}

test('reconnecting the frame-list observer does not stack listeners or observers', () => {
  FakeResizeObserver.instances.length = 0;
  globalThis.ResizeObserver = FakeResizeObserver;

  let app = document.createElement('div');
  let frameList = document.createElement('div');
  frameList.className = 'kikx-frame-list';
  let stream = document.createElement('div');
  stream.className = 'kikx-frame-stream';
  frameList.appendChild(stream);
  app.appendChild(frameList);
  app._onFrameListScroll = () => {};

  connectFrameListObserver(app);
  connectFrameListObserver(app);

  assert.equal(frameList.listenerCount('scroll'), 1, 'a re-connect must not stack scroll listeners');
  assert.equal(
    FakeResizeObserver.instances.filter((observer) => !observer.disconnected).length,
    1,
    'the previous observer must be disconnected before a new one is installed',
  );

  disconnectFrameListObserver(app);
  assert.equal(frameList.listenerCount('scroll'), 0);
  assert.equal(FakeResizeObserver.instances.filter((observer) => !observer.disconnected).length, 0);
});

test('mount/unmount removes app-level listeners, repeatedly', () => {
  let app = document.createElement('kikx-app');
  // Keep the auth shell tiny; listener lifecycle is independent of shell content.
  app._buildAuthShell = () => document.createElement('div');

  for (let cycle = 0; cycle < 3; cycle += 1) {
    document.body.appendChild(app);
    assert.equal(app.listenerCount('kikx-session-enter'), 1, `cycle ${cycle}: enter listener while mounted`);
    assert.equal(window.listenerCount('popstate'), 1, `cycle ${cycle}: popstate listener while mounted`);

    app._render();
    assert.equal(app.listenerCount('kikx-session-enter'), 1, `cycle ${cycle}: extra render must not add listeners`);

    app.remove();
    assert.equal(app.listenerCount('kikx-session-enter'), 0, `cycle ${cycle}: enter listener removed on unmount`);
    assert.equal(window.listenerCount('popstate'), 0, `cycle ${cycle}: popstate listener removed on unmount`);
  }
});

// P3-e: _installAppListeners() also installs the app-level visibilitychange
// drain (used to flush the hidden-tab frame queue on return). The mini-dom
// document is not an event target, so teach it to accept listeners for the
// duration of the test and prove the listener is added once and removed on
// disconnect.
test('the app-level visibility drain is removed on disconnect', () => {
  let listeners = new Map();
  document.visibilityState = 'visible';
  document.addEventListener = (type, listener) => {
    let list = listeners.get(type) || [];
    list.push(listener);
    listeners.set(type, list);
  };
  document.removeEventListener = (type, listener) => {
    let list = listeners.get(type) || [];
    listeners.set(type, list.filter((entry) => entry !== listener));
  };
  document.listenerCount = (type) => (listeners.get(type) || []).length;

  try {
    let app = document.createElement('kikx-app');
    app._buildAuthShell = () => document.createElement('div');

    document.body.appendChild(app);
    assert.equal(document.listenerCount('visibilitychange'), 1, 'installed while mounted');

    app._render();
    assert.equal(document.listenerCount('visibilitychange'), 1, 'an extra render must not stack listeners');

    app.remove();
    assert.equal(document.listenerCount('visibilitychange'), 0, 'removed on disconnect');
  } finally {
    delete document.addEventListener;
    delete document.removeEventListener;
    delete document.listenerCount;
    delete document.visibilityState;
  }
});

test('reconnect cycles do not stack watchdog timers or visibility listeners', () => {
  let timers = installTimerCounters();
  let originalDocument = globalThis.document;
  let originalEventSource = globalThis.EventSource;
  let visibilityListeners = new Set();
  let fakeDocument = {
    visibilityState: 'visible',
    addEventListener(type, listener) {
      if (type === 'visibilitychange')
        visibilityListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'visibilitychange')
        visibilityListeners.delete(listener);
    },
  };

  globalThis.document = fakeDocument;
  globalThis.EventSource = FakeEventSource;
  FakeEventSource.instances.length = 0;

  try {
    let app = connectionApp();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      connectRuntimeEvents(app);
      disconnectRuntimeEvents(app);
    }

    assert.equal(visibilityListeners.size, 0, 'every reconnect must tear down its visibility handler');
    assert.equal(timers.active.size, 0, 'every reconnect must clear its watchdog timer');

    connectRuntimeEvents(app);
    assert.equal(visibilityListeners.size, 1, 'exactly one visibility handler while connected');
    assert.equal(timers.active.size, 1, 'exactly one watchdog timer while connected');

    disconnectRuntimeEvents(app);
    assert.equal(visibilityListeners.size, 0);
    assert.equal(timers.active.size, 0);
    assert.ok(FakeEventSource.instances.every((source) => source.closed), 'every source is closed');
  } finally {
    globalThis.document = originalDocument;
    globalThis.EventSource = originalEventSource;
    timers.restore();
  }
});

function connectionApp() {
  let state = createSessionStateSnapshot();
  return {
    isConnected: true,
    _state: state,
    _onRuntimeEventsOpen: () => {},
    _onRuntimeEventsError: () => {},
    _runtimeEventsDispatch: () => {},
  };
}
