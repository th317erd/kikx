'use strict';

export class AppContext {
  constructor(initialServices = {}) {
    this._services = new Map();

    for (let [name, service] of Object.entries(initialServices))
      this.set(name, service);
  }

  set(name, service) {
    if (!name || typeof name !== 'string')
      throw new TypeError('service name must be a non-empty string');

    if (service === undefined)
      throw new TypeError(`service "${name}" cannot be undefined`);

    this._services.set(name, service);
    return this;
  }

  get(name) {
    return this._services.get(name);
  }

  require(name) {
    if (!this._services.has(name))
      throw new Error(`Required service is not registered: ${name}`);

    return this._services.get(name);
  }

  has(name) {
    return this._services.has(name);
  }

  entries() {
    return this._services.entries();
  }
}

