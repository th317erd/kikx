'use strict';

import { httpError } from './http-helpers.mjs';

// A client that opens the stream and stops reading would otherwise let the
// response's writable buffer grow with every event for the life of the process.
// A healthy client drains continuously, so a backlog above this cap means the
// socket is stalled: destroy it and let the client's reconnect ladder retry.
// The check runs before each write, so a single large event that pushes the
// buffer past the cap is still delivered; the next event evicts the stream.
export const DEFAULT_MAX_SSE_BUFFERED_BYTES = 1024 * 1024;
// Runtime frame streams are intentionally buffered. A thinking/model stream can
// emit hundreds of updates per second; sending each one makes every connected UI
// parse and render the same frame repeatedly. The latest update per
// session/frame/type is retained, then flushed on a bounded cadence or when the
// queue reaches its capacity, whichever happens first.
export const DEFAULT_SSE_COALESCE_DELAY_MS = 500;
export const DEFAULT_SSE_COALESCE_LIMIT = 200;

export function streamRuntimeEvents({
  request,
  response,
  frameRuntime,
  eventGateway = null,
  sessionID = '',
  maxBufferedBytes = DEFAULT_MAX_SSE_BUFFERED_BYTES,
  coalesce = false,
  coalesceDelayMs = DEFAULT_SSE_COALESCE_DELAY_MS,
  coalesceLimit = DEFAULT_SSE_COALESCE_LIMIT,
}) {
  if (!frameRuntime || typeof frameRuntime.on !== 'function')
    throw httpError(500, 'Frame runtime does not support events');

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // A buffering proxy would hold events back until the stream closes, which
    // looks exactly like a dropped connection to the client.
    'X-Accel-Buffering': 'no',
  });

  writeSSE(response, 'connected', { ok: true }, maxBufferedBytes);

  // Prefer the shared gateway: one coalescing buffer per server instead of one
  // per SSE connection. The local path remains for embedders and focused tests.
  let stopEvents = null;
  if (typeof eventGateway?.subscribe === 'function') {
    let unsubscribe = eventGateway.subscribe({
      sessionID,
      onBatch: (events) => {
        for (let event of events)
          writeSSE(response, event.type || 'message', event, maxBufferedBytes);
      },
    });
    stopEvents = () => unsubscribe?.();
  } else {
    let pending = [];
    let pendingKeys = new Map();
    let flushTimer = null;
    let flushPending = () => {
      if (flushTimer != null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      let batch = pending;
      pending = [];
      pendingKeys.clear();
      for (let queued of batch)
        writeSSE(response, queued.type || 'message', queued, maxBufferedBytes);
    };
    let scheduleFlush = () => {
      if (flushTimer != null)
        return;
      flushTimer = setTimeout(flushPending, Math.max(0, Number(coalesceDelayMs) || 0));
      flushTimer.unref?.();
    };
    let enqueue = (event) => {
      if (!coalesce) {
        writeSSE(response, event.type || 'message', event, maxBufferedBytes);
        return;
      }

      let key = coalescableFrameKey(event);
      if (key) {
        let existing = pendingKeys.get(key);
        if (typeof existing === 'number' && existing < pending.length) {
          pending[existing] = event;
          scheduleFlush();
          return;
        }
        pendingKeys.set(key, pending.length);
      }
      pending.push(event);

      // Capacity is a hard bound, not a second timer: flush immediately when
      // enough distinct frame entries have accumulated, otherwise wait out the
      // interval. Repeated updates for one frame replace in place and therefore
      // do not count toward the limit.
      if (coalesceLimit > 0 && pending.length >= coalesceLimit) {
        flushPending();
        return;
      }
      scheduleFlush();
    };
    let handler = (event) => {
      if (sessionID && event.sessionID && event.sessionID !== sessionID)
        return;

      enqueue(event);
    };

    stopEvents = () => {
      frameRuntime.off?.('event', handler);
      if (flushTimer != null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending = [];
      pendingKeys.clear();
    };

    try {
      frameRuntime.on('event', handler);
    } catch (error) {
      stopEvents();
      throw error;
    }
  }

  let heartbeat = setInterval(() => {
    // A real event, not an SSE comment: the client needs a signal it can
    // actually observe to tell a live stream from a half-open one.
    writeSSE(response, 'heartbeat', { ok: true }, maxBufferedBytes);
  }, 25000);
  heartbeat.unref?.();

  let cleaned = false;
  let cleanup = () => {
    if (cleaned)
      return;
    cleaned = true;
    stopEvents?.();
    clearInterval(heartbeat);
  };

  // Register the cleanup BEFORE subscribing for the local path: a throwing
  // `.on` would otherwise leave the heartbeat interval running for the life of
  // the process. The gateway path is already subscribed by this point.
  request.on('close', cleanup);
  response.on?.('close', cleanup);
}

function coalescableFrameKey(event) {
  let type = event?.type;
  if (type !== 'frame.added' && type !== 'frame.updated' && type !== 'frame.phantom')
    return '';

  let sessionID = event?.sessionID;
  let frame = event?.frame;
  if (typeof sessionID !== 'string' || !sessionID || typeof frame?.id !== 'string' || !frame.id)
    return '';

  // The client already coalesces per session/frame/type. Do the same at the
  // SSE boundary so a token-by-token stream does not force a full-frame write
  // and parse for every delta. Keep the frame type in the key so BeginTyping
  // and EndTyping (same id, different type) remain distinct.
  return `${sessionID}\u0000${frame.type || ''}\u0000${frame.id}`;
}

function writeSSE(response, event, data, maxBufferedBytes = DEFAULT_MAX_SSE_BUFFERED_BYTES) {
  // The socket can go away between the cleanup listener firing and the next
  // event; writing to it then would raise an async 'error' on the response.
  if (!response || response.destroyed || response.writableEnded)
    return;

  if (isResponseStalled(response, maxBufferedBytes)) {
    response.destroy();
    return;
  }

  let payload;
  try {
    payload = JSON.stringify(data);
  } catch (error) {
    // One unserializable payload must never take the whole stream down with it:
    // a half-written SSE frame makes the client drop the connection.
    response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, error: 'unserializable runtime event' })}\n\n`);
    return;
  }

  response.write(`event: ${event}\ndata: ${payload}\n\n`);
}

function isResponseStalled(response, maxBufferedBytes) {
  let cap = Number(maxBufferedBytes);
  if (!Number.isFinite(cap) || cap <= 0)
    return false;

  return typeof response.writableLength === 'number' && response.writableLength > cap;
}

export function connectTokenUsageToRuntime(tokenUsage, frameRuntime) {
  if (!tokenUsage || typeof tokenUsage.on !== 'function' || !frameRuntime)
    return;

  tokenUsage.on('updated', (event) => {
    let payload = event || {};
    if (typeof frameRuntime.emitRuntimeEvent === 'function') {
      frameRuntime.emitRuntimeEvent('tokens.updated', payload);
      return;
    }

    frameRuntime.emit?.('event', {
      type: 'tokens.updated',
      ...payload,
    });
  });
}
