'use strict';

import { DATABASE_PATH_PATH } from '../config/config-paths.mjs';
import { DatabaseConnectionBase } from './database-connection-base.mjs';
import { DatabaseError } from './database-error.mjs';
import {
  applyMergePatch,
  matchGlob,
  normalizePath,
  paginate,
  pathBounds,
  relativePath,
  selectDocumentPaths,
} from './document-utils.mjs';
import { fetchDocumentRanges } from './document-ranges.mjs';
import { scanQuery, scanSearch } from './scan-search.mjs';

const CREATE_DOCUMENTS_TABLE = [
  'CREATE TABLE IF NOT EXISTS documents (',
  '  path TEXT PRIMARY KEY,',
  '  body TEXT NOT NULL,',
  '  raw INTEGER NOT NULL DEFAULT 0,',
  '  updated_at INTEGER NOT NULL DEFAULT 0',
  ')',
].join('\n');

const DEFAULT_FILENAME = ':memory:';
const DESCENDANT_QUERY = 'SELECT path FROM documents WHERE path >= ? AND path < ?';

// SQLite driver built on Node's bundled `node:sqlite` (`DatabaseSync`). The
// module is imported lazily inside connect() so booting an AeorDB-backed server
// never loads the experimental SQLite module (and never prints its warning).
export class SQLiteConnection extends DatabaseConnectionBase {
  static driverID = 'sqlite';
  static displayName = 'SQLite';
  static description = 'Document store backed by a local SQLite database.';
  static capabilities = {
    read: true,
    write: true,
    mergePatch: true,
    list: true,
    getMany: true,
    search: true,
    query: true,
    events: false,
    auth: false,
    ranges: true,
  };
  static configFields = [
    {
      name: 'filename',
      label: 'filename',
      type: 'text',
      required: false,
      help: 'SQLite database file path or sqlite: URL (defaults to :memory:)',
    },
  ];
  static configKeys = [ DATABASE_PATH_PATH ];
  // SQLite gives us real transactions, so batch() is genuinely all-or-nothing.
  static batchAtomicity = 'atomic';

  constructor(options = {}) {
    super(options);
    this.filename = resolveSQLiteFilename(options);
    this.sqlite = null;
  }

  async connect() {
    if (this._connected)
      return this;

    try {
      let { DatabaseSync } = await import('node:sqlite');
      this.sqlite = new DatabaseSync(this.filename);
      this.sqlite.exec(CREATE_DOCUMENTS_TABLE);
      this._connected = true;
      return this;
    } catch (error) {
      this.sqlite = null;
      this._connected = false;
      throw error;
    }
  }

  async close() {
    this.sqlite?.close();
    this.sqlite = null;
    this._connected = false;
  }

  async put(path, body, options = {}) {
    let key = normalizePath(path);
    let raw = options.raw === true;
    let text = raw ? String(body ?? '') : JSON.stringify(body ?? null);
    this.sqlite.prepare('INSERT OR REPLACE INTO documents (path, body, raw, updated_at) VALUES (?, ?, ?, ?)')
      .run(key, text, raw ? 1 : 0, Date.now());
    return { path: key };
  }

  async get(path, options = {}) {
    let key = normalizePath(path);
    let row = this.sqlite.prepare('SELECT body FROM documents WHERE path = ?').get(key);
    if (!row)
      return null;

    if (options.raw === true)
      return row.body;

    return JSON.parse(row.body);
  }

  async merge(path, patch) {
    let key = normalizePath(path);
    let row = this.sqlite.prepare('SELECT body FROM documents WHERE path = ?').get(key);
    if (!row)
      throw notFound(key);

    let current = JSON.parse(row.body);
    let merged = applyMergePatch(current, patch);
    this.sqlite.prepare('UPDATE documents SET body = ?, raw = 0, updated_at = ? WHERE path = ?')
      .run(JSON.stringify(merged ?? null), Date.now(), key);
    return merged;
  }

  async delete(path) {
    let key = normalizePath(path);
    let result = this.sqlite.prepare('DELETE FROM documents WHERE path = ?').run(key);
    if (result.changes === 0)
      throw notFound(key);
  }

