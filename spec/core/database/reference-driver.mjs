'use strict';

// Reference in-memory driver. It is NOT production code; it exists so the
// shared driver-contract harness can be exercised (and so a contract change
// fails here before it can silently reach a real driver). Real drivers
// (AeorDB/PostgreSQL/SQLite) must satisfy the same harness.

import { DatabaseConnectionBase } from '../../../src/core/database/database-connection-base.mjs';
import { DatabaseError } from '../../../src/core/database/database-error.mjs';

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
    let base = normalizePath(prefix);
    let recursive = options.recursive === true;
    let glob = options.glob || '**';
    let matches = [];

    for (let [ key, text ] of this._documents) {
      if (key === base || !key.startsWith(`${base}/`))
        continue;

      let relative = key.slice(base.length + 1);
      if (!recursive && relative.includes('/'))
        continue;

      if (!matchGlob(relative, glob))
        continue;

      matches.push({ key, text });
    }

    matches.sort((left, right) => {
      let leftBase = basename(left.key);
      let rightBase = basename(right.key);
      if (leftBase < rightBase)
        return -1;
      if (leftBase > rightBase)
        return 1;

      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    });

    return matches;
  }
}

export function normalizePath(path) {
  if (!path || typeof path !== 'string')
    throw new TypeError('Database path must be a non-empty string');

  let trimmed = path.replace(/^\/+/g, '').replace(/\/+$/g, '');
  return `/${trimmed}`;
}

function basename(key) {
  return key.slice(key.lastIndexOf('/') + 1);
}

// `_collect` returns the full, sorted match set; pagination is applied here so
// `total` is always the unconditional match count, not the page size.
function paginate(matches, options = {}) {
  let offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
  let limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : null;
  return limit == null ? matches.slice(offset) : matches.slice(offset, offset + limit);
}

function notFound(path) {
  return new DatabaseError(`Database document not found: ${path}`, { status: 404, code: 'not_found' });
}

// Minimal glob supporting `*` (within a segment) and `**` (across segments).
export function matchGlob(relativePath, pattern) {
  let pathSegments = relativePath.split('/');
  let patternSegments = pattern.split('/');
  return matchSegments(pathSegments, 0, patternSegments, 0);
}

function matchSegments(pathSegments, pathIndex, patternSegments, patternIndex) {
  while (patternIndex < patternSegments.length) {
    let patternSegment = patternSegments[patternIndex];

    if (patternSegment === '**') {
      // `**` matches zero or more path segments.
      if (patternIndex === patternSegments.length - 1)
        return true;

      for (let skip = pathIndex; skip <= pathSegments.length; skip++) {
        if (matchSegments(pathSegments, skip, patternSegments, patternIndex + 1))
          return true;
      }

      return false;
    }

    if (pathIndex >= pathSegments.length)
      return false;

    if (!matchSegment(pathSegments[pathIndex], patternSegment))
      return false;

    pathIndex++;
    patternIndex++;
  }

  return pathIndex === pathSegments.length;
}

function matchSegment(value, pattern) {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

// RFC 7386 JSON merge-patch (recursive object merge; null deletes).
export function applyMergePatch(target, patch) {
  if (!isPlainObject(patch))
    return patch;

  let output = isPlainObject(target) ? { ...target } : {};
  for (let [ key, value ] of Object.entries(patch)) {
    if (value === null)
      delete output[key];
    else
      output[key] = applyMergePatch(output[key], value);
  }

  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
