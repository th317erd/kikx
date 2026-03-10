'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  Transport,
  EventTransport,
  SSETransport,
} from '../../src/core/transport/index.mjs';

// =============================================================================
// Transport (base class)
// =============================================================================
describe('Transport', () => {
  let transport;

  beforeEach(() => {
    transport = new Transport();
  });

  afterEach(async () => {
    if (transport && transport.isConnected())
      await transport.disconnect();

    transport = null;
  });

  it('should construct with default options', () => {
    assert.equal(transport.isConnected(), false);
    assert.deepStrictEqual(transport.getOptions(), {});
  });

  it('should store custom options', () => {
    let custom = new Transport({ port: 3000, host: 'localhost' });
    assert.deepStrictEqual(custom.getOptions(), { port: 3000, host: 'localhost' });
  });

  it('should report isConnected as false by default', () => {
    assert.equal(transport.isConnected(), false);
  });

  it('should transition to connected on connect()', async () => {
    await transport.connect();
    assert.equal(transport.isConnected(), true);
  });

  it('should emit "connected" event on connect()', async () => {
    let emitted = false;
    transport.on('connected', () => { emitted = true; });
    await transport.connect();
    assert.equal(emitted, true);
  });

  it('should transition to disconnected on disconnect()', async () => {
    await transport.connect();
    assert.equal(transport.isConnected(), true);
    await transport.disconnect();
    assert.equal(transport.isConnected(), false);
  });

  it('should emit "disconnected" event on disconnect()', async () => {
    let emitted = false;
    transport.on('disconnected', () => { emitted = true; });
    await transport.connect();
    await transport.disconnect();
    assert.equal(emitted, true);
  });

  it('should register a message handler via onMessage and return unsubscribe', () => {
    let received = [];
    let unsubscribe = transport.onMessage((data) => { received.push(data); });

    assert.equal(typeof unsubscribe, 'function');

    transport.emit('message', { test: 'hello' });
    assert.equal(received.length, 1);
    assert.deepStrictEqual(received[0], { test: 'hello' });

    unsubscribe();

    transport.emit('message', { test: 'world' });
    assert.equal(received.length, 1); // no new message after unsubscribe
  });

  it('should throw "not implemented" on send()', async () => {
    await assert.rejects(
      () => transport.send('conn-1', { hello: 'world' }),
      { message: 'Transport.send() not implemented' },
    );
  });

  it('should throw "not implemented" on broadcast()', async () => {
    await assert.rejects(
      () => transport.broadcast({ hello: 'world' }),
      { message: 'Transport.broadcast() not implemented' },
    );
  });

  it('should throw "not implemented" on createStream()', () => {
    assert.throws(
      () => transport.createStream('conn-1'),
      { message: 'Transport.createStream() not implemented' },
    );
  });
});

