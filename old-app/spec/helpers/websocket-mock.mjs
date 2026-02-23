'use strict';

/**
 * WebSocket Mock using Event Bus
 *
 * Provides a mock WebSocket that uses an event bus pattern for testing
 * real-time features without actual network connections.
 *
 * Usage:
 *   import { MockWebSocket, createEventBus } from './websocket-mock.mjs';
 *
 *   const bus = createEventBus();
 *   const ws = new MockWebSocket(bus);
 *
 *   ws.onmessage = (event) => console.log(event.data);
 *   bus.emit('message', { type: 'frame_update', ... });
 */

import { EventEmitter } from 'events';

/**
 * Create an event bus for mock communication.
 * @returns {EventEmitter}
 */
export function createEventBus() {
  return new EventEmitter();
}

/**
 * Mock WebSocket that uses an event bus instead of network.
 */
export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(eventBus, url = 'ws://localhost/mock') {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.eventBus = eventBus;

    // Event handlers (set by consumer)
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;

    // Internal message queue
    this._messageQueue = [];
    this._sentMessages = [];

    // Auto-connect after a tick (like real WebSocket)
    setTimeout(() => this._connect(), 0);

    // Listen for server-side messages via event bus
    this.eventBus.on('server:message', (data) => {
      if (this.readyState === MockWebSocket.OPEN) {
        this._receiveMessage(data);
      }
    });

    this.eventBus.on('server:close', (code, reason) => {
      this._handleClose(code, reason);
    });

    this.eventBus.on('server:error', (error) => {
      this._handleError(error);
    });
  }

  _connect() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) {
      this.onopen({ type: 'open', target: this });
    }
    this.eventBus.emit('client:open', this);

    // Process any queued messages
    while (this._messageQueue.length > 0) {
      const msg = this._messageQueue.shift();
      this._doSend(msg);
    }
  }

  _receiveMessage(data) {
    const messageData = typeof data === 'string' ? data : JSON.stringify(data);
    if (this.onmessage) {
      this.onmessage({
        type: 'message',
        data: messageData,
        target: this,
      });
    }
  }

  _handleClose(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({
        type: 'close',
        code,
        reason,
        wasClean: code === 1000,
        target: this,
      });
    }
  }

  _handleError(error) {
    if (this.onerror) {
      this.onerror({
        type: 'error',
        error,
        target: this,
      });
    }
  }

  /**
   * Send a message through the WebSocket.
   * @param {string|object} data - Message to send
   */
  send(data) {
    if (this.readyState === MockWebSocket.CONNECTING) {
      this._messageQueue.push(data);
      return;
    }

    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }

    this._doSend(data);
  }

  _doSend(data) {
    const messageData = typeof data === 'string' ? data : JSON.stringify(data);
    this._sentMessages.push(messageData);
    this.eventBus.emit('client:message', JSON.parse(messageData));
  }

  /**
   * Close the WebSocket connection.
   * @param {number} code - Close code
   * @param {string} reason - Close reason
   */
  close(code = 1000, reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) return;

    this.readyState = MockWebSocket.CLOSING;
    this.eventBus.emit('client:close', { code, reason });

    // Simulate async close
    setTimeout(() => {
      this._handleClose(code, reason);
    }, 0);
  }

  /**
   * Get all messages sent by the client.
   * Useful for assertions in tests.
   * @returns {string[]}
   */
  getSentMessages() {
    return [...this._sentMessages];
  }

  /**
   * Clear sent messages history.
   */
  clearSentMessages() {
    this._sentMessages = [];
  }
}

/**
 * Create a mock WebSocket server for testing.
 * Listens on the event bus and can send messages to clients.
 */
export class MockWebSocketServer {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.clients = [];
    this._receivedMessages = [];

    this.eventBus.on('client:open', (client) => {
      this.clients.push(client);
    });

    this.eventBus.on('client:message', (data) => {
      this._receivedMessages.push(data);
    });

    this.eventBus.on('client:close', () => {
      // Client closed, could clean up
    });
  }

  /**
   * Send a message to all connected clients.
   * @param {object} data - Message data
   */
  broadcast(data) {
    this.eventBus.emit('server:message', data);
  }

  /**
   * Send a specific frame update (common pattern).
   * @param {string} sessionId
   * @param {string} targetFrameId
   * @param {object} payload
   */
  sendFrameUpdate(sessionId, targetFrameId, payload) {
    this.broadcast({
      type: 'frame_update',
      sessionId,
      targetFrameId,
      payload,
    });
  }

  /**
   * Send a new frame event.
   * @param {object} frame
   */
  sendNewFrame(frame) {
    this.broadcast({
      type: 'new_frame',
      frame,
    });
  }

  /**
   * Close all client connections.
   * @param {number} code
   * @param {string} reason
   */
  closeAll(code = 1000, reason = '') {
    this.eventBus.emit('server:close', code, reason);
    this.clients = [];
  }

  /**
   * Simulate a server error.
   * @param {Error} error
   */
  triggerError(error) {
    this.eventBus.emit('server:error', error);
  }

  /**
   * Get all messages received from clients.
   * @returns {object[]}
   */
  getReceivedMessages() {
    return [...this._receivedMessages];
  }

  /**
   * Clear received messages history.
   */
  clearReceivedMessages() {
    this._receivedMessages = [];
  }
}

/**
 * Helper to set up WebSocket mocking for tests.
 * Returns both client and server mocks.
 *
 * @returns {{ bus: EventEmitter, client: MockWebSocket, server: MockWebSocketServer }}
 */
export function setupWebSocketMock() {
  const bus = createEventBus();
  const server = new MockWebSocketServer(bus);
  const client = new MockWebSocket(bus);
  return { bus, client, server };
}

export default {
  createEventBus,
  MockWebSocket,
  MockWebSocketServer,
  setupWebSocketMock,
};
