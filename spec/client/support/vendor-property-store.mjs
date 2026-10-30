'use strict';

// Minimal Node-side stand-in for the framework PropertyStore. The real store is
// exercised in the AEOR browser harness; Kikx unit specs only need the contract
// consumed by the shell builders.
export class PropertyStore {
  constructor(initial = {}) {
    this.values = { ...(initial || {}) };
    this.listeners = new Map();
    this.all = new Set();
    this.pending = new Map();
    this.revision = 0;
    this.flushScheduled = false;
  }

  get(key) { return this.values[key]; }
  keys() { return Object.keys(this.values); }
  toJSON() { return { ...this.values }; }

  set(key, value, options = {}) {
    let previous = this.values[key];
    if (Object.is(previous, value))
      return false;

    let record = this.pending.get(key);
    if (!record)
      this.pending.set(key, { key, previous, next: value, source: options.source || 'test' });
    else
      record.next = value;
    this.values[key] = value;
    this.schedule();
    return true;
  }

  update(key, updater) { return this.set(key, updater(this.get(key))); }
  transaction(run) { return run(this); }

  observe(key, callback) {
    let listeners = this.listeners.get(key) || new Set();
    listeners.add(callback);
    this.listeners.set(key, listeners);
    return () => listeners.delete(callback);
  }

  observeAll(callback) {
    this.all.add(callback);
    return () => this.all.delete(callback);
  }

  schedule() {
    if (this.flushScheduled)
      return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  flush() {
    if (this.pending.size === 0)
      return;
    let revision = ++this.revision;
    let records = [ ...this.pending.values() ].map((record) => ({ ...record, revision }));
    this.pending.clear();
    for (let record of records) {
      for (let callback of [ ...(this.listeners.get(record.key) || []) ])
        callback(record);
    }
    for (let callback of [ ...this.all ])
      callback(records);
  }

  dispose() {
    this.listeners.clear();
    this.all.clear();
    this.pending.clear();
  }
}

export function createPropertyStore(initial, options) {
  return new PropertyStore(initial, options);
}
