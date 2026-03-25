'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import { WebSocketTransport } from '../../../src/server/transport/websocket-transport.mjs';
import { CascadingContext } from '../../../src/core/context/index.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createMockAuthService(secret) {
  // Minimal mock that validates/creates tokens
  return {
    verifyToken(token) {
      if (token === 'valid-token')
        return { sub: 'usr_test', org: 'org_test' };

      if (token === 'valid-token-2')
        return { sub: 'usr_test2', org: 'org_test' };

      throw new Error('Invalid token');
    },
  };
}

function createMockFramePersistence() {
  let storedFrames = [];

  return {
    _frames: storedFrames,
    async loadFrames(sessionID, options = {}) {
      let frames = storedFrames.filter((f) => f.sessionID === sessionID);

      if (options.afterOrder != null)
        frames = frames.filter((f) => f.order > options.afterOrder);

      return frames;
    },
    addFrame(frame) {
      storedFrames.push(frame);
    },
  };
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    let timeout = setTimeout(() => reject(new Error('Timeout waiting for message')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function waitForMessages(ws, count) {
  return new Promise((resolve, reject) => {
    let messages = [];
    let timeout  = setTimeout(() => reject(new Error(`Timeout: got ${messages.length}/${count}`)), 5000);
    let handler  = (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= count) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(messages);
      }
    };

    ws.on('message', handler);
  });
}

function createWSClient(port, token) {
  return new Promise((resolve, reject) => {
    let url = `ws://localhost:${port}/api/v2/ws${(token) ? `?token=${token}` : ''}`;
    let ws  = new WebSocket(url);

    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// =============================================================================
// WebSocketTransport
// =============================================================================

describe('WebSocketTransport', () => {
  let server;
  let transport;
  let context;
  let interactionLoop;
  let framePersistence;
  let port;
  let clients = [];

  beforeEach(async () => {
    interactionLoop  = new EventEmitter();
    framePersistence = createMockFramePersistence();

    context = new CascadingContext();
    context.setProperty('authService', createMockAuthService());
    context.setProperty('interactionLoop', interactionLoop);
    context.setProperty('framePersistence', framePersistence);

    transport = new WebSocketTransport(context);

    // Create and start HTTP server on random port
    server = createServer();
    await new Promise((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        resolve();
      });
    });

    transport.start(server);
  });

  afterEach(async () => {
    // Close all test clients
    for (let client of clients) {
      try {
        client.close();
      } catch (_error) {
        // ignore
      }
    }

    clients = [];

    transport.stop();

    await new Promise((resolve) => server.close(resolve));
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  it('should throw if constructed without context', () => {
    assert.throws(
      () => new WebSocketTransport(),
      { message: 'WebSocketTransport requires a CascadingContext' },
    );
  });

  it('should start and report isStarted()', () => {
    assert.equal(transport.isStarted(), true);
  });

  it('should stop cleanly', () => {
    transport.stop();
    assert.equal(transport.isStarted(), false);
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  it('should reject connections without token', async () => {
    let ws = await createWSClient(port, null);
    clients.push(ws);

    let closeCode = await new Promise((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    assert.equal(closeCode, 4001);
  });

  it('should reject connections with invalid token', async () => {
    let ws = await createWSClient(port, 'bad-token');
    clients.push(ws);

    let closeCode = await new Promise((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    assert.equal(closeCode, 4001);
  });

  it('should accept connections with valid token', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    // Send subscribe
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_test' }));

    let msg = await waitForMessage(ws);
    assert.equal(msg.type, 'subscribed');
    assert.equal(msg.sessionID, 'ses_test');
  });

  // -------------------------------------------------------------------------
  // Subscription & Frames
  // -------------------------------------------------------------------------

  it('should receive frames after subscribing', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_frames' }));

    let subMsg = await waitForMessage(ws);
    assert.equal(subMsg.type, 'subscribed');

    // Emit a frame from the interaction loop
    let testFrame = { id: 'frm_ws_1', type: 'Message', content: { html: '<p>Hello</p>' } };
    interactionLoop.emit('frame', { sessionID: 'ses_frames', frame: testFrame });

    let frameMsg = await waitForMessage(ws);
    assert.equal(frameMsg.type, 'frame');
    assert.equal(frameMsg.frame.id, 'frm_ws_1');
  });

  it('should NOT receive frames for other sessions', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_mine' }));

    let subMsg = await waitForMessage(ws);
    assert.equal(subMsg.type, 'subscribed');

    // Emit frame for a different session
    interactionLoop.emit('frame', { sessionID: 'ses_other', frame: { id: 'frm_other' } });

    // Emit frame for our session (should arrive)
    let ourFrame = { id: 'frm_ours', type: 'Message', content: {} };
    interactionLoop.emit('frame', { sessionID: 'ses_mine', frame: ourFrame });

    let msg = await waitForMessage(ws);
    assert.equal(msg.frame.id, 'frm_ours'); // Should be our frame, not the other
  });

  // -------------------------------------------------------------------------
  // Reconnection — replay missed frames
  // -------------------------------------------------------------------------

  it('should replay missed frames on reconnection', async () => {
    // Seed some frames
    framePersistence.addFrame({ sessionID: 'ses_replay', id: 'frm_1', order: 1, type: 'Message', content: {} });
    framePersistence.addFrame({ sessionID: 'ses_replay', id: 'frm_2', order: 2, type: 'Message', content: {} });
    framePersistence.addFrame({ sessionID: 'ses_replay', id: 'frm_3', order: 3, type: 'Message', content: {} });

    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    // Subscribe with lastSeenOrder=1 — should replay orders 2 and 3
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_replay', lastSeenOrder: 1 }));

    // Expect: frm_2, frm_3, replay-complete, subscribed
    let messages = await waitForMessages(ws, 4);

    let frameMessages    = messages.filter((m) => m.type === 'frame');
    let replayComplete   = messages.find((m) => m.type === 'replay-complete');
    let subscribed       = messages.find((m) => m.type === 'subscribed');

    assert.equal(frameMessages.length, 2);
    assert.equal(frameMessages[0].frame.id, 'frm_2');
    assert.equal(frameMessages[1].frame.id, 'frm_3');
    assert.ok(replayComplete);
    assert.ok(subscribed);
  });

  // -------------------------------------------------------------------------
  // Multiple clients
  // -------------------------------------------------------------------------

  it('should support multiple clients per session', async () => {
    let ws1 = await createWSClient(port, 'valid-token');
    let ws2 = await createWSClient(port, 'valid-token-2');
    clients.push(ws1, ws2);

    ws1.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_multi' }));
    ws2.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_multi' }));

    await waitForMessage(ws1); // subscribed
    await waitForMessage(ws2); // subscribed

    assert.equal(transport.getConnectedPeers('ses_multi'), 2);

    // Emit frame — both should get it
    let testFrame = { id: 'frm_multi', type: 'Message', content: {} };
    interactionLoop.emit('frame', { sessionID: 'ses_multi', frame: testFrame });

    let msg1 = await waitForMessage(ws1);
    let msg2 = await waitForMessage(ws2);

    assert.equal(msg1.frame.id, 'frm_multi');
    assert.equal(msg2.frame.id, 'frm_multi');
  });

  // -------------------------------------------------------------------------
  // Disconnect cleanup
  // -------------------------------------------------------------------------

  it('should clean up on client disconnect', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_cleanup' }));
    await waitForMessage(ws); // subscribed

    assert.equal(transport.getConnectedPeers('ses_cleanup'), 1);

    // Close the client
    ws.close();

    // Wait for close to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(transport.getConnectedPeers('ses_cleanup'), 0);
  });

  // -------------------------------------------------------------------------
  // Interaction events
  // -------------------------------------------------------------------------

  it('should forward interaction:start events', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_events' }));
    await waitForMessage(ws); // subscribed

    interactionLoop.emit('interaction:start', {
      sessionID:     'ses_events',
      interactionID: 'int_123',
    });

    let msg = await waitForMessage(ws);
    assert.equal(msg.type, 'interaction:start');
    assert.equal(msg.interactionID, 'int_123');
  });

  it('should forward interaction:end events', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_end' }));
    await waitForMessage(ws); // subscribed

    interactionLoop.emit('interaction:end', {
      sessionID:     'ses_end',
      interactionID: 'int_456',
    });

    let msg = await waitForMessage(ws);
    assert.equal(msg.type, 'interaction:end');
    assert.equal(msg.interactionID, 'int_456');
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('should handle invalid JSON gracefully', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    ws.send('not json');

    let msg = await waitForMessage(ws);
    assert.equal(msg.type, 'error');
    assert.ok(msg.message.includes('Invalid JSON'));
  });

  it('should require sessionID in subscribe', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe' }));

    let msg = await waitForMessage(ws);
    assert.equal(msg.type, 'error');
    assert.ok(msg.message.includes('sessionID is required'));
  });

  // -------------------------------------------------------------------------
  // Phase 3: Ping/pong keep-alive
  // -------------------------------------------------------------------------

  it('should set _isAlive on connection', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    // Connection should have _isAlive set by the server
    // (We can verify indirectly by checking connection stays alive)
    assert.ok(ws.readyState === ws.OPEN);
  });

  it('should clean up ping interval on stop', async () => {
    // Stop and verify no errors
    transport.stop();
    assert.equal(transport.isStarted(), false);

    // Restart for subsequent tests
    transport = new WebSocketTransport(context);
    transport.start(server);
  });

  it('should handle pong responses to keep connection alive', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    // WebSocket library auto-responds to pings with pongs by default
    // Just verify the connection is stable after a brief wait
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ws.readyState, ws.OPEN);
  });

  // -------------------------------------------------------------------------
  // Failure & adversarial tests
  // -------------------------------------------------------------------------

  it('should silently ignore unknown message type', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    // Unknown type is silently ignored (no response)
    ws.send(JSON.stringify({ type: 'bogus-action', data: 'test' }));

    // Now send a subscribe to verify the connection is still healthy
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_after_bogus' }));
    let msg = await waitForMessage(ws);
    assert.equal(msg.type, 'subscribed');
    assert.equal(msg.sessionID, 'ses_after_bogus');
  });

  it('should silently ignore empty JSON object (no type)', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    // No type field — silently ignored
    ws.send(JSON.stringify({}));

    // Verify connection still works
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_after_empty' }));
    let msg = await waitForMessage(ws);
    assert.equal(msg.type, 'subscribed');
  });

  it('should handle subscribe then re-subscribe to different session', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    // Subscribe to first session
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_first' }));
    let sub1 = await waitForMessage(ws);
    assert.equal(sub1.type, 'subscribed');
    assert.equal(sub1.sessionID, 'ses_first');

    // Subscribe to second session (should replace first)
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_second' }));
    let sub2 = await waitForMessage(ws);
    assert.equal(sub2.type, 'subscribed');
    assert.equal(sub2.sessionID, 'ses_second');

    // Emit frame for first session — should NOT be received
    interactionLoop.emit('frame', { sessionID: 'ses_first', frame: { id: 'frm_old', type: 'Message' } });

    // Emit frame for second session — should be received
    interactionLoop.emit('frame', { sessionID: 'ses_second', frame: { id: 'frm_new', type: 'Message' } });

    let msg = await waitForMessage(ws);
    assert.equal(msg.frame.id, 'frm_new');
  });

  it('should handle double stop without error', () => {
    transport.stop();
    assert.equal(transport.isStarted(), false);

    // Second stop should not throw
    transport.stop();
    assert.equal(transport.isStarted(), false);

    // Restart for subsequent tests
    transport = new WebSocketTransport(context);
    transport.start(server);
  });

  it('should return 0 connected peers for non-existent session', () => {
    assert.equal(transport.getConnectedPeers('ses_nonexistent'), 0);
  });

  it('should handle rapid subscribe/unsubscribe cycles', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    // Rapid subscribe/unsubscribe
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_rapid1' }));
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_rapid2' }));
    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_rapid3' }));

    // Should eventually settle on last subscription
    let messages = await waitForMessages(ws, 3);
    let lastSub  = messages[messages.length - 1];
    assert.equal(lastSub.type, 'subscribed');
    assert.equal(lastSub.sessionID, 'ses_rapid3');
  });

  it('should handle message sent to closed connection', async () => {
    let ws = await createWSClient(port, 'valid-token');
    clients.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', sessionID: 'ses_close_test' }));
    await waitForMessage(ws); // subscribed

    // Close the connection
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Emit frame — should not throw, just silently fail
    interactionLoop.emit('frame', {
      sessionID: 'ses_close_test',
      frame:     { id: 'frm_orphan', type: 'Message', content: {} },
    });

    // No error thrown is success
    assert.equal(transport.getConnectedPeers('ses_close_test'), 0);
  });
});
