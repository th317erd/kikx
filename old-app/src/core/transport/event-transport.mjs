'use strict';

import { Transport } from './interface.mjs';

export class EventTransport extends Transport {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    super(options);
    /** @type {Map<string, { messages: any[], listeners: Function[] }>} */
    this._streams = new Map();
  }

  /**
   * @param {string} connectionID
   * @param {any} data
   * @returns {Promise<void>}
   */
  async send(connectionID, data) {
    let stream = this._streams.get(connectionID);
    if (stream) {
      stream.messages.push(data);
      for (let listener of stream.listeners)
        listener(data);
    }

    this.emit('message:sent', { connectionID, data });
  }

  /**
   * @param {any} data
   * @returns {Promise<void>}
   */
  async broadcast(data) {
    for (let [connectionID] of this._streams)
      await this.send(connectionID, data);

    this.emit('broadcast', { data });
  }

  /**
   * @param {string} connectionID
   * @param {object} [options]
   * @returns {{ id: string, onData: (handler: Function) => void, getMessages: () => any[], close: () => void }}
   */
  createStream(connectionID, options = {}) {
    let stream = { messages: [], listeners: [] };
    this._streams.set(connectionID, stream);

    return {
      id:          connectionID,
      onData(handler) { stream.listeners.push(handler); },
      getMessages() { return stream.messages.slice(); },
      close() {
        stream.listeners = [];
      },
    };
  }

  /**
   * @returns {Promise<void>}
   */
  async connect() {
    await super.connect();
  }

  /**
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._streams.clear();
    await super.disconnect();
  }

  /**
   * Testing helper: simulate receiving a message from a client.
   * @param {string} connectionID
   * @param {any} data
   * @returns {void}
   */
  simulateMessage(connectionID, data) {
    this.emit('message', { connectionID, data });
  }

  /**
   * @returns {number}
   */
  getStreamCount() {
    return this._streams.size;
  }
}
