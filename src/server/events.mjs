'use strict';

import { httpError } from './http-helpers.mjs';

export function streamRuntimeEvents({ request, response, frameRuntime, sessionID = '' }) {
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

  writeSSE(response, 'connected', { ok: true });

  let handler = (event) => {
    if (sessionID && event.sessionID && event.sessionID !== sessionID)
      return;

    writeSSE(response, event.type || 'message', event);
  };
  let cleanup = () => {
    frameRuntime.off?.('event', handler);
    clearInterval(heartbeat);
  };
  let heartbeat = setInterval(() => {
    // A real event, not an SSE comment: the client needs a signal it can
    // actually observe to tell a live stream from a half-open one.
    writeSSE(response, 'heartbeat', { ok: true });
  }, 25000);
  heartbeat.unref?.();

  // Register the cleanup BEFORE subscribing: a throwing `.on` would otherwise
  // leave the heartbeat interval running for the life of the process.
  request.on('close', cleanup);
  try {
    frameRuntime.on('event', handler);
  } catch (error) {
    cleanup();
    throw error;
  }
}

function writeSSE(response, event, data) {
  // The socket can go away between the cleanup listener firing and the next
  // event; writing to it then would raise an async 'error' on the response.
  if (!response || response.destroyed || response.writableEnded)
    return;

  let payload;
  try {
    payload = JSON.stringify(data);
  } catch (error) {
    // One unserializable payload must never take the whole stream down with it:
    // a half-written SSE frame makes the client drop the connection.
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify({ type: event, error: 'unserializable runtime event' })}\n\n`);
    return;
  }

  response.write(`event: ${event}\n`);
  response.write(`data: ${payload}\n\n`);
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
