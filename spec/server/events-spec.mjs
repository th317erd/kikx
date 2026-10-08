'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { streamRuntimeEvents } from '../../src/server/events.mjs';

function createResponse() {
  return {
    chunks: [],
    destroyed: false,
    headers: null,
    status: 0,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      let text = String(chunk);
      this.chunks.push(text);
      // Model a socket buffer: every write adds unflushed bytes. A stalled client
      // never drains, so `writableLength` only ever grows.
      this.writableLength = (this.writableLength || 0) + text.length;
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
    get body() {
      return this.chunks.join('');
    },
  };
}

function createRequest() {
  let emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    close() {
      emitter.emit('close');
    },
  };
}

function createFrameRuntime() {
  return new EventEmitter();
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test('streamRuntimeEvents opens an unbuffered event stream', () => {
  let response = createResponse();
  streamRuntimeEvents({ request: createRequest(), response, frameRuntime: createFrameRuntime() });

  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(response.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(response.headers.Connection, 'keep-alive');
  // A buffering proxy would stall the stream in a way the client reads as a drop.
  assert.equal(response.headers['X-Accel-Buffering'], 'no');
  assert.equal(response.body, frame('connected', { ok: true }));
});

test('streamRuntimeEvents forwards runtime events and stops on request close', () => {
  let request = createRequest();
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request, response, frameRuntime });

  frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frameID: 'f1' });
  assert.equal(response.body, frame('connected', { ok: true }) + frame('frame.added', { type: 'frame.added', sessionID: 's1', frameID: 'f1' }));

  request.close();
  frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frameID: 'f1' });
  assert.equal(response.body.includes('frame.updated'), false);
  assert.equal(frameRuntime.listenerCount('event'), 0);
});

test('streamRuntimeEvents filters events belonging to another session', () => {
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request: createRequest(), response, frameRuntime, sessionID: 's1' });

  frameRuntime.emit('event', { type: 'frame.added', sessionID: 's2', frameID: 'f2' });
  assert.equal(response.body.includes('f2'), false);

  frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frameID: 'f3' });
  frameRuntime.emit('event', { type: 'commit', frameID: 'f4' });
  assert.equal(response.body.includes('f3'), true);
  assert.equal(response.body.includes('f4'), true);
});

test('streamRuntimeEvents falls back to the message event name', () => {
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request: createRequest(), response, frameRuntime });

  frameRuntime.emit('event', { sessionID: 's1' });
  assert.equal(response.body.endsWith('event: message\ndata: {"sessionID":"s1"}\n\n'), true);
});

test('streamRuntimeEvents heartbeats a stream that has no traffic', (t) => {
  t.mock.timers.enable({ apis: [ 'setInterval' ] });
  let response = createResponse();
  streamRuntimeEvents({ request: createRequest(), response, frameRuntime: createFrameRuntime() });

  t.mock.timers.tick(25000);
  // A real event rather than an SSE comment: the client can only observe a real
  // event, and it needs that to detect a half-open stream.
  assert.equal(response.body.endsWith(frame('heartbeat', { ok: true })), true);

  // A stream that has already ended must not be written to again.
  response.writableEnded = true;
  let length = response.body.length;
  t.mock.timers.tick(25000);
  assert.equal(response.body.length, length);
});

test('a throwing subscription cannot leak the heartbeat interval', (t) => {
  t.mock.timers.enable({ apis: [ 'setInterval' ] });
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  frameRuntime.on = () => {
    throw new Error('subscription failed');
  };

  assert.throws(() => streamRuntimeEvents({ request: createRequest(), response, frameRuntime }), /subscription failed/);

  let length = response.body.length;
  t.mock.timers.tick(25000);
  assert.equal(response.body.length, length, 'the heartbeat must be cleared when the subscription fails');
  assert.equal(frameRuntime.listenerCount('event'), 0);
});

test('an unserializable event cannot tear down the stream', () => {
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request: createRequest(), response, frameRuntime });

  let circular = { type: 'frame.added', sessionID: 's1' };
  circular.self = circular;
  // A throwing payload used to leave a half-written SSE frame behind, which the
  // browser treats as a fatal protocol error rather than a reconnectable drop.
  frameRuntime.emit('event', circular);

  assert.equal(response.body.endsWith(frame('frame.added', { type: 'frame.added', error: 'unserializable runtime event' })), true);

  frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frameID: 'f9' });
  assert.equal(response.body.includes('"f9"'), true);
});

test('a stalled client is destroyed once its SSE buffer exceeds the cap', () => {
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request: createRequest(), response, frameRuntime, maxBufferedBytes: 256 });

  for (let index = 0; index < 50; index++)
    frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frameID: 'f1', text: 'x'.repeat(64) });

  assert.equal(response.destroyed, true, 'a response that cannot drain must be destroyed');
  assert.ok(response.writableLength <= 256 + 512, `SSE buffer grew unbounded: ${response.writableLength}`);

  // No further writes once destroyed: the payload must not keep accumulating.
  let writesAtDestroy = response.chunks.length;
  frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frameID: 'f2' });
  assert.equal(response.chunks.length, writesAtDestroy);
});

test('a draining client is never destroyed by the buffer cap', () => {
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  let write = response.write.bind(response);
  response.write = (chunk) => {
    let result = write(chunk);
    // Simulate the socket flushing between events.
    response.writableLength = 0;
    return result;
  };

  streamRuntimeEvents({ request: createRequest(), response, frameRuntime, maxBufferedBytes: 128 });

  for (let index = 0; index < 50; index++)
    frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frameID: `f${index}`, text: 'x'.repeat(64) });

  assert.equal(response.destroyed, false);
  assert.equal(response.chunks.length > 50, true);
});

test('a destroyed response is not written to', () => {
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request: createRequest(), response, frameRuntime });

  response.destroyed = true;
  let length = response.body.length;
  assert.doesNotThrow(() => frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1' }));
  assert.equal(response.body.length, length);
});

test('streamRuntimeEvents rejects a frame runtime without event support', () => {
  assert.throws(() => streamRuntimeEvents({ request: createRequest(), response: createResponse(), frameRuntime: {} }), (error) => {
    assert.equal(error.status, 500);
    return true;
  });
});
