'use strict';

import { Transport } from './interface.mjs';

export class SSETransport extends Transport {
  constructor(options = {}) {
    super(options);
    this._connections = new Map(); // connectionId -> { write, close, lastEventId }
  }

  // Register an SSE connection (called by the server wrapper when a client connects)
  registerConnection(connectionId, writer) {
    // writer must have: write(data), close(), setHeaders(headers)
    this._connections.set(connectionId, {
      write:        writer.write.bind(writer),
      close:        writer.close.bind(writer),
      lastEventId:  null,
    });

    this.emit('connection', { connectionId });
    return () => this.removeConnection(connectionId);
  }

  removeConnection(connectionId) {
    let connection = this._connections.get(connectionId);
    if (!connection)
      return;

    try { connection.close(); } catch (e) { /* ignore */ }
    this._connections.delete(connectionId);
    this.emit('disconnection', { connectionId });
  }

  async send(connectionId, data) {
    let connection = this._connections.get(connectionId);
    if (!connection)
      return;

    let eventData = this._formatSSE(data);
    connection.write(eventData);
    this.emit('message:sent', { connectionId, data });
  }

  async broadcast(data) {
    let eventData = this._formatSSE(data);
    for (let [connectionId, connection] of this._connections) {
      try {
        connection.write(eventData);
      } catch (error) {
        this.removeConnection(connectionId);
      }
    }
  }

  createStream(connectionId, options = {}) {
    // For SSE, createStream returns a handle to push events
    return {
      id:     connectionId,
      send:   (data) => this.send(connectionId, data),
      close:  () => this.removeConnection(connectionId),
    };
  }

  async disconnect() {
    // Close all SSE connections
    for (let [connectionId] of this._connections)
      this.removeConnection(connectionId);

    await super.disconnect();
  }

  getConnectionCount() {
    return this._connections.size;
  }

  // Format data as SSE event string
  _formatSSE(data) {
    let payload   = (typeof data === 'string') ? data : JSON.stringify(data);
    let lines     = payload.split('\n');
    let formatted = lines.map((line) => `data: ${line}`).join('\n');
    return `${formatted}\n\n`;
  }
}
