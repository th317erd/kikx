'use strict';

import { Transport } from './interface.mjs';

export class SSETransport extends Transport {
  constructor(options = {}) {
    super(options);
    this._connections = new Map(); // connectionID -> { write, close, lastEventID }
  }

  // Register an SSE connection (called by the server wrapper when a client connects)
  registerConnection(connectionID, writer) {
    // writer must have: write(data), close(), setHeaders(headers)
    this._connections.set(connectionID, {
      write:        writer.write.bind(writer),
      close:        writer.close.bind(writer),
      lastEventID:  null,
    });

    this.emit('connection', { connectionID });
    return () => this.removeConnection(connectionID);
  }

  removeConnection(connectionID) {
    let connection = this._connections.get(connectionID);
    if (!connection)
      return;

    try { connection.close(); } catch (e) { /* ignore */ }
    this._connections.delete(connectionID);
    this.emit('disconnection', { connectionID });
  }

  async send(connectionID, data) {
    let connection = this._connections.get(connectionID);
    if (!connection)
      return;

    let eventData = this._formatSSE(data);
    connection.write(eventData);
    this.emit('message:sent', { connectionID, data });
  }

  async broadcast(data) {
    let eventData = this._formatSSE(data);
    for (let [connectionID, connection] of this._connections) {
      try {
        connection.write(eventData);
      } catch (error) {
        this.removeConnection(connectionID);
      }
    }
  }

  createStream(connectionID, options = {}) {
    // For SSE, createStream returns a handle to push events
    return {
      id:     connectionID,
      send:   (data) => this.send(connectionID, data),
      close:  () => this.removeConnection(connectionID),
    };
  }

  async disconnect() {
    // Close all SSE connections
    for (let [connectionID] of this._connections)
      this.removeConnection(connectionID);

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
