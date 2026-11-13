'use strict';

// Properties-store P1 — SQL implementations of the store contract.
// sqlite is the UNIT dialect (node:sqlite, file or :memory:); PostgreSQL
// rides a plain pool exactly like plugin-migrations (the document drivers
// expose a document API, not a SQL client, so DDL cannot go through them).
// Both dialects share ONE statement builder (placeholders are generated per
// dialect) so the SQL cannot drift between them; real-PG parity is a P7
// env-skipped lane — the unit lane never needs a live PostgreSQL.

import { normalizePropertyKey, normalizePropertyPrefix } from './keys.mjs';
import { sealPropertiesValue, openPropertiesValue, PropertyEnvelopeError } from './envelope.mjs';
import {
  normalizeScope,
  PropertyStoreError,
  PROPERTY_VALUE_MAX_BYTES,
  resolveStoreEncryptionKey,
} from './store.mjs';

const SQLITE_DDL = `CREATE TABLE IF NOT EXISTS properties (
  key TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global','account','session','plugin')),
  scope_id TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  encryption_method TEXT NULL,
  hash_method TEXT NULL,
  key_ref TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  deleted_at INTEGER,
  PRIMARY KEY (scope_type, scope_id, key),
  CHECK ((encryption_method IS NULL AND hash_method IS NULL)
      OR (encryption_method IS NOT NULL AND key_ref IS NOT NULL)
      OR (hash_method IS NOT NULL AND key_ref IS NOT NULL))
)`;

const POSTGRES_DDL = `CREATE TABLE IF NOT EXISTS properties (
  key text NOT NULL,
  scope_type text NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global','account','session','plugin')),
  scope_id text NOT NULL DEFAULT '',
  value jsonb NOT NULL,
  encryption_method text NULL,
  hash_method text NULL,
  key_ref text NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz NULL,
  PRIMARY KEY (scope_type, scope_id, key),
  CHECK ((encryption_method IS NULL AND hash_method IS NULL)
      OR (encryption_method IS NOT NULL AND key_ref IS NOT NULL)
      OR (hash_method IS NOT NULL AND key_ref IS NOT NULL))
)`;

export function propertiesDDLFor(driver) {
  if (driver === 'sqlite')
    return SQLITE_DDL;
  if (driver === 'postgresql')
    return POSTGRES_DDL;
  throw new PropertyStoreError('property_store_driver',
    `no properties DDL for driver ${JSON.stringify(driver)} (supported: sqlite, postgresql)`);
}

