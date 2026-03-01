'use strict';

import { Transport } from './interface.mjs';

export class EventTransport extends Transport {
  constructor(options = {}) {
    super(options);
    this._streams = new Map(); // connectionId -> { messages: [], listeners: [] }
  }

  async send(connectionId, data) {
    let stream = this._streams.get(connectionId);
    if (stream) {
      stream.messages.push(data);
      for (let listener of stream.listeners)
        listener(data);
    }

    this.emit('message:sent', { connectionId, data });
  }

  async broadcast(data) {
    for (let [connectionId] of this._streams)
      await this.send(connectionId, data);

    this.emit('broadcast', { data });
  }

  createStream(connectionId, options = {}) {
    let stream = { messages: [], listeners: [] };
    this._streams.set(connectionId, stream);

    return {
      id:          connectionId,
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
  simulateMessage(connectionId, data) {
    this.emit('message', { connectionId, data });
  }

  getStreamCount() {
    return this._streams.size;
  }
}
