'use strict';

// Properties-store P7 (plan §5): the AeorDB implementation of the SAME
// store contract — document put/get via `db.putFile`/`getFile`, the exact
// mechanism tag-store.mjs uses. One document per SCOPE holds the key→row map
// (/kikx/properties/<type>/<scope-id>.json; scope_id '' encodes to '_' so
// the path never carries an empty segment). JSONB-always keeps rows
// byte-identical in SHAPE with the SQL backend (ciphertext differs only by
// the random IV); behavioral parity is enforced by store-parity-spec, not
// by shared code — the two backends speak different protocols.
//
// Honesties, stated plainly: soft delete is a row REWRITE (the doctrine: cleared
// ≠ never-set), so deleteFile is never needed; the store does NOT close the
// shared db handle (it does not own it); and without a SQL engine there is
// no cross-writer CAS — expectedVersion still guards read-modify-write
// within the document, last-writer-wins beyond it.

import { normalizePropertyKey, normalizePropertyPrefix } from './keys.mjs';
import { sealPropertiesValue, openPropertiesValue } from './envelope.mjs';
import {
  normalizeScope,
  PropertyStoreError,
  PROPERTY_VALUE_MAX_BYTES,
  resolveStoreEncryptionKey,
} from './store.mjs';

const BASE_PATH = '/kikx/properties';

function docPath(scope) {
  const id = encodeURIComponent(scope.id) || '_';
  return `${BASE_PATH}/${encodeURIComponent(scope.type)}/${id}.json`;
}

class AeordbPropertiesStore {
  constructor({ db, encryptionKey = null, keyError = null, logger = console }) {
    this.db = db;
    this.key = encryptionKey;
    this.keyError = keyError;
    this.logger = logger;
    this.closed = false;
  }

  async _readDoc(scope) {
    try {
      const doc = await this.db.getFile(docPath(scope));
      if (!doc)
        return {};
      const parsed = typeof doc === 'string' ? JSON.parse(doc) : doc;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.status === 404)
        return {};
      throw error;
    }
  }

  async _writeDoc(scope, map) {
    await this.db.putFile(docPath(scope), map);
  }

  _map(row) {
    if (!row)
      return null;
    const alg = row.encryptionMethod ?? null;
    const opened = openPropertiesValue(row.value, { key: this.key, alg, kid: row.keyRef ?? null });
    return {
      value: opened.value,
      encryptionMethod: alg,
      hashMethod: row.hashMethod ?? null,
      keyRef: row.keyRef ?? null,
      version: Number(row.version),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      updatedBy: row.updatedBy ?? null,
      deletedAt: row.deletedAt === null || row.deletedAt === undefined ? null : Number(row.deletedAt),
    };
  }

  async get(scopeRaw, keyRaw) {
    const scope = normalizeScope(scopeRaw);
    const key = normalizePropertyKey(keyRaw);
    const map = await this._readDoc(scope);
    return this._map(map[key] ?? null);
  }

  async put(scopeRaw, keyRaw, value, { secret = false, expectedVersion = null, updatedBy = null } = {}) {
    const scope = normalizeScope(scopeRaw);
    const key = normalizePropertyKey(keyRaw);
    const wrapper = JSON.stringify({ value });
    if (wrapper.length > PROPERTY_VALUE_MAX_BYTES)
      throw new PropertyStoreError('property_value_too_large',
        `value exceeds ${PROPERTY_VALUE_MAX_BYTES} bytes of JSON`);

    let storeValue = { value };
    let encryptionMethod = null;
    let keyRef = null;
    if (secret) {
      if (!this.key) {
        const detail = this.keyError ? ` (unusable: ${this.keyError.message})` : '';
        throw new PropertyStoreError('property_secret_key_missing',
          `secret values need KIKX_PROPERTIES_ENCRYPTION_KEY — fail-closed${detail}`);
      }
      const envelope = sealPropertiesValue(value, this.key);
      storeValue = envelope;
      encryptionMethod = envelope.__enc.alg;
      keyRef = envelope.__enc.kid;
    }

    const map = await this._readDoc(scope);
    const existing = map[key] ?? null;
    const wantsMatch = expectedVersion !== null && expectedVersion !== undefined;
    if (wantsMatch) {
      const currentVersion = existing ? Number(existing.version) : null;
      if (currentVersion === null)
        throw new PropertyStoreError('property_version_conflict',
          `expected version ${expectedVersion}, no such row`);
      if (currentVersion !== Number(expectedVersion))
        throw new PropertyStoreError('property_version_conflict',
          `expected version ${expectedVersion}, row is at version ${currentVersion}`);
    }
    const now = Date.now();
    const row = {
      value: storeValue,
      encryptionMethod,
      hashMethod: null,
      keyRef,
      version: existing ? Number(existing.version) + 1 : 1,
      createdAt: existing ? Number(existing.createdAt) : now,
      updatedAt: now,
      updatedBy: updatedBy ?? null,
      deletedAt: null,
    };
    map[key] = row;
    await this._writeDoc(scope, map);
    return this._map(row);
  }

  async delete(scopeRaw, keyRaw, { expectedVersion = null, updatedBy = null } = {}) {
    const scope = normalizeScope(scopeRaw);
    const key = normalizePropertyKey(keyRaw);
    const map = await this._readDoc(scope);
    const existing = map[key] ?? null;
    if (!existing)
      throw new PropertyStoreError('property_not_found',
        `no property at ${scope.type}:${scope.id} ${key}`);
    const wantsMatch = expectedVersion !== null && expectedVersion !== undefined;
    if (wantsMatch && Number(existing.version) !== Number(expectedVersion))
      throw new PropertyStoreError('property_version_conflict',
        `expected version ${expectedVersion}, row is at version ${existing.version}`);
    const now = Date.now();
    const row = {
      value: { value: null },
      encryptionMethod: null,
      hashMethod: null,
      keyRef: null,
      version: Number(existing.version) + 1,
      createdAt: Number(existing.createdAt),
      updatedAt: now,
      updatedBy: updatedBy ?? null,
      deletedAt: now,
    };
    map[key] = row;
    await this._writeDoc(scope, map);
    return this._map(row);
  }

  async list(scopeRaw, prefixRaw = null) {
    const scope = normalizeScope(scopeRaw);
    const prefix = normalizePropertyPrefix(prefixRaw);
    const map = await this._readDoc(scope);
    return Object.keys(map)
      .filter((key) => map[key] && map[key].deletedAt === null
        && (prefix === '' || key.startsWith(prefix)))
      .sort();
  }

  async close() {
    // The db handle is SHARED with the document store — closing it here
    // would rip the floor out from under the running server.
    this.closed = true;
  }
}

export async function openAeordbPropertiesStore(options = {}) {
  if (!options.db)
    throw new PropertyStoreError('property_store_driver',
      'aeordb properties store needs a db handle — the document connection resolves after '
      + 'plugin load, so inject a ready instance via options.propertiesStore');
  const { key, keyError } = resolveStoreEncryptionKey(options, options.logger);
  return new AeordbPropertiesStore({
    db: options.db,
    encryptionKey: key,
    keyError,
    logger: options.logger || console,
  });
}
