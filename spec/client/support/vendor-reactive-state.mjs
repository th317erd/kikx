'use strict';

// Stand-in for /vendor/aeor-web-components/reactive-state.js. The specs under
// test only need the module to resolve and expose a constructable class.

export class ReactiveState {
  constructor(initial = {}) {
    Object.assign(this, initial);
    this._listeners = new Map();
  }

  on() {}

  off() {}

  emit() {}

  update(values = {}) {
    Object.assign(this, values);
  }
}
