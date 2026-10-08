'use strict';

// S4/S2: an oversized runtime-event body. The SSE backpressure guard checks the
// socket *before* each write, so a single event larger than the cap is still
// delivered intact; only the event after a stalled buffer destroys the stream.
// An unserializable payload must not take the stream down either.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { streamRuntimeEvents } from '../../src/server/events.mjs';

function createFakeResponse() {
  return {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    chunks: [],
    statusCode: null,
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function sseEvents(chunks) {
  let text = chunks.join('');
  let events = [];
  for (let block of text.split('\n\n')) {
    if (!block.includes('data:'))
      continue;

    let event = 'message';
    let data = [];
    for (let line of block.split('\n')) {
      if (line.startsWith('event:'))
        event = line.slice('event:'.length).trim();
      if (line.startsWith('data:'))
        data.push(line.slice('data:'.length).trimStart());
    }
    events.push({ event, data: data.join('\n') });
  }
  return events;
}

function startStream(maxBufferedBytes) {
  let request = new EventEmitter();
  let response = createFakeResponse();
  let frameRuntime = new EventEmitter();
  streamRuntimeEvents({ request, response, frameRuntime, sessionID: '', maxBufferedBytes });
  return { request, response, frameRuntime };
}

test('a single event larger than the SSE cap is delivered in full', () => {
  let { request, response, frameRuntime } = startStream(64);
  try {
    let oversized = 'x'.repeat(20_000);
    frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frame: { id: 'big', content: { text: oversized } } });

    assert.equal(response.destroyed, false, 'one oversized event must not be dropped');

    let events = sseEvents(response.chunks);
    let delivered = events.find((entry) => entry.event === 'frame.added');
    assert.ok(delivered, 'the oversized event must still arrive');
    assert.equal(JSON.parse(delivered.data).frame.content.text.length, 20_000);
  } finally {
    request.emit('close');
  }
});

test('the event after a stalled buffer evicts the stream', () => {
  let { request, response, frameRuntime } = startStream(64);
  try {
    frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frame: { id: 'one' } });
    let before = response.chunks.length;

    // Simulate a client that stopped reading: the writable buffer is already
    // past the cap when the next event arrives.
    response.writableLength = 65;
    frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frame: { id: 'two' } });

    assert.equal(response.destroyed, true);
    assert.equal(response.chunks.length, before, 'the stalled event must not be written');
  } finally {
    request.emit('close');
  }
});

test('an unserializable event is replaced by a safe error frame without killing the stream', () => {
  let { request, response, frameRuntime } = startStream(1024);
  try {
    let circular = { type: 'frame.added', sessionID: 's1' };
    circular.frame = circular;

    frameRuntime.emit('event', circular);
    assert.equal(response.destroyed, false, 'a poison payload must not destroy the stream');

    let events = sseEvents(response.chunks);
    let poison = events.find((entry) => entry.event === 'frame.added');
    assert.deepEqual(JSON.parse(poison.data), { type: 'frame.added', error: 'unserializable runtime event' });

    // A healthy event still flows after the poison one.
    frameRuntime.emit('event', { type: 'heartbeat', sessionID: 's1' });
    let heartbeat = sseEvents(response.chunks).find((entry) => entry.event === 'heartbeat');
    assert.deepEqual(JSON.parse(heartbeat.data), { type: 'heartbeat', sessionID: 's1' });
  } finally {
    request.emit('close');
  }
});

test('a session-scoped stream drops other sessions oversized events', () => {
  let request = new EventEmitter();
  let response = createFakeResponse();
  let frameRuntime = new EventEmitter();
  streamRuntimeEvents({ request, response, frameRuntime, sessionID: 's1', maxBufferedBytes: 64 });
  try {
    frameRuntime.emit('event', { type: 'frame.added', sessionID: 's2', frame: { id: 'other' } });
    assert.equal(sseEvents(response.chunks).some((entry) => entry.event === 'frame.added'), false);
  } finally {
    request.emit('close');
  }
});
