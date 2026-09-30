'use strict';

import { httpError } from './http-helpers.mjs';

export function streamRuntimeEvents({ request, response, frameRuntime, sessionID = '' }) {
  if (!frameRuntime || typeof frameRuntime.on !== 'function')
    throw httpError(500, 'Frame runtime does not support events');

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
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
    if (!response.destroyed)
      response.write(': heartbeat\n\n');
  }, 25000);
  heartbeat.unref?.();

  frameRuntime.on('event', handler);
  request.on('close', cleanup);
}

function writeSSE(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
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
