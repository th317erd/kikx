'use strict';

import {
  computeKeyFingerprint,
  signValue,
  verifyValue,
} from '../crypto/value-signing.mjs';

// =============================================================================
// ValueStoreService
// =============================================================================
// CRUD operations on the ValueStore model with optional Ed25519 signing
// for tamper detection. Accessed via context.getProperty('valueStoreService').
//
// Values are stored as JSON.stringify(value) and returned as parsed JSON.
// Null/undefined values on set() trigger deletion (idempotent).
// =============================================================================

export class ValueStoreService {
  constructor({ context }) {
    this._context = context;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  _getModels() {
    return this._context.getProperty('models');
  }

  _getKeystore() {
    return this._context.getProperty('keystore');
  }

  // ---------------------------------------------------------------------------
  // get(ownerType, ownerID, namespace, key, options)
  // ---------------------------------------------------------------------------
  // Fetch a single value by composite key.
  // Returns the parsed JSON value, or null if not found or corrupted.
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // set(ownerType, ownerID, namespace, key, value, options)
  // ---------------------------------------------------------------------------
  // Upsert a value. If value is null/undefined, deletes the entry instead.
  // organizationID is required for creation but may be omitted on update.
  // ---------------------------------------------------------------------------

  async set(ownerType, ownerID, namespace, key, value, options = {}) {
    let { scopeID = '', organizationID } = options;

    // null/undefined → delete
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

  // ---------------------------------------------------------------------------
  // getAll(ownerType, ownerID, namespace, options)
  // ---------------------------------------------------------------------------
  // Fetch all entries in a namespace. Returns { key: parsedValue, ... }.
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // setAll(ownerType, ownerID, namespace, entries, options)
  // ---------------------------------------------------------------------------
  // Batch set. entries is { key: value, ... }. Null values delete entries.
  // ---------------------------------------------------------------------------

  async setAll(ownerType, ownerID, namespace, entries, options = {}) {
    let keys = Object.keys(entries);

    for (let i = 0; i < keys.length; i++)
      await this.set(ownerType, ownerID, namespace, keys[i], entries[keys[i]], options);
  }

  // ---------------------------------------------------------------------------
  // delete(ownerType, ownerID, namespace, key, options)
  // ---------------------------------------------------------------------------
  // Delete a single entry. Idempotent — missing key is not an error.
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // search(ownerType, ownerID, namespace, query, options)
  // ---------------------------------------------------------------------------
  // Search entries by key name and/or value content.
  // - scopeID undefined/null → all scopes
  // - scopeID '' → default scope only
  // - query empty/null → list all
  // - query provided → filter key/value with substring match
  // Returns [{ key, value, scopeID, updatedAt }, ...] with limit/offset.
  // ---------------------------------------------------------------------------

  async search(ownerType, ownerID, namespace, query, options = {}) {
    let { scopeID, limit = 20, offset = 0 } = options;
    let { ValueStore } = this._getModels();

    let queryBuilder = ValueStore
      .where.ownerType.EQ(ownerType)
      .ownerID.EQ(ownerID)
      .namespace.EQ(namespace);

    // scopeID filtering: undefined/null → all scopes; '' → default scope only
    if (scopeID != null)
      queryBuilder = queryBuilder.scopeID.EQ(scopeID);

    let entries = await queryBuilder.all();

    // In-JS filtering for LIKE matching on key and value content
    let filtered = entries;

    if (query) {
      let lowerQuery = query.toLowerCase();

      filtered = entries.filter((entry) => {
        let keyMatch   = entry.key.toLowerCase().includes(lowerQuery);
        let valueMatch = (entry.value != null) && entry.value.toLowerCase().includes(lowerQuery);

        return keyMatch || valueMatch;
      });
    }

    // Apply offset and limit
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

  // ---------------------------------------------------------------------------
  // setSigned(ownerType, ownerID, namespace, key, value, privateKeyPEM, publicKeyPEM, options)
  // ---------------------------------------------------------------------------
  // Sign the value with an Ed25519 private key before storing.
  // The signature covers the full composite key + value to prevent replay.
  // Stores the signing key fingerprint for key rotation detection.
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // getVerified(ownerType, ownerID, namespace, key, publicKeyPEM, options)
  // ---------------------------------------------------------------------------
  // Fetch an entry and verify its signature with an Ed25519 public key.
  // Returns { value, signed, verified } or null if entry not found.
  //
  // - signed: true if a signature exists on the entry
  // - verified: true if the signature is valid for the current value+key
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Private: parse JSON value safely
  // ---------------------------------------------------------------------------

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
