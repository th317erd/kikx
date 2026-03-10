'use strict';

import { EventEmitter } from 'node:events';

export class Transport extends EventEmitter {
  constructor(options = {}) {
    super();
    this._connected = false;
    this._options = options;
  }

  // Send a message/frame to a specific client/connection
  async send(connectionID, data) {
    throw new Error('Transport.send() not implemented');
  }

  // Broadcast a message/frame to all connections
  async broadcast(data) {
    throw new Error('Transport.broadcast() not implemented');
  }

  // Register a message handler
  onMessage(handler) {
    this.on('message', handler);
    return () => this.off('message', handler);
  }

  // Create a streaming connection (for SSE-like transports)
  createStream(connectionID, options) {
    throw new Error('Transport.createStream() not implemented');
  }

  // Connect / start the transport
  async connect() {
    this._connected = true;
    this.emit('connected');
  }

  // Disconnect / stop the transport
  async disconnect() {
    this._connected = false;
    this.emit('disconnected');
  }

  isConnected() {
    return this._connected;
  }

  getOptions() {
    return this._options;
  }
}
