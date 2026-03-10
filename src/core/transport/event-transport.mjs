'use strict';

import { Transport } from './interface.mjs';

export class EventTransport extends Transport {
  constructor(options = {}) {
    super(options);
    this._streams = new Map(); // connectionID -> { messages: [], listeners: [] }
  }

  async send(connectionID, data) {
    let stream = this._streams.get(connectionID);
    if (stream) {
      stream.messages.push(data);
      for (let listener of stream.listeners)
        listener(data);
    }

    this.emit('message:sent', { connectionID, data });
  }

  async broadcast(data) {
    for (let [connectionID] of this._streams)
      await this.send(connectionID, data);

    this.emit('broadcast', { data });
  }

  createStream(connectionID, options = {}) {
    let stream = { messages: [], listeners: [] };
    this._streams.set(connectionID, stream);

    return {
      id:          connectionID,
      onData(handler) { stream.listeners.push(handler); },
      getMessages() { return stream.messages.slice(); },
      close() {
        stream.listeners = [];
        // Don't delete - keep message history
      },
    };
  }

  async connect() {
    await super.connect();
  }

  async disconnect() {
    this._streams.clear();
    await super.disconnect();
  }

  // Testing helper: simulate receiving a message from a client
  simulateMessage(connectionID, data) {
    this.emit('message', { connectionID, data });
  }

  getStreamCount() {
    return this._streams.size;
  }
}
