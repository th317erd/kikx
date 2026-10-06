'use strict';

import { DATABASE_URL_PATH } from '../config/config-paths.mjs';
import { DatabaseConnectionBase } from './database-connection-base.mjs';
import { DatabaseError } from './database-error.mjs';
import {
  applyMergePatch,
  matchGlob,
  normalizePath,
  paginate,
  selectDocumentPaths,
} from './document-utils.mjs';
import {
  ensureSearchIndexes,
  queryDocuments,
  searchDocuments,
} from './postgresql-search.mjs';
import { fetchDocumentRanges } from './document-ranges.mjs';

const CREATE_DOCUMENTS_TABLE = [
  'CREATE TABLE IF NOT EXISTS documents (',
  '  path text PRIMARY KEY,',
  '  body text NOT NULL,',
  '  raw boolean NOT NULL DEFAULT false,',
  '  updated_at bigint NOT NULL',
  ')',
].join('\n');

// Range scan: '/' (0x2f) sorts before '0' (0x30), so every descendant of a
// normalized prefix lives in [base + '/', base + '0'). The explicit "C"
// collation is required: the database default locale is not byte-ordered and
// would otherwise break both the sentinel bound and the stream paging order.
const DESCENDANT_QUERY = 'SELECT path FROM documents WHERE path COLLATE "C" >= $1 AND path COLLATE "C" < $2 ORDER BY path COLLATE "C"';
const STREAM_PAGE_SIZE = 500;

