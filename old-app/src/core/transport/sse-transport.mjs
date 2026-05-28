'use strict';

import { Transport } from './interface.mjs';

export class SSETransport extends Transport {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    super(options);
    /** @type {Map<string, { write: Function, close: Function, lastEventID: string|null }>} */
    this._connections = new Map();
  }

  /**
   * Register an SSE connection (called by the server wrapper when a client connects).
   * @param {string} connectionID
   * @param {{ write: Function, close: Function }} writer
   * @returns {Function} Unregister function
   */
  registerConnection(connectionID, writer) {
    this._connections.set(connectionID, {
      write:        writer.write.bind(writer),
      close:        writer.close.bind(writer),
      lastEventID:  null,
    });

    this.emit('connection', { connectionID });
    return () => this.removeConnection(connectionID);
  }

  /**
   * @param {string} connectionID
   * @returns {void}
   */
  removeConnection(connectionID) {
    let connection = this._connections.get(connectionID);
    if (!connection)
      return;

    try { connection.close(); } catch (e) { /* ignore */ }
    this._connections.delete(connectionID);
    this.emit('disconnection', { connectionID });
  }

  /**
   * @param {string} connectionID
   * @param {any} data
   * @returns {Promise<void>}
   */
  async send(connectionID, data) {
    let connection = this._connections.get(connectionID);
    if (!connection)
      return;

    let eventData = this._formatSSE(data);
    connection.write(eventData);
    this.emit('message:sent', { connectionID, data });
  }

  /**
   * @param {any} data
   * @returns {Promise<void>}
   */
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

  /**
   * @param {string} connectionID
   * @param {object} [options]
   * @returns {{ id: string, send: (data: any) => Promise<void>, close: () => void }}
   */
  createStream(connectionID, options = {}) {
    return {
      id:     connectionID,
      send:   (data) => this.send(connectionID, data),
      close:  () => this.removeConnection(connectionID),
    };
  }

  /**
   * @returns {Promise<void>}
   */
  async disconnect() {
    for (let [connectionID] of this._connections)
      this.removeConnection(connectionID);

    await super.disconnect();
  }

  /**
   * @returns {number}
   */
  getConnectionCount() {
    return this._connections.size;
  }

  /**
   * Format data as SSE event string.
   * @param {any} data
   * @returns {string}
   */
  _formatSSE(data) {
    let payload   = (typeof data === 'string') ? data : JSON.stringify(data);
    let lines     = payload.split('\n');
    let formatted = lines.map((line) => `data: ${line}`).join('\n');
    return `${formatted}\n\n`;
  }
}
