'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  DEFAULT_SSE_COALESCE_DELAY_MS,
  DEFAULT_SSE_COALESCE_LIMIT,
  streamRuntimeEvents,
} from '../../src/server/events.mjs';

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

function waitForSseFlush(delayMs = 5) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

test('coalesces repeated updates to the same streaming frame', async () => {
  let request = createRequest();
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request, response, frameRuntime, coalesce: true, coalesceDelayMs: 0 });

  frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frame: { id: 'f1', type: 'AgentMessage', content: { text: 'a' } } });
  frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frame: { id: 'f1', type: 'AgentMessage', content: { text: 'ab' } } });
  frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frame: { id: 'f1', type: 'AgentMessage', content: { text: 'abc' } } });
  frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frame: { id: 'f2', type: 'AgentMessage', content: { text: 'other' } } });

  await waitForSseFlush();
  assert.equal((response.body.match(/"id":"f1"/g) || []).length, 1);
  assert.equal((response.body.match(/"id":"f2"/g) || []).length, 1);
  assert.match(response.body, /"text":"abc"/);
  assert.equal(response.body.includes('"text":"ab"'), false);
  request.close();
});

test('coalescing does not merge distinct frame event types', async () => {
  let request = createRequest();
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request, response, frameRuntime, coalesce: true, coalesceDelayMs: 0 });

  frameRuntime.emit('event', { type: 'frame.phantom', sessionID: 's1', frame: { id: 'f1', type: 'BeginTyping', content: {} } });
  frameRuntime.emit('event', { type: 'frame.phantom', sessionID: 's1', frame: { id: 'f1', type: 'EndTyping', content: {} } });

  await waitForSseFlush();
  assert.equal(response.body.includes('"type":"BeginTyping"'), true);
  assert.equal(response.body.includes('"type":"EndTyping"'), true);
  request.close();
});

test('the server buffers frame updates for the interval before flushing', async () => {
  let request = createRequest();
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request, response, frameRuntime, coalesce: true, coalesceDelayMs: 20 });

  frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frame: { id: 'f1', type: 'AgentMessage', content: { text: 'old' } } });
  frameRuntime.emit('event', { type: 'frame.updated', sessionID: 's1', frame: { id: 'f1', type: 'AgentMessage', content: { text: 'new' } } });
  assert.equal(response.body.includes('"text":"new"'), false, 'frame updates must wait for the batch interval');

  await waitForSseFlush(30);
  assert.equal(response.body.includes('"text":"new"'), true);
  assert.equal(response.body.includes('"text":"old"'), false);
  request.close();
});

test('a full batch flushes immediately at the capacity limit', () => {
  let request = createRequest();
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request, response, frameRuntime, coalesce: true, coalesceDelayMs: 60000, coalesceLimit: 200 });

  for (let index = 0; index < 199; index++) {
    frameRuntime.emit('event', {
      type: 'frame.added',
      sessionID: 's1',
      frame: { id: `f${index}`, type: 'AgentMessage', content: { index } },
    });
  }
  assert.equal(response.body.includes('"index":198'), false, 'the batch must remain buffered below the capacity');

  frameRuntime.emit('event', {
    type: 'frame.added',
    sessionID: 's1',
    frame: { id: 'f199', type: 'AgentMessage', content: { index: 199 } },
  });
  assert.equal(response.body.includes('"index":198'), true, 'reaching capacity must flush the whole batch');
  assert.equal(response.body.includes('"index":199'), true);
  request.close();
});

test('a capacity flush leaves the next batch on its own interval', async () => {
  let request = createRequest();
  let response = createResponse();
  let frameRuntime = createFrameRuntime();
  streamRuntimeEvents({ request, response, frameRuntime, coalesce: true, coalesceDelayMs: 40, coalesceLimit: 2 });

  frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frame: { id: 'a', type: 'AgentMessage', content: { index: 1 } } });
  frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frame: { id: 'b', type: 'AgentMessage', content: { index: 2 } } });
  assert.equal(response.body.includes('"index":2'), true, 'capacity must flush immediately');

  frameRuntime.emit('event', { type: 'frame.added', sessionID: 's1', frame: { id: 'c', type: 'AgentMessage', content: { index: 3 } } });
  await waitForSseFlush(10);
  assert.equal(response.body.includes('"index":3'), false, 'the previous batch timer must not flush the next batch early');
  await waitForSseFlush(45);
  assert.equal(response.body.includes('"index":3'), true);
  request.close();
});

test('the production SSE batching defaults are one second and 200 merged entries', () => {
  assert.equal(DEFAULT_SSE_COALESCE_DELAY_MS, 1000);
  assert.equal(DEFAULT_SSE_COALESCE_LIMIT, 200);
});

test('streamRuntimeEvents rejects a frame runtime without event support', () => {
  assert.throws(() => streamRuntimeEvents({ request: createRequest(), response: createResponse(), frameRuntime: {} }), (error) => {
    assert.equal(error.status, 500);
    return true;
  });
});
