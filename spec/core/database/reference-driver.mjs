'use strict';

// Reference in-memory driver. It is NOT production code; it exists so the
// shared driver-contract harness can be exercised (and so a contract change
// fails here before it can silently reach a real driver). Real drivers
// (AeorDB/PostgreSQL/SQLite) must satisfy the same harness.

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';
import {
  applyMergePatch,
  matchGlob,
  normalizePath,
  paginate,
  selectDocumentPaths,
} from '../../../src/core/database/document-utils.mjs';

export { applyMergePatch, matchGlob, normalizePath };

export class InMemoryDatabaseConnection extends DatabaseConnectionBase {
  static driverID = 'in-memory';
  static displayName = 'In-Memory (reference)';
  static description = 'Reference document store used to exercise the shared contract harness.';
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

  constructor(options = {}) {
    super(options);
    this._documents = new Map();
  }

  async connect() {
    this._connected = true;
    return this;
  }

  async close() {
    this._connected = false;
  }

  async put(path, body, options = {}) {
    let key = normalizePath(path);
    let text = options.raw === true ? String(body ?? '') : JSON.stringify(body ?? null);
    this._documents.set(key, text);
    return { path: key };
  }

  async get(path, options = {}) {
    let key = normalizePath(path);
    if (!this._documents.has(key))
      return null;

    let text = this._documents.get(key);
    if (options.raw === true)
      return text;

    return JSON.parse(text);
  }

  async merge(path, patch) {
    let key = normalizePath(path);
    if (!this._documents.has(key))
      throw notFound(key);

    let current = JSON.parse(this._documents.get(key));
    let merged = applyMergePatch(current, patch);
    this._documents.set(key, JSON.stringify(merged));
    return merged;
  }

  async delete(path) {
    let key = normalizePath(path);
    if (!this._documents.has(key))
      throw notFound(key);

    this._documents.delete(key);
  }

  async getMany(paths) {
    let result = {};
    for (let path of paths) {
      let key = normalizePath(path);
      if (!this._documents.has(key))
        throw notFound(key);

      result[path] = { path: key, content: this._documents.get(key) };
    }

    return result;
  }

  async list(prefix, options = {}) {
    let matches = this._collect(prefix, options);
    let items = paginate(matches, options).map((entry) => ({ path: entry.key }));
    return { items, total: matches.length };
  }

  async *entries(prefix, options = {}) {
    for (let entry of paginate(this._collect(prefix, options), options))
      yield { path: entry.key };
  }

  async batch(operations) {
    if (!Array.isArray(operations))
      throw new TypeError('batch() operations must be an array');

    // Atomic via snapshot/rollback (the harness asserts all-or-nothing).
    let snapshot = new Map(this._documents);
    try {
      for (let operation of operations)
        await this._applyBatchOperation(operation);
    } catch (error) {
      this._documents = snapshot;
      throw error;
    }

    return { applied: operations.length };
  }

  async _applyBatchOperation(operation) {
    if (!operation || typeof operation !== 'object')
      throw new TypeError('batch() operations must contain objects');

    let { type, path, body, options } = operation;
    if (type === 'put')
      return this.put(path, body, options);
    if (type === 'merge')
      return this.merge(path, body);
    if (type === 'delete')
      return this.delete(path);

    throw new TypeError(`Unknown batch operation type: ${type}`);
  }

  _collect(prefix, options = {}) {
    return selectDocumentPaths(this._documents.keys(), prefix, options)
      .map((key) => ({ key, text: this._documents.get(key) }));
  }
}

function notFound(path) {
  return new DatabaseError(`Database document not found: ${path}`, { status: 404, code: 'not_found' });
}