// PostgreSQL document-store driver. `pg` is imported lazily inside connect() so
// registering the driver never requires the optional dependency: booting an
// AeorDB-backed server with `pg` absent only fails if this driver is selected.
export class PostgreSQLConnection extends DatabaseConnectionBase {
  static driverID = 'postgresql';
  static displayName = 'PostgreSQL';
  static description = 'Document store backed by a PostgreSQL database.';
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
      name: 'host',
      label: 'host',
      type: 'text',
      required: false,
      help: 'PostgreSQL host (defaults to 127.0.0.1)',
    },
    {
      name: 'port',
      label: 'port',
      type: 'number',
      required: false,
      help: 'PostgreSQL port (defaults to 5432)',
    },
    {
      name: 'database',
      label: 'database',
      type: 'text',
      required: false,
      help: 'PostgreSQL database name (defaults to postgres)',
    },
    {
      name: 'user',
      label: 'user',
      type: 'text',
      required: false,
      help: 'PostgreSQL user (defaults to postgres)',
    },
    {
      name: 'password',
      label: 'password',
      type: 'text',
      required: false,
      secret: true,
      help: 'PostgreSQL password (usually unnecessary with trust/peer auth)',
    },
    {
      name: 'ssl',
      label: 'ssl',
      type: 'text',
      required: false,
      help: 'SSL mode: disable or require (defaults to driver default)',
    },
  ];
  static configKeys = [ DATABASE_URL_PATH ];
  // PostgreSQL gives us real transactions, so batch() is genuinely all-or-nothing.
  static batchAtomicity = 'atomic';

  constructor(options = {}) {
    super(options);
    this.pgConfig = resolvePostgresConfig(options);
    this.pool = null;
    // Whether the optional pg_trgm extension/index was installable. Search is
    // fully functional without it; the flag only enables a similarity score.
    this.trigram = false;
  }

  async connect() {
    if (this._connected)
      return this;

    try {
      let { Pool } = await import('pg');
      this.pool = new Pool(this.pgConfig);
      await this.pool.query(CREATE_DOCUMENTS_TABLE);
      this.trigram = await ensureSearchIndexes(this.pool);
      this._connected = true;
      return this;
    } catch (error) {
      await this.pool?.end().catch(() => {});
      this.pool = null;
      this._connected = false;
      throw error;
    }
  }

  async close() {
    let pool = this.pool;
    this.pool = null;
    this._connected = false;
    if (pool)
      await pool.end();
  }

  async put(path, body, options = {}) {
    let key = normalizePath(path);
    let raw = options.raw === true;
    let text = raw ? String(body ?? '') : JSON.stringify(body ?? null);
    await this._put(this.pool, key, text, raw);
    return { path: key };
  }

  async get(path, options = {}) {
    let key = normalizePath(path);
    let row = (await this.pool.query('SELECT body FROM documents WHERE path = $1', [ key ])).rows[0];
    if (!row)
      return null;

    if (options.raw === true || options.expectJSON === false)
      return row.body;

    return JSON.parse(row.body);
  }

  async merge(path, patch) {
    let key = normalizePath(path);
    return this._mergeWith(this.pool, key, patch);
  }

  async delete(path) {
    let key = normalizePath(path);
    let result = await this.pool.query('DELETE FROM documents WHERE path = $1', [ key ]);
    if (result.rowCount === 0)
      throw notFound(key);
  }

  async list(prefix, options = {}) {
    let base = normalizePath(prefix);
    let result = await this.pool.query(DESCENDANT_QUERY, [ base + '/', base + '0' ]);
    let matches = selectDocumentPaths(result.rows.map((row) => row.path), prefix, options);
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
    for await (let key of this._iteratePaths(base)) {
      let relative = key.slice(base.length + 1);
      if (!recursive && relative.includes('/'))
        continue;
      if (!matchGlob(relative, glob))
        continue;

      if (seen++ < offset)
        continue;
      if (limit != null && yielded >= limit)
        return;

      yielded++;
      yield { path: key };
    }
  }

  async search(request = {}) {
    return searchDocuments(this.pool, request, { trigram: this.trigram });
  }

  async query(request = {}) {
    return queryDocuments(this.pool, request);
  }

  async getRanges(items, options = {}) {
    return fetchDocumentRanges((path) => this._readDocumentRow(path), items, options);
  }

  // Raw row reader for the shared range extractor: body text plus the metadata
  // the locator/range contract needs. Returns null for a missing document so
  // document-ranges.mjs can raise the driver-agnostic 404.
  async _readDocumentRow(path) {
    let row = (await this.pool.query('SELECT body, raw, updated_at FROM documents WHERE path = $1', [ path ])).rows[0];
    return row ?? null;
  }

  async getMany(paths) {
    let result = {};
    for (let path of paths) {
      let key = normalizePath(path);
      let row = (await this.pool.query('SELECT body FROM documents WHERE path = $1', [ key ])).rows[0];
      if (!row)
        throw notFound(key);

      result[path] = { path: key, content: row.body };
    }

    return result;
  }

  async batch(operations) {
    if (!Array.isArray(operations))
      throw new TypeError('batch() operations must be an array');

    let client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (let operation of operations)
        await this._applyBatchOperation(client, operation);

      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        // The original failure is the one that matters; a rollback failure
        // means the transaction is already gone.
      }

      throw error;
    } finally {
      client.release();
    }

    return { applied: operations.length };
  }

  async _applyBatchOperation(client, operation) {
    if (!operation || typeof operation !== 'object')
      throw new TypeError('batch() operations must contain objects');

    let { type, path, body, options } = operation;
    if (type === 'put') {
      let key = normalizePath(path);
      let raw = options?.raw === true;
      await this._put(client, key, raw ? String(body ?? '') : JSON.stringify(body ?? null), raw);
      return;
    }

    if (type === 'merge')
      return this._mergeWith(client, normalizePath(path), body);

    if (type === 'delete') {
      let key = normalizePath(path);
      let result = await client.query('DELETE FROM documents WHERE path = $1', [ key ]);
      if (result.rowCount === 0)
        throw notFound(key);

      return;
    }

    throw new TypeError(`Unknown batch operation type: ${type}`);
  }

  async _put(client, key, text, raw) {
    await client.query(
      'INSERT INTO documents (path, body, raw, updated_at) VALUES ($1, $2, $3, $4) '
        + 'ON CONFLICT (path) DO UPDATE SET body = EXCLUDED.body, raw = EXCLUDED.raw, updated_at = EXCLUDED.updated_at',
      [ key, text, raw, Date.now() ],
    );
  }

  async _mergeWith(client, key, patch) {
    let row = (await client.query('SELECT body FROM documents WHERE path = $1', [ key ])).rows[0];
    if (!row)
      throw notFound(key);

    let merged = applyMergePatch(JSON.parse(row.body), patch);
    await client.query(
      'UPDATE documents SET body = $1, raw = false, updated_at = $2 WHERE path = $3',
      [ JSON.stringify(merged ?? null), Date.now(), key ],
    );
    return merged;
  }

  // Page the ordered descendant keys so a consumer never materializes the whole
  // table (and can stop early after N yields).
  async *_iteratePaths(base) {
    let offset = 0;
    while (true) {
      let result = await this.pool.query(
        `${DESCENDANT_QUERY} LIMIT $3 OFFSET $4`,
        [ base + '/', base + '0', STREAM_PAGE_SIZE, offset ],
      );
      for (let row of result.rows)
        yield row.path;

      if (result.rows.length < STREAM_PAGE_SIZE)
        return;

      offset += result.rows.length;
    }
  }
}

