'use strict';

// =============================================================================
// EventEmitter — pure JS, browser + Node compatible
// =============================================================================
// Drop-in replacement for `node:events` EventEmitter. Uses Map<string, Set>
// internally for O(1) listener removal. API-compatible with the subset used
// by FrameManager (on, off, once, emit, removeAllListeners, removeListener,
// setMaxListeners, listenerCount).
// =============================================================================

export class EventEmitter {
  constructor() {
    this._events       = new Map();  // event → Set<Function>
    this._onceWrapped  = new Map();  // wrapper → original (for once)
    this._maxListeners = 10;
  }

  // ---------------------------------------------------------------------------
  // setMaxListeners / getMaxListeners
  // ---------------------------------------------------------------------------

  setMaxListeners(n) {
    if (typeof n !== 'number' || n < 0)
      throw new RangeError('setMaxListeners requires a non-negative number');

    this._maxListeners = n;

    return this;
  }

  getMaxListeners() {
    return this._maxListeners;
  }

  // ---------------------------------------------------------------------------
  // on / addListener
  // ---------------------------------------------------------------------------

  on(event, listener) {
    if (typeof listener !== 'function')
      throw new TypeError('listener must be a function');

    let listeners = this._events.get(event);

    if (!listeners) {
      listeners = new Set();
      this._events.set(event, listeners);
    }

    listeners.add(listener);

    // Max listener warning (not throw)
    if (this._maxListeners > 0 && listeners.size > this._maxListeners) {
       
      console.warn(
        `EventEmitter: possible memory leak detected. ${listeners.size} ` +
        `listeners added for event "${event}". Use setMaxListeners() to increase limit.`,
      );
    }

    return this;
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  // ---------------------------------------------------------------------------
  // off / removeListener
  // ---------------------------------------------------------------------------

  off(event, listener) {
    if (typeof listener !== 'function')
      throw new TypeError('listener must be a function');

    let listeners = this._events.get(event);
    if (!listeners)
      return this;

    // Try direct removal first
    if (listeners.delete(listener)) {
      if (listeners.size === 0)
        this._events.delete(event);

      return this;
    }

    // Check if this is the original function of a `once` wrapper
    for (let wrapped of listeners) {
      if (this._onceWrapped.get(wrapped) === listener) {
        listeners.delete(wrapped);
        this._onceWrapped.delete(wrapped);

        if (listeners.size === 0)
          this._events.delete(event);

        break;
      }
    }

    return this;
  }

  removeListener(event, listener) {
    return this.off(event, listener);
  }

  // ---------------------------------------------------------------------------
  // once
  // ---------------------------------------------------------------------------

  once(event, listener) {
    if (typeof listener !== 'function')
      throw new TypeError('listener must be a function');

    let wrapper = (...args) => {
      this.off(event, wrapper);
      this._onceWrapped.delete(wrapper);
      listener.apply(this, args);
    };

    this._onceWrapped.set(wrapper, listener);

    return this.on(event, wrapper);
  }

  // ---------------------------------------------------------------------------
  // emit
  // ---------------------------------------------------------------------------

  emit(event, ...args) {
    // Special 'error' event: throw if no listeners
    if (event === 'error') {
      let listeners = this._events.get('error');

      if (!listeners || listeners.size === 0) {
        let error = args[0];

        if (error instanceof Error)
          throw error;

        throw new Error('Unhandled error event');
      }
    }

    let listeners = this._events.get(event);
    if (!listeners || listeners.size === 0)
      return false;

    // Snapshot the listeners so removals during iteration don't skip callbacks
    let snapshot = [...listeners];

    for (let i = 0; i < snapshot.length; i++)
      snapshot[i].apply(this, args);

    return true;
  }

  // ---------------------------------------------------------------------------
  // removeAllListeners
  // ---------------------------------------------------------------------------

  removeAllListeners(event) {
    if (event !== undefined) {
      let listeners = this._events.get(event);

      if (listeners) {
        // Clean up once wrappers
        for (let listener of listeners)
          this._onceWrapped.delete(listener);

        this._events.delete(event);
      }
    } else {
      this._onceWrapped.clear();
      this._events.clear();
    }

    return this;
  }

  // ---------------------------------------------------------------------------
  // listenerCount / listeners / eventNames
  // ---------------------------------------------------------------------------

  listenerCount(event) {
    let listeners = this._events.get(event);
    return (listeners) ? listeners.size : 0;
  }

  listeners(event) {
    let listeners = this._events.get(event);
    return (listeners) ? [...listeners] : [];
  }

  eventNames() {
    return [...this._events.keys()];
  }
}
