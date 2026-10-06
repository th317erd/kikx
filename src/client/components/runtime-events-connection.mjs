'use strict';

// Connection lifecycle for the `/api/v1/events` SSE stream.
//
// Kept free of state/utils imports so it can be unit tested in plain Node: the
// only inputs are the host element (`app`, which exposes `_state` plus the bound
// handler hooks) and the global `EventSource`.
//
// Why this is more than "set Connected on open": an `error` event is NOT proof
// that the session is over. It fires for a transient drop, for the tab being
// frozen, and (in some browsers) for an EventSource we have already replaced.
// Treating every one of those as a permanent "Disconnected" is what left the
// indicator stuck: the stream had usually already recovered by the time the
// user looked at it, and nothing ever moved the label back.

export const EVENT_SOURCE_ROUTE = '/api/v1/events';

export const RUNTIME_EVENT_TYPES = [
  'connected',
  'heartbeat',
  'session.saved',
  'frame.added',
  'frame.updated',
  'frame.phantom',
  'commit',
  'tokens.updated',
];

export const CONNECTED_STATUS = 'Connected';
export const RECONNECTING_STATUS = 'Reconnecting…';
export const DISCONNECTED_STATUS = 'Disconnected';

// The server emits a `heartbeat` event every 25s. A stream that has been stuck
// mid-handshake for longer than this is never going to open on its own (queued
// behind the browser's per-origin connection limit, frozen tab, ...).
const WATCHDOG_INTERVAL_MS = 15000;
const STALE_CONNECTING_MS = 45000;
// A half-open socket (laptop suspended, NAT rebind, VPN drop) stays `OPEN`
// forever from the browser's point of view: without a liveness check the status
// would keep reading Connected while nothing is arriving at all.
const STALE_STREAM_MS = 90000;
// The browser backs off on its own, but it never retries a CLOSED stream, so we
// do -- and we must back off too, or a permanently closed stream (a proxy
// returning 502 during a restart) becomes a 1 Hz retry loop.
const MANUAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

export function setConnectionStatus(app, status, kind = 'pending') {
  if (app._state.connectionStatus === status && app._state.connectionStatusKind === kind)
    return;

  app._state.connectionStatus = status;
  app._state.connectionStatusKind = kind;
}

export function connectRuntimeEvents(app) {
  disconnectRuntimeEvents(app);

  if (typeof globalThis.EventSource !== 'function') {
    setConnectionStatus(app, DISCONNECTED_STATUS, 'error');
    return;
  }

  try {
    let source = new globalThis.EventSource(EVENT_SOURCE_ROUTE);
    app._eventSource = source;
    app._runtimeEventsConnectingSince = Date.now();
    app._runtimeEventsLastEventAt = Date.now();
    app._runtimeEventsRetryCount = app._runtimeEventsRetryCount || 0;
    source.addEventListener('open', app._onRuntimeEventsOpen);
    source.addEventListener('error', app._onRuntimeEventsError);
    for (let eventType of RUNTIME_EVENT_TYPES)
      source.addEventListener(eventType, app._runtimeEventsDispatch);
    startWatchdog(app);
  } catch (error) {
    app._eventSource = null;
    setConnectionStatus(app, DISCONNECTED_STATUS, 'error');
    app._state.status = error.message;
    app._state.statusKind = 'error';
  }
}

export function disconnectRuntimeEvents(app) {
  stopWatchdog(app);

  let source = app._eventSource;
  app._eventSource = null;
  if (source && typeof source.close === 'function')
    source.close();
}

export function onRuntimeEventsOpen(app) {
  app._runtimeEventsConnectingSince = 0;
  app._runtimeEventsLastEventAt = Date.now();
  app._runtimeEventsRetryCount = 0;
  setConnectionStatus(app, CONNECTED_STATUS, 'ready');
}

// Every runtime event means bytes arrived on this stream, which is the only
// liveness signal the client has.
export function noteRuntimeEvent(app) {
  app._runtimeEventsLastEventAt = Date.now();
}

