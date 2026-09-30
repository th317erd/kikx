'use strict';

import { isCollapsed, setTokenUsage, upsertFrames, upsertSession } from '../state/kikx-state.mjs';
import { scheduleAnimationFrame, parseRuntimeEvent } from './kikx-app-helpers.mjs';
import { addFrameToBatch, addTouchedFrameIDs, renderedFrameIDsFor } from './frame-runtime-batch.mjs';

export function connectRuntimeEvents(app) {
  disconnectRuntimeEvents(app);

  if (typeof EventSource !== 'function') {
    app._state.connectionStatus = 'Disconnected';
    app._state.connectionStatusKind = 'error';
    return;
  }

  try {
    app._eventSource = new EventSource('/api/v1/events');
    app._eventSource.addEventListener('open', app._onRuntimeEventsOpen);
    app._eventSource.addEventListener('error', app._onRuntimeEventsError);
    for (let eventType of [ 'connected', 'session.saved', 'frame.added', 'frame.updated', 'frame.phantom', 'commit', 'tokens.updated' ])
      app._eventSource.addEventListener(eventType, app._onRuntimeEvent);
  } catch (error) {
    app._state.connectionStatus = 'Disconnected';
    app._state.connectionStatusKind = 'error';
    app._state.status = error.message;
    app._state.statusKind = 'error';
  }
}

export function disconnectRuntimeEvents(app) {
  if (!app._eventSource)
    return;

  app._eventSource.close();
  app._eventSource = null;
}

export function onRuntimeEventsOpen(app) {
  app._state.connectionStatus = 'Connected';
  app._state.connectionStatusKind = 'ready';
}

export function onRuntimeEventsError(app) {
  app._state.connectionStatus = 'Disconnected';
  app._state.connectionStatusKind = 'error';
}

export function onRuntimeEvent(app, event) {
  let data = parseRuntimeEvent(event);
  if (!data)
    return;

  if (data.type === 'connected') {
    app._state.connectionStatus = 'Connected';
    app._state.connectionStatusKind = 'ready';
    return;
  }

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

  if (data.sessionID === app._state.selectedSessionID && app._frameListAnchoredToBottom)
    app._forceScrollToBottomAfterRender = true;

  app._requestRender();
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
