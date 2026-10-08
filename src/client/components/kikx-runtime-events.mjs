'use strict';

import { isCollapsed, setTokenUsage, upsertFrames, upsertSession } from '../state/kikx-state.mjs';
import { isDeletedSession } from '../state/session-state-utils.mjs';
import { guardClientOperation, reportClientError } from '../lib/error-boundary.mjs';
import { scheduleAnimationFrame, parseRuntimeEventResult } from './kikx-app-helpers.mjs';
import { addFrameToBatch, addTouchedFrameIDs, renderedFrameIDsFor } from './frame-runtime-batch.mjs';
import { pruneMissingSessionsFromStack } from './kikx-navigation.mjs';
import { CONNECTED_STATUS, setConnectionStatus } from './runtime-events-connection.mjs';

export {
  CONNECTED_STATUS,
  DISCONNECTED_STATUS,
  RECONNECTING_STATUS,
  checkRuntimeEventsConnection,
  connectRuntimeEvents,
  disconnectRuntimeEvents,
  isRuntimeEventsOpen,
  noteRuntimeEvent,
  onRuntimeEventsError,
  onRuntimeEventsOpen,
} from './runtime-events-connection.mjs';

// Runtime events that are informational only: they carry no frame data the
// client has not ALREADY received via frame.added / frame.updated (the server
// emits per-frame events AND a `commit` event for every commit). These must
// never trigger a full application re-render -- a whole-app rebuild per commit
// is what wedged the main thread while an agent streamed many small commits.
const INFORMATIONAL_RUNTIME_EVENTS = new Set([
  'commit',
  'compaction.started',
  'compaction.completed',
  'compaction.failed',
  'frame.scheduled.fired',
]);

// W8: hard bound on queued frame runtime events. Coalescing keeps repeated
// updates for one frame from consuming slots at all, so the cap only bites when
// a session streams many DISTINCT frames faster than the drain can run (a hidden
// or frozen tab). On overflow the oldest payloads are dropped and their sessions
// are marked for a full re-fetch so nothing is silently lost.
export const MAX_PENDING_FRAME_RUNTIME_EVENTS = 500;

export function onRuntimeEvent(app, event) {
  guardClientOperation('kikx-runtime-events.dispatch', () => {
    dispatchRuntimeEvent(app, event);
  }, { eventType: event?.type });
}

function dispatchRuntimeEvent(app, event) {
  let parsed = parseRuntimeEventResult(event);
  if (!parsed.ok) {
    // A malformed payload used to return here without a trace, so a systematic
    // serialization fault (a bad proxy, an encoder regression) would drop every
    // event silently. Report it through the same boundary as other failures.
    // The message is deliberately constant so the boundary's label+message
    // repeat throttle bounds the ring and the console; the event type, the
    // parse error, and a bounded payload excerpt carry the diagnostic context.
    reportClientError('kikx-runtime-events.parse', new Error('Malformed runtime event payload'), {
      eventType: safeEventType(event),
      dataPreview: parsed.preview,
      parseError: parsed.error?.message || String(parsed.error || ''),
    });
    return;
  }

  let data = parsed.data;

  if (data.type === 'connected' || data.type === 'open') {
    setConnectionStatus(app, CONNECTED_STATUS, 'ready');
    return;
  }

  // Keepalive from the server (see runtime-events-connection.mjs); liveness was
  // already recorded by the dispatcher. Nothing in the UI depends on it.
  if (data.type === 'heartbeat')
    return;

  if (data.type === 'tokens.updated') {
    setTokenUsage(data.tokenUsage || {}, data.totalTokensUsed, app._state);
    return;
  }

  if (data.type === 'session.saved' && data.session?.id) {
    let wasListed = (app._state.sessionIDs || []).includes(data.session.id);
    upsertSession(data.session, app._state);
    // A soft delete performed in another tab arrives as session.saved with a
    // deletedAt stamp. upsertSession removes the id; the navigation stack (and
    // the address bar) still point at it, so prune before rendering or this tab
    // would show a thread for a card that no longer exists.
    if (wasListed && isDeletedSession(data.session))
      pruneMissingSessionsFromStack(app);

    if (!app._syncSessionShell())
      app._requestRender();
    return;
  }

  if ((data.type === 'frame.added' || data.type === 'frame.updated' || data.type === 'frame.phantom') && data.sessionID && data.frame?.id) {
    queueFrameRuntimeEvent(app, data);
    return;
  }

  // Informational events (see INFORMATIONAL_RUNTIME_EVENTS) reconcile on the next
  // animation frame instead of rebuilding the app. They are coalesced so a burst
  // of commits during streaming produces at most one cheap task per frame.
  if (INFORMATIONAL_RUNTIME_EVENTS.has(data.type)) {
    scheduleRuntimeReconcile(app, data.sessionID);
    return;
  }

  // Unknown event types are intentionally ignored. Re-rendering the whole app for
  // an event we do not understand is never correct, and it is exactly the kind of
  // blanket rebuild that can freeze the UI.
}