export function onRuntimeEventsError(app, event = null) {
  // A late error from a source we have already replaced says nothing about the
  // stream we are actually on. Ignoring it is what keeps a stale failure from
  // poisoning the indicator for good.
  if (event?.target && app._eventSource && event.target !== app._eventSource)
    return;

  let source = app._eventSource;
  if (!source)
    return;

  if (source.readyState === CLOSED) {
    // The browser never retries a closed stream, so we have to.
    setConnectionStatus(app, DISCONNECTED_STATUS, 'error');
    scheduleManualReconnect(app);
    return;
  }

  // A drop *after* the first open must re-arm the stale-handshake clock, or the
  // watchdog's CONNECTING branch could never fire again.
  if (source.readyState === CONNECTING)
    app._runtimeEventsConnectingSince = Date.now();

  setConnectionStatus(app, RECONNECTING_STATUS, 'pending');
}

// Exported for its own tests: the interval below is the only production caller.
export function checkRuntimeEventsConnection(app, now = Date.now()) {
  let source = app._eventSource;
  if (!source || !app.isConnected)
    return false;

  if (typeof globalThis.document !== 'undefined' && globalThis.document.visibilityState && globalThis.document.visibilityState !== 'visible')
    return false;

  if (source.readyState === CLOSED) {
    connectRuntimeEvents(app);
    return true;
  }

  if (source.readyState === CONNECTING && now - (app._runtimeEventsConnectingSince || now) >= STALE_CONNECTING_MS) {
    connectRuntimeEvents(app);
    return true;
  }

  if (source.readyState === OPEN && now - (app._runtimeEventsLastEventAt || now) >= STALE_STREAM_MS) {
    // Nothing (not even a heartbeat) has arrived for far too long: treat the
    // stream as dead instead of reporting a healthy connection forever.
    setConnectionStatus(app, RECONNECTING_STATUS, 'pending');
    connectRuntimeEvents(app);
    return true;
  }

  return false;
}

export function isRuntimeEventsOpen(app) {
  return app._eventSource?.readyState === OPEN;
}

function scheduleManualReconnect(app) {
  if (app._runtimeEventsReconnectTimer)
    return;

  let attempt = app._runtimeEventsRetryCount || 0;
  let delay = Math.min(MANUAL_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
  app._runtimeEventsRetryCount = attempt + 1;
  app._runtimeEventsReconnectTimer = setTimeout(() => {
    app._runtimeEventsReconnectTimer = null;
    if (!app.isConnected)
      return;

    connectRuntimeEvents(app);
  }, delay);
  app._runtimeEventsReconnectTimer.unref?.();
}

function startWatchdog(app) {
  stopWatchdog(app);

  if (!app._runtimeEventsVisibilityHandler && typeof globalThis.document?.addEventListener === 'function') {
    app._runtimeEventsVisibilityHandler = () => {
      // Coming back to a tab that was frozen or throttled is exactly when a dead
      // stream becomes visible to the user, so re-check immediately.
      if (!app.isConnected || globalThis.document.visibilityState !== 'visible')
        return;

      if (!isRuntimeEventsOpen(app))
        connectRuntimeEvents(app);
    };
    globalThis.document.addEventListener('visibilitychange', app._runtimeEventsVisibilityHandler);
  }

  app._runtimeEventsWatchdog = setInterval(() => checkRuntimeEventsConnection(app), WATCHDOG_INTERVAL_MS);
  app._runtimeEventsWatchdog.unref?.();
}

function stopWatchdog(app) {
  if (app._runtimeEventsWatchdog) {
    clearInterval(app._runtimeEventsWatchdog);
    app._runtimeEventsWatchdog = null;
  }

  if (app._runtimeEventsReconnectTimer) {
    clearTimeout(app._runtimeEventsReconnectTimer);
    app._runtimeEventsReconnectTimer = null;
  }

  if (app._runtimeEventsVisibilityHandler && typeof globalThis.document?.removeEventListener === 'function') {
    globalThis.document.removeEventListener('visibilitychange', app._runtimeEventsVisibilityHandler);
    app._runtimeEventsVisibilityHandler = null;
  }
}
