'use strict';

import {
  computeKeyFingerprint,
  signValue,
  verifyValue,
} from '../crypto/value-signing.mjs';

// =============================================================================
// ValueStoreService
// =============================================================================

export class ValueStoreService {
  /**
   * @param {object} options
   * @param {import('../types').CascadingContext} options.context
   */
  constructor({ context }) {
    /** @type {import('../types').CascadingContext} */
    this._context = context;
  }

  /**
   * @returns {import('../types').CoreModels}
   */
  _getModels() {
    return this._context.getProperty('models');
  }

  /**
   * @returns {import('../types').Keystore|null}
   */
  _getKeystore() {
    return this._context.getProperty('keystore');
  }

  /**
   * Fetch a single value by composite key.
   * @param {string} ownerType
   * @param {string} ownerID
   * @param {string} namespace
   * @param {string} key
   * @param {object} [options]
   * @param {string} [options.scopeID]
   * @returns {Promise<any>}
   */
  async get(ownerType, ownerID, namespace, key, options = {}) {
    let { scopeID = '' } = options;
    let { ValueStore }   = this._getModels();

    let entry = await ValueStore
      .where.ownerType.EQ(ownerType)
      .ownerID.EQ(ownerID)
      .namespace.EQ(namespace)
      .scopeID.EQ(scopeID)
      .key.EQ(key)
      .first();

    if (!entry)
      return null;

    return this._parseValue(entry.value);
  }

  /**
   * Upsert a value. If value is null/undefined, deletes the entry instead.
   * @param {string} ownerType
   * @param {string} ownerID
   * @param {string} namespace
   * @param {string} key
   * @param {any} value
   * @param {object} [options]
   * @param {string} [options.scopeID]
   * @param {string} [options.organizationID]
   * @returns {Promise<void>}
   */
  async set(ownerType, ownerID, namespace, key, value, options = {}) {
    let { scopeID = '', organizationID } = options;

    if (value == null)
      return this.delete(ownerType, ownerID, namespace, key, { scopeID });

    let { ValueStore } = this._getModels();

    let entry = await ValueStore
      .where.ownerType.EQ(ownerType)
      .ownerID.EQ(ownerID)
      .namespace.EQ(namespace)
      .scopeID.EQ(scopeID)
      .key.EQ(key)
      .first();

    if (entry) {
      entry.value                 = JSON.stringify(value);
      entry.signature             = null;
      entry.signingKeyFingerprint = null;
      await entry.save();
    } else {
      if (!organizationID)
        throw new Error('organizationID is required when creating a new ValueStore entry');

      await ValueStore.create({
        organizationID,
        ownerType,
        ownerID,
        namespace,
        scopeID,
        key,
        value: JSON.stringify(value),
      });
    }
  }

  /**
   * Fetch all entries in a namespace.
   * @param {string} ownerType
   * @param {string} ownerID
   * @param {string} namespace
   * @param {object} [options]
   * @param {string} [options.scopeID]
   * @returns {Promise<Record<string, any>>}
   */
  async getAll(ownerType, ownerID, namespace, options = {}) {
    let { scopeID = '' } = options;
    let { ValueStore }   = this._getModels();

    let entries = await ValueStore
      .where.ownerType.EQ(ownerType)
      .ownerID.EQ(ownerID)
      .namespace.EQ(namespace)
      .scopeID.EQ(scopeID)
      .all();

    let result = {};

    for (let i = 0; i < entries.length; i++) {
      let entry = entries[i];
      result[entry.key] = this._parseValue(entry.value);
    }

    return result;
  }

  /**
   * Batch set. entries is { key: value, ... }. Null values delete entries.
   * @param {string} ownerType
   * @param {string} ownerID
   * @param {string} namespace
   * @param {Record<string, any>} entries
   * @param {object} [options]
   * @param {string} [options.scopeID]
   * @param {string} [options.organizationID]
   * @returns {Promise<void>}
   */
  async setAll(ownerType, ownerID, namespace, entries, options = {}) {
    let keys = Object.keys(entries);

    for (let i = 0; i < keys.length; i++)
      await this.set(ownerType, ownerID, namespace, keys[i], entries[keys[i]], options);
  }

  /**
   * Delete a single entry. Idempotent — missing key is not an error.
   * @param {string} ownerType
   * @param {string} ownerID
   * @param {string} namespace
   * @param {string} key
   * @param {object} [options]
   * @param {string} [options.scopeID]
   * @returns {Promise<void>}
   */
  async delete(ownerType, ownerID, namespace, key, options = {}) {
    let { scopeID = '' } = options;
    let { ValueStore }   = this._getModels();

    let entry = await ValueStore
      .where.ownerType.EQ(ownerType)
      .ownerID.EQ(ownerID)
      .namespace.EQ(namespace)
      .scopeID.EQ(scopeID)
      .key.EQ(key)
      .first();

    if (entry)
      await entry.destroy();
  }

