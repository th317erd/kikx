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

    // The historical file-verb adapters below are defined on the prototype for
    // every driver, which would make `typeof db.searchFiles === 'function'`
    // true even for a driver that does not advertise the capability. Shadow
    // them with own `undefined` so capability probes stay meaningful for
    // drivers without search/query/ranges. The modern `search`/`query`/
    // `getRanges`/`eventsURL` methods are deliberately left in place so they
    // keep throwing the typed `capability_unsupported` DatabaseError.
    if (!this.supports('search'))
      this.searchFiles = undefined;

    if (!this.supports('query'))
      this.queryFiles = undefined;

    if (!this.supports('ranges'))
      this.fetchFileRanges = undefined;
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

  // Index configuration is a driver concern. Drivers backed by a store with a
  // persistent index (AeorDB) override this; drivers that have no index
  // concept inherit the no-op and simply ignore the request.
  async configureIndexes(_configs) {}

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

  // --- Historical document surface (driver compatibility adapters) ----------
  // Existing Kikx stores call these "file verb" methods directly. Drivers
  // implement the modern document methods above; these adapters preserve the
  // historical semantics, in particular getFile() throwing on a missing
  // document while get() returns null.
  async getFile(path, options = {}) {
    let value = await this.get(path, options);
    if (value == null)
      throw DatabaseError.notFound(path);

    return value;
  }

  async putFile(path, body, options = {}) {
    return await this.put(path, body, options);
  }

  async patchFile(path, patch, options = {}) {
    return await this.merge(path, patch, options);
  }

  async deleteFile(path, options = {}) {
    return await this.delete(path, options);
  }

  async listDirectory(path, options = {}) {
    let { depth, glob, limit, offset, ...rest } = options;
    let recursive = depth == null ? false : Number(depth) < 0;
    return await this.list(path, { ...rest, recursive, glob, limit, offset });
  }

  async fetchFiles(paths, options = {}) {
    return await this.getMany(paths, options);
  }

  async fetchFileRanges(items, options = {}) {
    return await this.getRanges(items, options);
  }

  async searchFiles(search, options = {}) {
    return await this.search(search, options);
  }

  async queryFiles(query, options = {}) {
    return await this.query(query, options);
  }

  // `withToken` is intentionally NOT defined here. It is the auth surface a
  // driver opts into, and AccountStore uses `typeof db.withToken === 'function'`
  // as its no-auth gate; a base no-op would silently disable that gate for
  // drivers that declare `capabilities.auth === false`.
}

function unimplemented(instance, method) {
  return new Error(`${instance.constructor.name}.${method}() is not implemented`);
}
