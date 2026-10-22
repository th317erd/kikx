'use strict';

import {
  DEFAULT_SSE_COALESCE_DELAY_MS,
  DEFAULT_SSE_COALESCE_LIMIT,
} from './events.mjs';

// One gateway per server process. Frame runtimes emit a very high volume of
// thinking/message deltas; letting every SSE connection own its own buffer
// duplicates both memory and work. The gateway subscribes once, retains the
// newest update per session/frame/type, and fans out bounded batches to all
// connected clients. The `dispatchBatch` method is the seam for future jitter:
// a different dispatcher can round-robin batches across clients without changing
// event collection or transport code.
export class RuntimeEventGateway {
  constructor({
    frameRuntime,
    batchIntervalMs = DEFAULT_SSE_COALESCE_DELAY_MS,
    batchLimit = DEFAULT_SSE_COALESCE_LIMIT,
    logger = console,
  } = {}) {
    if (!frameRuntime || typeof frameRuntime.on !== 'function')
      throw new TypeError('RuntimeEventGateway requires a frame runtime event emitter');

    this.frameRuntime = frameRuntime;
    this.batchIntervalMs = normalizeNonNegative(batchIntervalMs, DEFAULT_SSE_COALESCE_DELAY_MS);
    this.batchLimit = normalizeNonNegative(batchLimit, DEFAULT_SSE_COALESCE_LIMIT);
    this.logger = logger;
    this._subscribers = new Set();
    this._pending = [];
    this._pendingKeys = new Map();
    this._flushTimer = null;
    this._onEvent = (event) => this.enqueue(event);
    this.frameRuntime.on('event', this._onEvent);
  }

  subscribe({ sessionID = '', onBatch } = {}) {
    if (typeof onBatch !== 'function')
      throw new TypeError('RuntimeEventGateway.subscribe() requires onBatch');

    let subscriber = { sessionID: normalizeSessionID(sessionID), onBatch };
    this._subscribers.add(subscriber);
    return () => this._subscribers.delete(subscriber);
  }

  enqueue(event) {
    if (this._subscribers.size === 0 || !event)
      return;

    let key = frameEventKey(event);
    if (key) {
      let existing = this._pendingKeys.get(key);
      if (typeof existing === 'number' && existing < this._pending.length) {
        this._pending[existing] = event;
        this._scheduleFlush();
        return;
      }
      this._pendingKeys.set(key, this._pending.length);
    }

    this._pending.push(event);
    if (this.batchLimit > 0 && this._pending.length >= this.batchLimit) {
      this.flush();
      return;
    }

    this._scheduleFlush();
  }

  flush() {
    this._clearFlushTimer();
    let batch = this._pending;
    this._pending = [];
    this._pendingKeys.clear();
    if (batch.length === 0)
      return;

    for (let subscriber of [ ...this._subscribers ]) {
      let events = filterForSubscriber(batch, subscriber);
      if (events.length === 0)
        continue;

      try {
        this.dispatchBatch(subscriber, events);
      } catch (error) {
        this.logger?.error?.('RuntimeEventGateway failed to dispatch a batch', error);
        this._subscribers.delete(subscriber);
      }
    }
  }

  dispatchBatch(subscriber, events) {
    subscriber.onBatch(events);
  }

  close() {
    this.frameRuntime.off?.('event', this._onEvent);
    this._clearFlushTimer();
    this._pending = [];
    this._pendingKeys.clear();
    this._subscribers.clear();
  }

  _scheduleFlush() {
    if (this._flushTimer != null)
      return;

    this._flushTimer = setTimeout(() => this.flush(), this.batchIntervalMs);
    this._flushTimer.unref?.();
  }

  _clearFlushTimer() {
    if (this._flushTimer == null)
      return;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
  }
}

function frameEventKey(event) {
  let type = event?.type;
  if (type !== 'frame.added' && type !== 'frame.updated' && type !== 'frame.phantom')
    return '';

  let sessionID = event?.sessionID;
  let frame = event?.frame;
  if (typeof sessionID !== 'string' || !sessionID || typeof frame?.id !== 'string' || !frame.id)
    return '';

  // Keep frame type in the key: BeginTyping and EndTyping share an id but are
  // distinct transitions, while successive thinking deltas share both and should
  // collapse to the newest payload.
  return `${sessionID}\u0000${frame.type || ''}\u0000${frame.id}`;
}

function filterForSubscriber(events, subscriber) {
  if (!subscriber.sessionID)
    return events;

  return events.filter((event) => !event?.sessionID || event.sessionID === subscriber.sessionID);
}

function normalizeSessionID(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : '';
}

function normalizeNonNegative(value, fallback) {
  let number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
