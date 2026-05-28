'use strict';

import { EventEmitter } from 'node:events';

export class Transport extends EventEmitter {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    super();
    /** @type {boolean} */
    this._connected = false;
    /** @type {object} */
    this._options = options;
  }

  /**
   * Send a message/frame to a specific client/connection.
   * @param {string} connectionID
   * @param {any} data
   * @returns {Promise<void>}
   */
  async send(connectionID, data) {
    throw new Error('Transport.send() not implemented');
  }

  /**
   * Broadcast a message/frame to all connections.
   * @param {any} data
   * @returns {Promise<void>}
   */
  async broadcast(data) {
    throw new Error('Transport.broadcast() not implemented');
  }

  /**
   * Register a message handler.
   * @param {Function} handler
   * @returns {Function} Unsubscribe function
   */
  onMessage(handler) {
    this.on('message', handler);
    return () => this.off('message', handler);
  }

  /**
   * Create a streaming connection (for SSE-like transports).
   * @param {string} connectionID
   * @param {object} [options]
   * @returns {any}
   */
  createStream(connectionID, options) {
    throw new Error('Transport.createStream() not implemented');
  }

  /**
   * @returns {Promise<void>}
   */
  async connect() {
    this._connected = true;
    this.emit('connected');
  }

  /**
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._connected = false;
    this.emit('disconnected');
  }

  /**
   * @returns {boolean}
   */
  isConnected() {
    return this._connected;
  }

  /**
   * @returns {object}
   */
  getOptions() {
    return this._options;
  }
}