// Reading `event.type` can itself throw on a poisoned payload; the diagnostic
// context must never turn a contained failure into an uncontained one.
function safeEventType(event) {
  try {
    return event?.type ?? null;
  } catch {
    return '<unreadable>';
  }
}

export function scheduleRuntimeReconcile(app, sessionID = '') {
  // A commit for a session that is not on screen changes nothing in the current
  // view, so skip it entirely.
  if (sessionID && sessionID !== app._state.selectedSessionID)
    return;

  if (app._runtimeReconcileScheduled)
    return;

  app._runtimeReconcileScheduled = true;
  scheduleAnimationFrame(() => {
    app._runtimeReconcileScheduled = false;
    guardClientOperation('kikx-runtime-events.reconcile', () => {
      if (!app.isConnected)
        return;

      // Stay pinned to the bottom only when the user has not scrolled away. This is
      // O(1) and never rebuilds the app; the heavy per-frame work is already handled
      // by the coalesced frame.added / frame.updated batch.
      let frameList = app._frameListAnchoredToBottom ? app.querySelector('.kikx-frame-list') : null;
      if (frameList)
        app._scrollFramesToBottomImmediate?.(frameList);
    });
  });
}

function frameRuntimeEventKey(data) {
  let sessionID = typeof data?.sessionID === 'string' ? data.sessionID : '';
  if (!sessionID)
    return '';

  let frameID = '';
  try {
    frameID = data?.frame?.id ?? '';
  } catch {
    return '';
  }

  return typeof frameID === 'string' && frameID ? `${sessionID}::${frameID}` : '';
}

function rebuildFrameRuntimeEventKeys(app, queue) {
  let keys = new Map();
  for (let index = 0; index < queue.length; index += 1) {
    let key = frameRuntimeEventKey(queue[index]);
    if (key)
      keys.set(key, index);
  }

  app._pendingFrameRuntimeEventKeys = keys;
  return keys;
}

function ensureFrameRuntimeEventKeys(app, queue) {
  let keys = app._pendingFrameRuntimeEventKeys;
  if (!(keys instanceof Map) || keys.size !== queue.length)
    return rebuildFrameRuntimeEventKeys(app, queue);

  return keys;
}

function scheduleFrameRuntimeFlush(app) {
  if (app._frameRuntimeFlushScheduled)
    return;

  app._frameRuntimeFlushScheduled = true;
  scheduleAnimationFrame(app._flushFrameRuntimeEvents);
}

function markSessionForRefresh(app, sessionID) {
  if (!sessionID)
    return;

  if (!(app._frameRuntimeRefreshSessionIDs instanceof Set))
    app._frameRuntimeRefreshSessionIDs = new Set();

  app._frameRuntimeRefreshSessionIDs.add(sessionID);
}

function evictFrameRuntimeOverflow(app, queue) {
  let overflow = queue.length - MAX_PENDING_FRAME_RUNTIME_EVENTS;
  if (overflow <= 0)
    return;

  let dropped = queue.splice(0, overflow);
  for (let data of dropped) {
    let sessionID = typeof data?.sessionID === 'string' ? data.sessionID : '';
    markSessionForRefresh(app, sessionID);
  }

  rebuildFrameRuntimeEventKeys(app, queue);
}

export function queueFrameRuntimeEvent(app, data) {
  let queue = Array.isArray(app._pendingFrameRuntimeEvents)
    ? app._pendingFrameRuntimeEvents
    : (app._pendingFrameRuntimeEvents = []);

  let key = frameRuntimeEventKey(data);
  if (key) {
    let keys = ensureFrameRuntimeEventKeys(app, queue);
    let index = keys.get(key);
    if (typeof index === 'number' && index < queue.length && frameRuntimeEventKey(queue[index]) === key) {
      // Same session+frame: the newest payload supersedes the queued one, so a
      // streaming frame occupies one slot instead of one per commit.
      queue[index] = data;
      scheduleFrameRuntimeFlush(app);
      return;
    }

    keys.set(key, queue.length);
  }

  queue.push(data);
  if (queue.length > MAX_PENDING_FRAME_RUNTIME_EVENTS)
    evictFrameRuntimeOverflow(app, queue);

  scheduleFrameRuntimeFlush(app);
}

