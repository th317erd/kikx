'use strict';

import { isCollapsed, setTokenUsage, upsertFrames, upsertSession } from '../state/kikx-state.mjs';
import { scheduleAnimationFrame, parseRuntimeEvent } from './kikx-app-helpers.mjs';
import { addFrameToBatch, addTouchedFrameIDs, renderedFrameIDsFor } from './frame-runtime-batch.mjs';
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

export function onRuntimeEvent(app, event) {
  let data = parseRuntimeEvent(event);
  if (!data)
    return;

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
    upsertSession(data.session, app._state);
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
    if (!app.isConnected)
      return;

    // Stay pinned to the bottom only when the user has not scrolled away. This is
    // O(1) and never rebuilds the app; the heavy per-frame work is already handled
    // by the coalesced frame.added / frame.updated batch.
    let frameList = app._frameListAnchoredToBottom ? app.querySelector('.kikx-frame-list') : null;
    if (frameList)
      app._scrollFramesToBottomImmediate?.(frameList);
  });
}

export function queueFrameRuntimeEvent(app, data) {
  app._pendingFrameRuntimeEvents.push(data);

  if (app._frameRuntimeFlushScheduled)
    return;

  app._frameRuntimeFlushScheduled = true;
  scheduleAnimationFrame(app._flushFrameRuntimeEvents);
}

export function flushFrameRuntimeEvents(app) {
  app._frameRuntimeFlushScheduled = false;
  let events = app._pendingFrameRuntimeEvents.splice(0);
  if (events.length === 0)
    return;

  let framesBySessionID = new Map();
  let touchedFrameIDsBySessionID = new Map();
  for (let data of events) {
    addFrameToBatch(framesBySessionID, data.sessionID, data.frame);
    addTouchedFrameIDs(touchedFrameIDsBySessionID, data.sessionID, renderedFrameIDsFor(data.frame));
  }
  upsertFrames(framesBySessionID, app._state);

  let selectedSessionID = app._state.selectedSessionID;
  let touchedFrameIDs = touchedFrameIDsBySessionID.get(selectedSessionID);
  if (touchedFrameIDs)
    app._syncFrameThread(selectedSessionID, { touchedFrameIDs });

  let affectedSessionIDs = [ ...framesBySessionID.keys() ].filter((sessionID) => sessionID !== selectedSessionID);
  if (affectedSessionIDs.length > 0 && isCollapsed(app._state))
    app._schedulePreviewRefresh(affectedSessionIDs);

  if (app._pendingFrameRuntimeEvents.length > 0 && !app._frameRuntimeFlushScheduled) {
    app._frameRuntimeFlushScheduled = true;
    scheduleAnimationFrame(app._flushFrameRuntimeEvents);
  }
}
