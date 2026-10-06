'use strict';

import { normalizeConfigFields } from '../plugins/agent-normalizers.mjs';
import { PluginInterface } from '../plugins/plugin-interface.mjs';
import { DatabaseError } from './database-error.mjs';

// Base class for every database driver. Subclasses declare static metadata and
// implement the required document methods; optional surfaces (search, query,
// ranges, events, auth) are gated behind capability flags so a driver is never
// asked to perform an operation it does not advertise.
export class DatabaseConnectionBase extends PluginInterface {
  static driverID = 'base';
  static displayName = null;
  static description = null;
  static capabilities = {
    read: true,
    write: true,
    mergePatch: true,
    list: true,
    getMany: true,
    search: false,
    query: false,
    events: false,
    auth: false,
    ranges: false,
  };
  static configFields = [];
  static configKeys = [];
  static batchAtomicity = 'atomic';

  constructor(options = {}) {
    super(options?.context || {});
    this.config = options.config || {};
    this.secrets = options.secrets || {};
    this._connected = false;
  }

  static async resolveConfigFields(_context = {}) {
    return this.configFields;
  }

  static async getDatabaseDriverDescriptor() {
    return {
      driverID: this.driverID,
      displayName: this.displayName,
      description: this.description,
      capabilities: { ...this.capabilities },
      configFields: normalizeConfigFields(await this.resolveConfigFields()),
      configKeys: Array.isArray(this.configKeys) ? this.configKeys.slice() : [],
    };
  }

  supports(capability) {
    return this.constructor.capabilities?.[capability] === true;
  }

  requireCapability(capability) {
    if (!this.supports(capability)) {
      throw new DatabaseError(`Database driver does not support capability: ${capability}`, {
        code: 'capability_unsupported',
      });
    }

    return true;
  }

  async connect() {
    throw new Error(`${this.constructor.name}.connect() is not implemented`);
  }

  async close() {}

  async put() {
    throw unimplemented(this, 'put');
  }

  async get() {
    throw unimplemented(this, 'get');
  }

  async merge() {
    throw unimplemented(this, 'merge');
  }

  async delete() {
    throw unimplemented(this, 'delete');
  }

  async list() {
    throw unimplemented(this, 'list');
  }

  // Deliberately a plain async method rather than an async generator: a bare
  // subclass calling `entries()` must return a rejected promise (an async
  // generator would return an iterable on which assert.rejects cannot await).
  async entries() {
    throw unimplemented(this, 'entries');
  }

  async getMany() {
    throw unimplemented(this, 'getMany');
  }

  async batch() {
    throw unimplemented(this, 'batch');
  }

  async search() {
    this.requireCapability('search');
    throw unimplemented(this, 'search');
  }

  async query() {
    this.requireCapability('query');
    throw unimplemented(this, 'query');
  }

  async getRanges() {
    this.requireCapability('ranges');
    throw unimplemented(this, 'getRanges');
  }

  eventsURL() {
    this.requireCapability('events');
    throw unimplemented(this, 'eventsURL');
  }

  async auth() {
    this.requireCapability('auth');
    throw unimplemented(this, 'auth');
  }
}

function unimplemented(instance, method) {
  return new Error(`${instance.constructor.name}.${method}() is not implemented`);
}