function drainFrameRuntimeRefresh(app) {
  let refresh = app._frameRuntimeRefreshSessionIDs;
  if (!(refresh instanceof Set) || refresh.size === 0)
    return;

  app._frameRuntimeRefreshSessionIDs = new Set();
  let refreshedSessionIDs = [];
  for (let sessionID of refresh) {
    guardClientOperation('kikx-runtime-events.refreshDroppedSession', () => {
      app._loadFrames?.(sessionID, { merge: true });
    }, { sessionID });
    refreshedSessionIDs.push(sessionID);
  }

  // The dropped window also invalidates the session card preview, and
  // syncFrameThread() early-returns for non-selected sessions, so refresh the
  // grid previews here explicitly. Only the collapsed grid shows cards.
  if (refreshedSessionIDs.length > 0 && isCollapsed(app._state)) {
    guardClientOperation('kikx-runtime-events.refreshDroppedSessionPreviews', () => {
      app._schedulePreviewRefresh?.(refreshedSessionIDs);
    }, { sessionCount: refreshedSessionIDs.length });
  }
}

export function flushFrameRuntimeEvents(app) {
  app._frameRuntimeFlushScheduled = false;
  try {
    guardClientOperation('kikx-runtime-events.flush', () => {
      processFrameRuntimeEvents(app);
    });
    drainFrameRuntimeRefresh(app);
  } finally {
    if (app._pendingFrameRuntimeEvents?.length > 0 && !app._frameRuntimeFlushScheduled)
      scheduleFrameRuntimeFlush(app);
  }
}

// W8: when the tab comes back to the foreground, flush whatever is still queued
// instead of waiting for the (previously paused) rAF. The connection module
// already re-checks the SSE stream on visibilitychange; this only drains the
// data queue and leaves that behavior alone.
export function installFrameRuntimeVisibilityDrain(app, target = globalThis.document) {
  if (!target || typeof target.addEventListener !== 'function')
    return false;

  uninstallFrameRuntimeVisibilityDrain(app);

  app._frameRuntimeVisibilityTarget = target;
  app._frameRuntimeVisibilityHandler = () => {
    if (target.visibilityState && target.visibilityState !== 'visible')
      return;

    guardClientOperation('kikx-runtime-events.visibilityDrain', () => {
      flushFrameRuntimeEvents(app);
    });
  };
  target.addEventListener('visibilitychange', app._frameRuntimeVisibilityHandler);
  return true;
}

export function uninstallFrameRuntimeVisibilityDrain(app) {
  let target = app._frameRuntimeVisibilityTarget;
  let handler = app._frameRuntimeVisibilityHandler;
  app._frameRuntimeVisibilityTarget = null;
  app._frameRuntimeVisibilityHandler = null;

  if (target && handler && typeof target.removeEventListener === 'function')
    target.removeEventListener('visibilitychange', handler);
}

function processFrameRuntimeEvents(app) {
  let events = app._pendingFrameRuntimeEvents.splice(0);
  app._pendingFrameRuntimeEventKeys = new Map();
  if (events.length === 0)
    return;

  let framesBySessionID = new Map();
  let touchedFrameIDsBySessionID = new Map();
  for (let data of events) {
    // Guard each entry: a poison payload (e.g. a throwing frame getter) must not
    // abort the whole spliced batch and leave the queue silently empty. The bad
    // entry is reported and skipped; the rest of the batch still builds. Meta is
    // built lazily inside the boundary -- touching `data.frame` out here would
    // re-introduce the very throw we are containing.
    let frameID = null;
    try {
      frameID = data.frame?.id ?? null;
    } catch {
      frameID = null;
    }

    guardClientOperation('kikx-runtime-events.batchEntry', () => {
      addFrameToBatch(framesBySessionID, data.sessionID, data.frame);
      addTouchedFrameIDs(touchedFrameIDsBySessionID, data.sessionID, renderedFrameIDsFor(data.frame));
    }, { sessionID: data.sessionID, frameID });
  }

  // Each step is its own boundary: a bad session state or a throwing thread sync
  // must not skip the preview refresh for the other sessions in the same batch.
  guardClientOperation('kikx-runtime-events.upsertFrames', () => {
    upsertFrames(framesBySessionID, app._state);
  }, { sessionCount: framesBySessionID.size });

  let selectedSessionID = app._state.selectedSessionID;
  let touchedFrameIDs = touchedFrameIDsBySessionID.get(selectedSessionID);
  if (touchedFrameIDs) {
    guardClientOperation('kikx-runtime-events.syncThread', () => {
      app._syncFrameThread(selectedSessionID, { touchedFrameIDs });
    }, { sessionID: selectedSessionID });
  }

  let affectedSessionIDs = [ ...framesBySessionID.keys() ].filter((sessionID) => sessionID !== selectedSessionID);
  if (affectedSessionIDs.length > 0 && isCollapsed(app._state)) {
    guardClientOperation('kikx-runtime-events.previewRefresh', () => {
      app._schedulePreviewRefresh(affectedSessionIDs);
    }, { sessionCount: affectedSessionIDs.length });
  }
}