// =============================================================================
// EventTransport
// =============================================================================
describe('EventTransport', () => {
  let transport;

  beforeEach(async () => {
    transport = new EventTransport();
    await transport.connect();
  });

  afterEach(async () => {
    if (transport && transport.isConnected())
      await transport.disconnect();

    transport = null;
  });

  it('should be an instance of Transport', () => {
    assert.ok(transport instanceof Transport);
  });

  it('should start with zero streams', () => {
    assert.equal(transport.getStreamCount(), 0);
  });

  it('should create a stream with the correct id', () => {
    let stream = transport.createStream('stream-1');
    assert.equal(stream.id, 'stream-1');
    assert.equal(transport.getStreamCount(), 1);
  });

  it('should send data to a stream and deliver to listener', async () => {
    let stream = transport.createStream('stream-1');
    let received = [];
    stream.onData((data) => { received.push(data); });

    await transport.send('stream-1', { type: 'text', body: 'hello' });

    assert.equal(received.length, 1);
    assert.deepStrictEqual(received[0], { type: 'text', body: 'hello' });
  });

  it('should accumulate messages in stream history', async () => {
    let stream = transport.createStream('stream-1');

    await transport.send('stream-1', 'first');
    await transport.send('stream-1', 'second');
    await transport.send('stream-1', 'third');

    let messages = stream.getMessages();
    assert.deepStrictEqual(messages, ['first', 'second', 'third']);
  });

  it('should return a copy of messages from getMessages()', async () => {
    let stream = transport.createStream('stream-1');

    await transport.send('stream-1', 'one');
    let messages = stream.getMessages();
    messages.push('tampered');

    assert.deepStrictEqual(stream.getMessages(), ['one']);
  });

  it('should emit "message:sent" event when sending', async () => {
    transport.createStream('stream-1');
    let emitted = null;
    transport.on('message:sent', (event) => { emitted = event; });

    await transport.send('stream-1', 'hello');

    assert.ok(emitted);
    assert.equal(emitted.connectionID, 'stream-1');
    assert.equal(emitted.data, 'hello');
  });

  it('should broadcast data to all streams', async () => {
    let stream1 = transport.createStream('stream-1');
    let stream2 = transport.createStream('stream-2');
    let stream3 = transport.createStream('stream-3');

    let received1 = [];
    let received2 = [];
    let received3 = [];

    stream1.onData((data) => { received1.push(data); });
    stream2.onData((data) => { received2.push(data); });
    stream3.onData((data) => { received3.push(data); });

    await transport.broadcast({ event: 'ping' });

    assert.deepStrictEqual(received1, [{ event: 'ping' }]);
    assert.deepStrictEqual(received2, [{ event: 'ping' }]);
    assert.deepStrictEqual(received3, [{ event: 'ping' }]);
  });

  it('should emit "broadcast" event when broadcasting', async () => {
    transport.createStream('stream-1');
    let emitted = null;
    transport.on('broadcast', (event) => { emitted = event; });

    await transport.broadcast('hello');

    assert.ok(emitted);
    assert.deepStrictEqual(emitted.data, 'hello');
  });

  it('should simulate receiving a message via simulateMessage', () => {
    let received = [];
    transport.onMessage((event) => { received.push(event); });

    transport.simulateMessage('client-1', { action: 'join' });

    assert.equal(received.length, 1);
    assert.equal(received[0].connectionID, 'client-1');
    assert.deepStrictEqual(received[0].data, { action: 'join' });
  });

  it('should not throw when sending to a nonexistent stream', async () => {
    // Should be silent - no error
    await transport.send('nonexistent', { data: 'test' });
  });

  it('should still emit "message:sent" when sending to nonexistent stream', async () => {
    let emitted = null;
    transport.on('message:sent', (event) => { emitted = event; });

    await transport.send('nonexistent', 'test');

    assert.ok(emitted);
    assert.equal(emitted.connectionID, 'nonexistent');
  });

  it('should clear all streams on disconnect', async () => {
    transport.createStream('stream-1');
    transport.createStream('stream-2');
    assert.equal(transport.getStreamCount(), 2);

    await transport.disconnect();
    assert.equal(transport.getStreamCount(), 0);
    assert.equal(transport.isConnected(), false);
  });

  it('should stop delivering to listeners after stream.close()', async () => {
    let stream = transport.createStream('stream-1');
    let received = [];
    stream.onData((data) => { received.push(data); });

    await transport.send('stream-1', 'before-close');
    stream.close();
    await transport.send('stream-1', 'after-close');

    // Listener should only have the first message
    assert.deepStrictEqual(received, ['before-close']);
  });

  it('should keep message history after stream.close()', async () => {
    let stream = transport.createStream('stream-1');

    await transport.send('stream-1', 'before-close');
    stream.close();
    await transport.send('stream-1', 'after-close');

    // Messages are still recorded in stream history even after close
    assert.deepStrictEqual(stream.getMessages(), ['before-close', 'after-close']);
  });

  it('should support multiple listeners on a single stream', async () => {
    let stream = transport.createStream('stream-1');
    let received1 = [];
    let received2 = [];

    stream.onData((data) => { received1.push(data); });
    stream.onData((data) => { received2.push(data); });

    await transport.send('stream-1', 'multi');

    assert.deepStrictEqual(received1, ['multi']);
    assert.deepStrictEqual(received2, ['multi']);
  });
});