const ph = (dialect, n) => (dialect === 'sqlite' ? '?' : `$${n}`);
const tsParam = (ms, dialect) => (dialect === 'sqlite' ? ms : new Date(ms).toISOString());
const toMs = (value) => {
  if (value === null || value === undefined)
    return null;
  if (value instanceof Date)
    return value.getTime();
  if (typeof value === 'number')
    return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

function escapeLike(prefix) {
  return prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
}

class SqlPropertiesStore {
  constructor({ dialect, query, close, encryptionKey = null, keyError = null, logger = console }) {
    this.dialect = dialect;
    this._query = query;
    this._close = close;
    this.key = encryptionKey;
    this.keyError = keyError;
    this.logger = logger;
    this.closed = false;
  }

  async q(sql, params = []) {
    return this._query(sql, params);
  }

  // ---- statement builders (ONE param order per statement, two dialects) ---

  _getSQL() {
    return `SELECT * FROM properties WHERE scope_type = ${ph(this.dialect, 1)}`
      + ` AND scope_id = ${ph(this.dialect, 2)} AND key = ${ph(this.dialect, 3)}`;
  }

  _updateSQL(withVersion) {
    let n = 0;
    const set = [
      `value = ${ph(this.dialect, ++n)}`,
      `encryption_method = ${ph(this.dialect, ++n)}`,
      `hash_method = ${ph(this.dialect, ++n)}`,
      `key_ref = ${ph(this.dialect, ++n)}`,
      'version = version + 1',
      `updated_at = ${ph(this.dialect, ++n)}`,
      `updated_by = ${ph(this.dialect, ++n)}`,
      'deleted_at = NULL',
    ].join(', ');
    const where = [
      `scope_type = ${ph(this.dialect, ++n)}`,
      `scope_id = ${ph(this.dialect, ++n)}`,
      `key = ${ph(this.dialect, ++n)}`,
    ];
    const versionAt = withVersion ? ++n : null;
    return {
      sql: `UPDATE properties SET ${set} WHERE ${where.join(' AND ')}`
        + (withVersion ? ` AND version = ${ph(this.dialect, versionAt)}` : ''),
    };
  }

  _insertSQL() {
    const columns = 'key, scope_type, scope_id, value, encryption_method, hash_method,'
      + ' key_ref, version, created_at, updated_at, updated_by, deleted_at';
    const values = Array.from({ length: 12 }, (_, i) => ph(this.dialect, i + 1)).join(', ');
    return `INSERT INTO properties (${columns}) VALUES (${values})`;
  }

  _deleteSQL(withVersion) {
    let n = 0;
    const set = [
      `value = '{"value":null}'`,
      'encryption_method = NULL',
      'hash_method = NULL',
      'key_ref = NULL',
      'version = version + 1',
      `updated_at = ${ph(this.dialect, ++n)}`,
      `updated_by = ${ph(this.dialect, ++n)}`,
      // Explicit param, not `deleted_at = updated_at`: PG's SET reads OLD row
      // values while SQLite reads the just-assigned NEW one — a column
      // reference would silently diverge between dialects.
      `deleted_at = ${ph(this.dialect, ++n)}`,
    ].join(', ');
    const where = [
      `scope_type = ${ph(this.dialect, ++n)}`,
      `scope_id = ${ph(this.dialect, ++n)}`,
      `key = ${ph(this.dialect, ++n)}`,
    ];
    const versionAt = withVersion ? ++n : null;
    return `UPDATE properties SET ${set} WHERE ${where.join(' AND ')}`
      + (withVersion ? ` AND version = ${ph(this.dialect, versionAt)}` : '');
  }

  // ---- row mapping ---------------------------------------------------------

  _map(rawRow) {
    if (!rawRow)
      return null;
    const rawValue = rawRow.value;
    let envelope;
    if (typeof rawValue === 'string') {
      try {
        envelope = JSON.parse(rawValue);
      } catch {
        throw new PropertyEnvelopeError('property_envelope_open',
          'stored value is not JSON — refusing (corrupt row)');
      }
    } else {
      envelope = rawValue; // jsonb arrives pre-parsed
    }
    const alg = rawRow.encryption_method ?? null;
    const keyRef = rawRow.key_ref ?? null;
    const opened = openPropertiesValue(envelope, { key: this.key, alg, kid: keyRef });
    return {
      value: opened.value,
      encryptionMethod: alg,
      hashMethod: rawRow.hash_method ?? null,
      keyRef,
      version: Number(rawRow.version),
      createdAt: toMs(rawRow.created_at),
      updatedAt: toMs(rawRow.updated_at),
      updatedBy: rawRow.updated_by ?? null,
      deletedAt: toMs(rawRow.deleted_at),
    };
  }

  // ---- contract ------------------------------------------------------------

  async get(scopeRaw, keyRaw) {
    const scope = normalizeScope(scopeRaw);
    const key = normalizePropertyKey(keyRaw);
    const result = await this.q(this._getSQL(), [ scope.type, scope.id, key ]);
    return this._map(result.rows[0] ?? null);
  }

  async put(scopeRaw, keyRaw, value, { secret = false, expectedVersion = null, updatedBy = null } = {}) {
    const scope = normalizeScope(scopeRaw);
    const key = normalizePropertyKey(keyRaw);
    const wrapper = JSON.stringify({ value });
    if (wrapper.length > PROPERTY_VALUE_MAX_BYTES)
      throw new PropertyStoreError('property_value_too_large',
        `value exceeds ${PROPERTY_VALUE_MAX_BYTES} bytes of JSON`);

    let storeValue = wrapper;
    let encryptionMethod = null;
    let keyRef = null;
    if (secret) {
      if (!this.key) {
        const detail = this.keyError ? ` (unusable: ${this.keyError.message})` : '';
        throw new PropertyStoreError('property_secret_key_missing',
          `secret values need KIKX_PROPERTIES_ENCRYPTION_KEY — fail-closed${detail}`);
      }
      const envelope = sealPropertiesValue(value, this.key);
      storeValue = JSON.stringify(envelope);
      encryptionMethod = envelope.__enc.alg;
      keyRef = envelope.__enc.kid;
    }

    const now = tsParam(Date.now(), this.dialect);
    const updatedByParam = updatedBy ?? null;
    const wantsMatch = expectedVersion !== null && expectedVersion !== undefined;
    const { sql } = this._updateSQL(wantsMatch);
    // Param order mirrors _updateSQL: value, encryption_method, hash_method,
    // key_ref, updated_at, updated_by, scope_type, scope_id, key[, version].
    const updateParams = [ storeValue, encryptionMethod, null, keyRef, now, updatedByParam,
      scope.type, scope.id, key ];
    if (wantsMatch)
      updateParams.push(Number(expectedVersion));

    const updated = await this.q(sql, updateParams);
    if (updated.rowCount === 0) {
      if (wantsMatch) {
        const existing = (await this.q(this._getSQL(), [ scope.type, scope.id, key ])).rows[0];
        const current = existing ? `row is at version ${existing.version}` : 'no such row';
        throw new PropertyStoreError('property_version_conflict',
          `expected version ${expectedVersion}, ${current}`);
      }
      await this.q(this._insertSQL(), [
        key, scope.type, scope.id, storeValue, encryptionMethod, null, keyRef, 1,
        now, now, updatedByParam, null,
      ]);
    }
    const written = (await this.q(this._getSQL(), [ scope.type, scope.id, key ])).rows[0];
    return this._map(written);
  }

  async delete(scopeRaw, keyRaw, { expectedVersion = null, updatedBy = null } = {}) {
    const scope = normalizeScope(scopeRaw);
    const key = normalizePropertyKey(keyRaw);
    const wantsMatch = expectedVersion !== null && expectedVersion !== undefined;
    const now = tsParam(Date.now(), this.dialect);
    // Param order mirrors _deleteSQL: updated_at, updated_by, deleted_at,
    // scope_type, scope_id, key[, expectedVersion].
    const params = [ now, updatedBy ?? null, now, scope.type, scope.id, key ];
    if (wantsMatch)
      params.push(Number(expectedVersion));
    const result = await this.q(this._deleteSQL(wantsMatch), params);
    if (result.rowCount === 0) {
      const existing = (await this.q(this._getSQL(), [ scope.type, scope.id, key ])).rows[0];
      if (!existing)
        throw new PropertyStoreError('property_not_found',
          `no property at ${scope.type}:${scope.id} ${key}`);
      throw new PropertyStoreError('property_version_conflict',
        `expected version ${expectedVersion}, row is at version ${existing.version}`);
    }
    const deleted = (await this.q(this._getSQL(), [ scope.type, scope.id, key ])).rows[0];
    return this._map(deleted);
  }

  async list(scopeRaw, prefixRaw = null) {
    const scope = normalizeScope(scopeRaw);
    const prefix = normalizePropertyPrefix(prefixRaw);
    const like = `${escapeLike(prefix)}%`;
    const sql = `SELECT key FROM properties WHERE scope_type = ${ph(this.dialect, 1)}`
      + ` AND scope_id = ${ph(this.dialect, 2)}`
      + ` AND key LIKE ${ph(this.dialect, 3)} ESCAPE '\\'`
      + ' AND deleted_at IS NULL ORDER BY key';
    const result = await this.q(sql, [ scope.type, scope.id, like ]);
    return result.rows.map((row) => row.key);
  }

  async close() {
    if (this.closed)
      return;
    this.closed = true;
    await this._close();
  }
}

export async function openSQLitePropertiesStore(options = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const filename = options.filename || ':memory:';
  const db = new DatabaseSync(filename);
  db.exec(propertiesDDLFor('sqlite'));
  const query = async (sql, params) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) {
      const rows = statement.all(...params);
      return { rows, rowCount: rows.length };
    }
    const info = statement.run(...params);
    return { rows: [], rowCount: Number(info.changes) };
  };
  const { key, keyError } = resolveStoreEncryptionKey(options, options.logger);
  return new SqlPropertiesStore({
    dialect: 'sqlite',
    query,
    close: () => db.close(),
    encryptionKey: key,
    keyError,
    logger: options.logger || console,
  });
}

export async function openPostgresqlPropertiesStore(options = {}) {
  if (!options.url)
    throw new PropertyStoreError('property_store_driver',
      'postgresql properties store needs a database url');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: options.url });
  await pool.query(propertiesDDLFor('postgresql'));
  const query = async (sql, params) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  };
  const { key, keyError } = resolveStoreEncryptionKey(options, options.logger);
  return new SqlPropertiesStore({
    dialect: 'postgresql',
    query,
    close: () => pool.end(),
    encryptionKey: key,
    keyError,
    logger: options.logger || console,
  });
}