function notFound(path) {
  return new DatabaseError(`Database document not found: ${path}`, { status: 404, code: 'not_found' });
}

// Resolve a pg Pool config from explicit options, plain `config`/`secrets`
// objects and/or a `postgres://` URL. Explicit fields win over the URL; missing
// fields fall back to URL values, then to the conventional defaults.
export function resolvePostgresConfig(options = {}) {
  let url = firstString([ options.url, options.config?.url, options.secrets?.url ]);
  let parsed = parsePostgresURL(url);

  let host = firstString([ options.host, options.config?.host, options.secrets?.host ]) || parsed?.host || '127.0.0.1';
  let port = firstInteger([ options.port, options.config?.port, options.secrets?.port ]) ?? parsed?.port ?? 5432;
  let database = firstString([ options.database, options.config?.database, options.secrets?.database ])
    || parsed?.database
    || 'postgres';
  let user = firstString([ options.user, options.config?.user, options.secrets?.user ]) || parsed?.user || 'postgres';
  let password = firstString([ options.password, options.config?.password, options.secrets?.password ])
    ?? parsed?.password;

  let ssl = resolveSSL(options);
  if (ssl === undefined)
    ssl = parsed?.ssl;

  let config = { host, port, database, user };
  if (password != null && password !== '')
    config.password = password;

  if (ssl !== undefined)
    config.ssl = ssl;

  return config;
}

function parsePostgresURL(value) {
  if (typeof value !== 'string' || !/^postgres(ql)?:\/\//i.test(value.trim()))
    return null;

  try {
    let url = new URL(value.trim());
    let pathname = url.pathname.replace(/^\//, '');
    return {
      host: url.hostname ? url.hostname.replace(/^\[|\]$/g, '') : undefined,
      port: url.port ? Number(url.port) : undefined,
      database: pathname ? decodeURIComponent(pathname) : undefined,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      ssl: normalizeSSL(url.searchParams.get('sslmode')),
    };
  } catch (_error) {
    return null;
  }
}

function resolveSSL(options) {
  for (let candidate of [ options.ssl, options.config?.ssl, options.secrets?.ssl ]) {
    let normalized = normalizeSSL(candidate);
    if (normalized !== undefined)
      return normalized;
  }

  return undefined;
}

function normalizeSSL(value) {
  if (value == null || value === '')
    return undefined;

  if (typeof value === 'boolean')
    return value;

  if (typeof value === 'object')
    return value;

  if (typeof value !== 'string')
    return undefined;

  let mode = value.trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow' || mode === 'false' || mode === '0' || mode === 'no')
    return false;

  if (mode === 'verify-full' || mode === 'verify-ca')
    return true;

  return { rejectUnauthorized: false };
}

function firstString(values) {
  for (let value of values) {
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim();
  }

  return undefined;
}

function firstInteger(values) {
  for (let value of values) {
    if (value === undefined || value === null || value === '')
      continue;

    let number = Number(value);
    if (Number.isInteger(number) && number > 0)
      return number;
  }

  return undefined;
}