// =============================================================================
// SSETransport
// =============================================================================
describe('SSETransport', () => {
  let transport;

  function createMockWriter() {
    let written = [];
    let closed = false;
    return {
      write(data)         { written.push(data); },
      close()             { closed = true; },
      setHeaders(headers) { /* noop */ },
      getWritten()        { return written; },
      isClosed()          { return closed; },
    };
  }

  beforeEach(async () => {
    transport = new SSETransport();
    await transport.connect();
  });

  afterEach(async () => {
    if (transport && transport.isConnected())
      await transport.disconnect();

    transport = null;
  });

  it('should be an instance of Transport', () => {
    assert.ok(transport instanceof Transport);
  });

  it('should start with zero connections', () => {
    assert.equal(transport.getConnectionCount(), 0);
  });

  it('should register a connection and emit "connection" event', () => {
    let writer = createMockWriter();
    let emitted = null;
    transport.on('connection', (event) => { emitted = event; });

    let unregister = transport.registerConnection('conn-1', writer);

    assert.equal(transport.getConnectionCount(), 1);
    assert.ok(emitted);
    assert.equal(emitted.connectionID, 'conn-1');
    assert.equal(typeof unregister, 'function');
  });

  it('should remove a connection and emit "disconnection" event', () => {
    let writer = createMockWriter();
    let emitted = null;
    transport.on('disconnection', (event) => { emitted = event; });

    transport.registerConnection('conn-1', writer);
    transport.removeConnection('conn-1');

    assert.equal(transport.getConnectionCount(), 0);
    assert.ok(emitted);
    assert.equal(emitted.connectionID, 'conn-1');
    assert.equal(writer.isClosed(), true);
  });

  it('should remove connection via returned unregister function', () => {
    let writer = createMockWriter();
    let unregister = transport.registerConnection('conn-1', writer);

    assert.equal(transport.getConnectionCount(), 1);
    unregister();
    assert.equal(transport.getConnectionCount(), 0);
    assert.equal(writer.isClosed(), true);
  });

  it('should be silent when removing a nonexistent connection', () => {
    // Should not throw
    transport.removeConnection('nonexistent');
    assert.equal(transport.getConnectionCount(), 0);
  });

  it('should format data as SSE and write to connection', async () => {
    let writer = createMockWriter();
    transport.registerConnection('conn-1', writer);

    await transport.send('conn-1', { type: 'message', body: 'hello' });

    let written = writer.getWritten();
    assert.equal(written.length, 1);
    assert.equal(written[0], 'data: {"type":"message","body":"hello"}\n\n');
  });

  it('should format string data as SSE', async () => {
    let writer = createMockWriter();
    transport.registerConnection('conn-1', writer);

    await transport.send('conn-1', 'simple string');

    let written = writer.getWritten();
    assert.equal(written.length, 1);
    assert.equal(written[0], 'data: simple string\n\n');
  });

  it('should handle multi-line data in SSE format', async () => {
    let writer = createMockWriter();
    transport.registerConnection('conn-1', writer);

    await transport.send('conn-1', 'line one\nline two\nline three');

    let written = writer.getWritten();
    assert.equal(written.length, 1);
    assert.equal(written[0], 'data: line one\ndata: line two\ndata: line three\n\n');
  });

  it('should emit "message:sent" event when sending', async () => {
    let writer = createMockWriter();
    transport.registerConnection('conn-1', writer);

    let emitted = null;
    transport.on('message:sent', (event) => { emitted = event; });

    await transport.send('conn-1', 'test');

    assert.ok(emitted);
    assert.equal(emitted.connectionID, 'conn-1');
    assert.equal(emitted.data, 'test');
  });

  it('should be silent when sending to a nonexistent connection', async () => {
    // Should not throw
    await transport.send('nonexistent', 'test');
  });

  it('should broadcast to all connections', async () => {
    let writer1 = createMockWriter();
    let writer2 = createMockWriter();
    let writer3 = createMockWriter();

    transport.registerConnection('conn-1', writer1);
    transport.registerConnection('conn-2', writer2);
    transport.registerConnection('conn-3', writer3);

    await transport.broadcast({ event: 'update' });

    let expected = 'data: {"event":"update"}\n\n';
    assert.deepStrictEqual(writer1.getWritten(), [expected]);
    assert.deepStrictEqual(writer2.getWritten(), [expected]);
    assert.deepStrictEqual(writer3.getWritten(), [expected]);
  });

  it('should remove failed connections during broadcast', async () => {
    let writer1 = createMockWriter();
    let failingWriter = {
      write() { throw new Error('connection reset'); },
      close() {},
      setHeaders() {},
    };

    transport.registerConnection('conn-1', writer1);
    transport.registerConnection('conn-failing', failingWriter);

    await transport.broadcast('test');

    // The good connection should have received the data
    assert.deepStrictEqual(writer1.getWritten(), ['data: test\n\n']);
    // The failing connection should be removed
    assert.equal(transport.getConnectionCount(), 1);
  });

  it('should create a stream handle with send and close', async () => {
    let writer = createMockWriter();
    transport.registerConnection('conn-1', writer);

    let stream = transport.createStream('conn-1');

    assert.equal(stream.id, 'conn-1');
    assert.equal(typeof stream.send, 'function');
    assert.equal(typeof stream.close, 'function');
  });

  it('should send data through stream handle', async () => {
    let writer = createMockWriter();
    transport.registerConnection('conn-1', writer);

    let stream = transport.createStream('conn-1');
    await stream.send({ message: 'through stream' });

    let written = writer.getWritten();
    assert.equal(written.length, 1);
    assert.equal(written[0], 'data: {"message":"through stream"}\n\n');
  });

  it('should close connection through stream handle', () => {
    let writer = createMockWriter();
    transport.registerConnection('conn-1', writer);

    let stream = transport.createStream('conn-1');
    stream.close();

    assert.equal(transport.getConnectionCount(), 0);
    assert.equal(writer.isClosed(), true);
  });

  it('should close all connections on disconnect', async () => {
    let writer1 = createMockWriter();
    let writer2 = createMockWriter();

    transport.registerConnection('conn-1', writer1);
    transport.registerConnection('conn-2', writer2);

    assert.equal(transport.getConnectionCount(), 2);

    await transport.disconnect();

    assert.equal(transport.getConnectionCount(), 0);
    assert.equal(transport.isConnected(), false);
    assert.equal(writer1.isClosed(), true);
    assert.equal(writer2.isClosed(), true);
  });

  it('should produce correct SSE format via _formatSSE', () => {
    // String input
    let result = transport._formatSSE('hello world');
    assert.equal(result, 'data: hello world\n\n');

    // Object input (JSON serialized)
    result = transport._formatSSE({ key: 'value' });
    assert.equal(result, 'data: {"key":"value"}\n\n');

    // Multi-line string
    result = transport._formatSSE('line1\nline2');
    assert.equal(result, 'data: line1\ndata: line2\n\n');
  });

  it('should handle writer.close() throwing during removeConnection', () => {
    let writer = {
      write() {},
      close() { throw new Error('close failed'); },
      setHeaders() {},
    };

    transport.registerConnection('conn-1', writer);

    // Should not throw despite close() throwing
    transport.removeConnection('conn-1');
    assert.equal(transport.getConnectionCount(), 0);
  });
});