  async getMany(paths) {
    let result = {};
    let select = this.sqlite.prepare('SELECT body, raw, updated_at FROM documents WHERE path = ?');
    for (let path of paths) {
      let key = normalizePath(path);
      let row = select.get(key);
      if (!row)
        throw notFound(key);

      result[path] = {
        path: key,
        content: row.body,
        raw: row.raw === 1,
        updated_at: Number(row.updated_at),
      };
    }

    return result;
  }

  async list(prefix, options = {}) {
    let base = normalizePath(prefix);
    let matches = selectDocumentPaths(this._queryPaths(base), prefix, options);
    let items = paginate(matches, options).map((key) => ({ path: key }));
    return { items, total: matches.length };
  }

  async *entries(prefix, options = {}) {
    let base = normalizePath(prefix);
    let recursive = options.recursive === true;
    let glob = options.glob || '**';
    let offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
    let limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : null;

    let seen = 0;
    let yielded = 0;
    for (let row of this.sqlite.prepare(DESCENDANT_QUERY).iterate(...pathBounds(base))) {
      let key = row.path;
      let relative = relativePath(base, key);
      if (!recursive && relative.includes('/'))
        continue;
      if (!matchGlob(relative, glob))
        continue;

      if (seen++ < offset)
        continue;
      if (limit != null && yielded >= limit)
        break;

      yielded++;
      yield { path: key };
    }
  }

  // SQLite has no searchable text index, so search/query/ranges run over the
  // shared streaming scan fallback. Candidate narrowing is the indexed path
  // range scan in entries(); matching and locator construction happen in JS.
  async search(request = {}) {
    return scanSearch(this, request);
  }

  async query(request = {}) {
    return scanQuery(this, request);
  }

  async getRanges(items, options = {}) {
    return fetchDocumentRanges((path) => this._readDocumentRow(path), items, options);
  }

  async _readDocumentRow(path) {
    let row = this.sqlite.prepare('SELECT body, raw, updated_at FROM documents WHERE path = ?').get(path);
    if (!row)
      return null;

    return { body: row.body, raw: row.raw === 1, updated_at: Number(row.updated_at) };
  }

  async batch(operations) {
    if (!Array.isArray(operations))
      throw new TypeError('batch() operations must be an array');

    this.sqlite.exec('BEGIN');
    try {
      for (let operation of operations)
        await this._applyBatchOperation(operation);

      this.sqlite.exec('COMMIT');
    } catch (error) {
      try {
        this.sqlite.exec('ROLLBACK');
      } catch (_rollbackError) {
        // The original failure is the one that matters; a rollback failure
        // means the transaction is already gone.
      }

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

  // Loads the descendant keys under a normalized prefix with a single indexed
  // range scan (`pathBounds(prefix)`), then sorts in JS for the stable basename
  // order the contract requires.
  _queryPaths(base) {
    return this.sqlite.prepare(DESCENDANT_QUERY)
      .all(...pathBounds(base))
      .map((row) => row.path);
  }
}

function notFound(path) {
  return new DatabaseError(`Database document not found: ${path}`, { status: 404, code: 'not_found' });
}

// Accepts a plain filesystem path, `:memory:` or a `sqlite:` URL:
//   sqlite::memory:   -> :memory:
//   sqlite:///abs/path -> /abs/path
//   sqlite:rel/path    -> rel/path
// An http(s) URL is ignored: it is the AeorDB base URL threaded through the
// generic createServer options, not a SQLite target.
export function resolveSQLiteFilename(options = {}) {
  let candidates = [
    options.filename,
    options.url,
    options.config?.filename,
    options.secrets?.filename,
  ];

  for (let candidate of candidates) {
    let target = parseSQLiteTarget(candidate);
    if (target != null)
      return target;
  }

  return DEFAULT_FILENAME;
}

function parseSQLiteTarget(value) {
  if (typeof value !== 'string')
    return null;

  let target = value.trim();
  if (target === '')
    return null;

  if (target === DEFAULT_FILENAME)
    return DEFAULT_FILENAME;

  if (!target.startsWith('sqlite:')) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target))
      return null;

    return target;
  }

  let rest = target.slice('sqlite:'.length);
  if (rest === '' || rest === DEFAULT_FILENAME)
    return DEFAULT_FILENAME;

  if (rest.startsWith('///'))
    return rest.slice(2);

  if (rest.startsWith('//'))
    return rest.slice(2);

  return rest;
}
