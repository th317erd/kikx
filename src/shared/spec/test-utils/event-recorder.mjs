'use strict';

export class EventRecorder {
  constructor() {
    this._events       = [];
    this._listeners    = new Map();
    this._manager      = null;
    this._counter      = 0;
    this._originalEmit = null;
  }

  attach(frameManager) {
    if (this._manager)
      this.detach();

    this._manager = frameManager;

    // Override the emitter's emit to capture ALL events (including namespaced)
    let emitter = frameManager._emitter;
    this._originalEmit = emitter.emit.bind(emitter);

    let self = this;

    emitter.emit = function(eventName, ...args) {
      self._events.push({
        name:      eventName,
        payload:   args[0],
        order:     self._counter++,
        timestamp: Date.now(),
      });

      return self._originalEmit(eventName, ...args);
    };
  }

  detach() {
    if (!this._manager)
      return;

    // Restore original emit
    if (this._originalEmit)
      this._manager._emitter.emit = this._originalEmit;

    this._originalEmit = null;
    this._manager      = null;
  }

  reset() {
    this._events  = [];
    this._counter = 0;
  }

  get events() {
    return this._events;
  }

  getEvents(eventName) {
    return this._events.filter((e) => e.name === eventName || e.name.startsWith(eventName + ':'));
  }

  assertFired(eventName) {
    let matches = this.getEvents(eventName);

    if (matches.length === 0)
      throw new Error(`Expected event "${eventName}" to have fired, but it never did`);

    return matches;
  }

  assertNotFired(eventName) {
    let matches = this.getEvents(eventName);

    if (matches.length > 0)
      throw new Error(`Expected event "${eventName}" to NOT have fired, but it fired ${matches.length} time(s)`);
  }

  assertFiredWith(eventName, predicateFn) {
    let matches = this.getEvents(eventName);

    if (matches.length === 0)
      throw new Error(`Expected event "${eventName}" to have fired, but it never did`);

    let found = matches.find((e) => predicateFn(e.payload));

    if (!found)
      throw new Error(`Event "${eventName}" fired ${matches.length} time(s), but none matched the predicate`);

    return found;
  }

  assertOrder(eventNames) {
    let lastOrder = -1;

    for (let i = 0; i < eventNames.length; i++) {
      let name    = eventNames[i];
      let matches = this._events.filter((e) => e.name === name);

      if (matches.length === 0)
        throw new Error(`Expected event "${name}" to have fired (position ${i} in order), but it never did`);

      // Find the first match that comes after lastOrder
      let found = matches.find((e) => e.order > lastOrder);

      if (!found)
        throw new Error(`Expected event "${name}" (position ${i}) to fire after order ${lastOrder}, but no match found`);

      lastOrder = found.order;
    }
  }

  assertCount(eventName, n) {
    let matches = this._events.filter((e) => e.name === eventName);

    if (matches.length !== n)
      throw new Error(`Expected event "${eventName}" to fire exactly ${n} time(s), but it fired ${matches.length} time(s)`);
  }
}