// =============================================================================
// Failure Tests — Transport (base class)
// =============================================================================

describe('Transport — failure paths', () => {
  let transport;

  beforeEach(() => {
    transport = new Transport();
  });

  afterEach(async () => {
    if (transport && transport.isConnected())
      await transport.disconnect();

    transport = null;
  });

  it('should allow double connect without error', async () => {
    await transport.connect();
    assert.equal(transport.isConnected(), true);

    await transport.connect();
    assert.equal(transport.isConnected(), true);
  });

  it('should allow disconnect without connecting first', async () => {
    assert.equal(transport.isConnected(), false);
    await transport.disconnect();
    assert.equal(transport.isConnected(), false);
  });

  it('should allow reconnect after disconnect', async () => {
    await transport.connect();
    assert.equal(transport.isConnected(), true);

    await transport.disconnect();
    assert.equal(transport.isConnected(), false);

    await transport.connect();
    assert.equal(transport.isConnected(), true);
  });

  it('should emit events on reconnect cycle', async () => {
    let events = [];
    transport.on('connected', () => events.push('connected'));
    transport.on('disconnected', () => events.push('disconnected'));

    await transport.connect();
    await transport.disconnect();
    await transport.connect();

    assert.deepStrictEqual(events, ['connected', 'disconnected', 'connected']);
  });

  it('should handle unsubscribe called multiple times', () => {
    let handler     = () => {};
    let unsubscribe = transport.onMessage(handler);

    unsubscribe();
    // Second call should not throw
    unsubscribe();
  });
});

// =============================================================================
// Failure Tests — EventTransport
// =============================================================================

describe('EventTransport — failure paths', () => {
  let transport;

  beforeEach(async () => {
    transport = new EventTransport();
    await transport.connect();
  });

  afterEach(async () => {
    if (transport && transport.isConnected())
      await transport.disconnect();

    transport = null;
  });

  it('should overwrite stream when creating duplicate ID', () => {
    let stream1 = transport.createStream('dup-id');
    let stream2 = transport.createStream('dup-id');

    // Should not increase count — overwrites
    assert.equal(transport.getStreamCount(), 1);
    assert.equal(stream2.id, 'dup-id');
  });

  it('should handle send to stream after disconnect', async () => {
    transport.createStream('stream-1');
    await transport.disconnect();

    // Should not throw after disconnect
    await transport.send('stream-1', 'data');
  });

  it('should return zero stream count after disconnect', async () => {
    transport.createStream('a');
    transport.createStream('b');
    assert.equal(transport.getStreamCount(), 2);

    await transport.disconnect();
    assert.equal(transport.getStreamCount(), 0);
  });

  it('should handle broadcast with no streams', async () => {
    // No streams registered — should not throw
    await transport.broadcast({ event: 'lonely' });
  });

  it('should handle simulateMessage with null data', () => {
    let received = [];
    transport.onMessage((event) => received.push(event));

    transport.simulateMessage('client-1', null);

    assert.equal(received.length, 1);
    assert.equal(received[0].data, null);
  });
});