  /**
   * Search entries by key name and/or value content.
   * @param {string} ownerType
   * @param {string} ownerID
   * @param {string} namespace
   * @param {string|null} query
   * @param {object} [options]
   * @param {string} [options.scopeID]
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @returns {Promise<Array<{ key: string, value: any, scopeID: string, updatedAt: Date, signed: boolean }>>}
   */
  async search(ownerType, ownerID, namespace, query, options = {}) {
    let { scopeID, limit = 20, offset = 0 } = options;
    let { ValueStore } = this._getModels();

    let queryBuilder = ValueStore
      .where.ownerType.EQ(ownerType)
      .ownerID.EQ(ownerID)
      .namespace.EQ(namespace);

    if (scopeID != null)
      queryBuilder = queryBuilder.scopeID.EQ(scopeID);

    let entries = await queryBuilder.all();

    let filtered = entries;

    if (query) {
      let lowerQuery = query.toLowerCase();

      filtered = entries.filter((entry) => {
        let keyMatch   = entry.key.toLowerCase().includes(lowerQuery);
        let valueMatch = (entry.value != null) && entry.value.toLowerCase().includes(lowerQuery);

        return keyMatch || valueMatch;
      });
    }

    let sliced = filtered.slice(offset, offset + limit);

    return sliced.map((entry) => {
      let result = {
        key:       entry.key,
        value:     this._parseValue(entry.value),
        scopeID:   entry.scopeID,
        updatedAt: entry.updatedAt,
        signed:    !!entry.signature,
      };

      return result;
    });
  }

  /**
   * Sign the value with an Ed25519 private key before storing.
   * @param {string} ownerType
   * @param {string} ownerID
   * @param {string} namespace
   * @param {string} key
   * @param {any} value
   * @param {string} privateKeyPEM
   * @param {string} publicKeyPEM
   * @param {object} [options]
   * @param {string} [options.scopeID]
   * @param {string} [options.organizationID]
   * @returns {Promise<void>}
   */
  async setSigned(ownerType, ownerID, namespace, key, value, privateKeyPEM, publicKeyPEM, options = {}) {
    let { scopeID = '', organizationID } = options;
    let keystore       = this._getKeystore();
    let { ValueStore } = this._getModels();

    let jsonValue = JSON.stringify(value);
    let signed    = signValue(keystore, privateKeyPEM, publicKeyPEM, ownerType, ownerID, namespace, scopeID, key, jsonValue);

    if (!signed)
      throw new Error('Failed to sign value — check that private and public keys are valid');

    let entry = await ValueStore
      .where.ownerType.EQ(ownerType)
      .ownerID.EQ(ownerID)
      .namespace.EQ(namespace)
      .scopeID.EQ(scopeID)
      .key.EQ(key)
      .first();

    if (entry) {
      entry.value                 = jsonValue;
      entry.signature             = signed.signature;
      entry.signingKeyFingerprint = signed.fingerprint;
      await entry.save();
    } else {
      if (!organizationID)
        throw new Error('organizationID is required when creating a new ValueStore entry');

      await ValueStore.create({
        organizationID,
        ownerType,
        ownerID,
        namespace,
        scopeID,
        key,
        value:                 jsonValue,
        signature:             signed.signature,
        signingKeyFingerprint: signed.fingerprint,
      });
    }
  }

  /**
   * Fetch an entry and verify its signature with an Ed25519 public key.
   * @param {string} ownerType
   * @param {string} ownerID
   * @param {string} namespace
   * @param {string} key
   * @param {string} publicKeyPEM
   * @param {object} [options]
   * @param {string} [options.scopeID]
   * @returns {Promise<{ value: any, signed: boolean, verified?: boolean }|null>}
   */
  async getVerified(ownerType, ownerID, namespace, key, publicKeyPEM, options = {}) {
    let { scopeID = '' } = options;
    let keystore       = this._getKeystore();
    let { ValueStore } = this._getModels();

    let entry = await ValueStore
      .where.ownerType.EQ(ownerType)
      .ownerID.EQ(ownerID)
      .namespace.EQ(namespace)
      .scopeID.EQ(scopeID)
      .key.EQ(key)
      .first();

    if (!entry)
      return null;

    let value = this._parseValue(entry.value);

    if (!entry.signature)
      return { value, signed: false };

    let verified = verifyValue(
      keystore, publicKeyPEM,
      ownerType, ownerID, namespace, scopeID, key,
      entry.value, entry.signature,
    );

    return { value, signed: true, verified };
  }

  /**
   * Parse JSON value safely.
   * @param {string|null} rawValue
   * @returns {any}
   */
  _parseValue(rawValue) {
    if (rawValue == null)
      return null;

    try {
      return JSON.parse(rawValue);
    } catch (_error) {
      console.warn('ValueStoreService: corrupted JSON value, returning null');
      return null;
    }
  }
}