// =============================================================================
// Failure Tests — SSETransport
// =============================================================================

describe('SSETransport — failure paths', () => {
  let transport;

  function createMockWriter() {
    let written = [];
    let closed  = false;
    return {
      write(data)         { written.push(data); },
      close()             { closed = true; },
      setHeaders(headers) { /* noop */ },
      getWritten()        { return written; },
      isClosed()          { return closed; },
    };
  }

  beforeEach(async () => {
    transport = new SSETransport();
    await transport.connect();
  });

  afterEach(async () => {
    if (transport && transport.isConnected())
      await transport.disconnect();

    transport = null;
  });

  it('should overwrite existing connection on duplicate registerConnection', () => {
    let writer1 = createMockWriter();
    let writer2 = createMockWriter();

    transport.registerConnection('conn-1', writer1);
    transport.registerConnection('conn-1', writer2);

    assert.equal(transport.getConnectionCount(), 1);

    // Sending should go to writer2, not writer1
    transport.send('conn-1', 'test');
    assert.equal(writer2.getWritten().length, 1);
    assert.equal(writer1.getWritten().length, 0);
  });

  it('should handle removeConnection called twice for same ID', () => {
    let writer = createMockWriter();
    transport.registerConnection('conn-1', writer);

    transport.removeConnection('conn-1');
    assert.equal(transport.getConnectionCount(), 0);

    // Second removal should not throw
    transport.removeConnection('conn-1');
    assert.equal(transport.getConnectionCount(), 0);
  });

  it('should handle send when write throws', async () => {
    let failWriter = {
      write()       { throw new Error('write failed'); },
      close()       {},
      setHeaders()  {},
    };

    transport.registerConnection('conn-fail', failWriter);

    // send() should throw since it's not wrapped in try/catch
    // (unlike broadcast which removes failed connections)
    await assert.rejects(
      () => transport.send('conn-fail', 'data'),
      { message: 'write failed' },
    );
  });

  it('should handle broadcast where all writers fail', async () => {
    let failWriter1 = {
      write() { throw new Error('fail 1'); },
      close() {},
      setHeaders() {},
    };
    let failWriter2 = {
      write() { throw new Error('fail 2'); },
      close() {},
      setHeaders() {},
    };

    transport.registerConnection('conn-1', failWriter1);
    transport.registerConnection('conn-2', failWriter2);

    await transport.broadcast('test');

    // Both should be removed
    assert.equal(transport.getConnectionCount(), 0);
  });

  it('should format null as "null" in SSE', () => {
    let result = transport._formatSSE(null);
    assert.equal(result, 'data: null\n\n');
  });

  it('should throw on undefined input to _formatSSE', () => {
    // undefined is not a string and JSON.stringify(undefined) returns undefined (not a string)
    // so .split() fails — this documents the edge case
    assert.throws(
      () => transport._formatSSE(undefined),
      { name: 'TypeError' },
    );
  });

  it('should format empty string in SSE', () => {
    let result = transport._formatSSE('');
    assert.equal(result, 'data: \n\n');
  });

  it('should format empty object in SSE', () => {
    let result = transport._formatSSE({});
    assert.equal(result, 'data: {}\n\n');
  });

  it('should handle createStream for nonexistent connection', async () => {
    let stream = transport.createStream('ghost');

    assert.equal(stream.id, 'ghost');
    // send should silently no-op (no connection to write to)
    await stream.send('data');
  });

  it('should handle disconnect with no connections', async () => {
    assert.equal(transport.getConnectionCount(), 0);
    await transport.disconnect();
    assert.equal(transport.isConnected(), false);
  });

  it('should handle disconnect when close() throws on some connections', async () => {
    let goodWriter = createMockWriter();
    let badWriter  = {
      write()       {},
      close()       { throw new Error('close exploded'); },
      setHeaders()  {},
    };

    transport.registerConnection('good', goodWriter);
    transport.registerConnection('bad', badWriter);

    // disconnect should not throw
    await transport.disconnect();

    assert.equal(transport.getConnectionCount(), 0);
    assert.equal(goodWriter.isClosed(), true);
  });
});
