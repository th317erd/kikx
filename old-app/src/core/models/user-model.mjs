'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// User
// =============================================================================
// A user within an organization.
// Password-only auth with zero-knowledge vault (UMK wrapped by password slot).
// =============================================================================

/**
 * User model — a user within an organization with password-based auth.
 * @see {import('../types').User}
 */

export let USER_DEFAULTS = { riskLevel: 'normal' };
let SIGNED_KEYS          = new Set(['riskLevel']);
let VALID_RISK_LEVELS    = new Set(['strict', 'normal', 'permissive']);

export class User extends ModelBase {
  /** @type {number} */
  static version = 2;

  static fields = {
    ...(ModelBase.fields || {}),
    /** @type {string} */
    id: {
      type:         Types.XID({ prefix: 'usr_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    /** @type {string} */
    organizationID: {
      type:      Types.FOREIGN_KEY('Organization:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    /** @type {string} */
    email: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    /** @type {string | null} */
    firstName: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    /** @type {string | null} */
    lastName: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    // Base64-encoded avatar image (resized to 128x128 max)
    /** @type {string | null} */
    avatar: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Password slot: JSON blob { ciphertext, iv, authTag, salt }
    // Stores UMK encrypted with scrypt-derived key from password
    /** @type {string | null} */
    passwordSlot: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Ed25519 public key (PEM, always readable)
    /** @type {string | null} */
    publicKey: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Ed25519 private key (PEM, encrypted with UMK-derived key)
    /** @type {string | null} */
    encryptedPrivateKey: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Virtual relationships
    organization: {
      type: Types.Model('Organization', ({ self }, { Organization }, userQuery) => {
        return Organization.$.id.EQ(self.organizationID).MERGE(userQuery);
      }),
    },
    roles: {
      type: Types.Models('Role', ({ self }, { Role }, userQuery) => {
        return Role.$.userID.EQ(self.id).MERGE(userQuery);
      }),
    },
  };

  /**
   * @param {...any} args
   * @returns {Promise<void>}
   */
  async onBeforeSave(...args) {
    if (this.email)
      this.email = ('' + this.email).trim().toLowerCase();

    return await super.onBeforeSave(...args);
  }

  /**
   * @returns {string}
   */
  getDisplayName() {
    if (this.firstName && this.lastName)
      return `${this.firstName} ${this.lastName}`;

    if (this.firstName)
      return this.firstName;

    return this.email;
  }

  // ---------------------------------------------------------------------------
  // Settings (ValueStore-backed)
  // ---------------------------------------------------------------------------

  /**
   * @returns {Promise<Record<string, any>>}
   */
  async getSettings() {
    let ValueStore = this.getModel('ValueStore');
    let entries    = await ValueStore
      .where.ownerType.EQ('User')
      .ownerID.EQ(this.id)
      .namespace.EQ('config')
      .scopeID.EQ('')
      .all();

    let settings = { ...USER_DEFAULTS };

    for (let entry of entries) {
      try {
        settings[entry.key] = JSON.parse(entry.value);
      } catch (_e) {
        // Skip corrupted entries
      }
    }

    return settings;
  }

  /**
   * @param {Record<string, any>} partial
   * @param {import('../types').Keystore} keystore
   * @param {string} privateKeyPEM
   * @returns {Promise<void>}
   */
  async updateSettings(partial, keystore, privateKeyPEM) {
    let ValueStore = this.getModel('ValueStore');
    let keys       = Object.keys(partial);

    // Validate: privateKeyPEM required when any key is in SIGNED_KEYS
    if (keys.some((key) => SIGNED_KEYS.has(key)) && !privateKeyPEM)
      throw new Error('privateKeyPEM is required when updating signed settings');

    for (let key of keys) {
      let value = partial[key];

      // Validate riskLevel values
      if (key === 'riskLevel' && value != null && !VALID_RISK_LEVELS.has(value))
        throw new Error(`Invalid riskLevel: "${value}". Must be one of: ${[ ...VALID_RISK_LEVELS ].join(', ')}`);

      // Delete when null/undefined
      if (value == null) {
        let existing = await ValueStore
          .where.ownerType.EQ('User')
          .ownerID.EQ(this.id)
          .namespace.EQ('config')
          .scopeID.EQ('')
          .key.EQ(key)
          .first();

        if (existing)
          await existing.destroy();

        continue;
      }

      // Sign if key is in SIGNED_KEYS
      let signature = null;
      if (SIGNED_KEYS.has(key))
        signature = keystore.signWithPrivateKey(JSON.stringify(value), privateKeyPEM);

      // Upsert
      let existing = await ValueStore
        .where.ownerType.EQ('User')
        .ownerID.EQ(this.id)
        .namespace.EQ('config')
        .scopeID.EQ('')
        .key.EQ(key)
        .first();

      if (existing) {
        existing.value     = JSON.stringify(value);
        existing.signature = signature;
        await existing.save();
      } else {
        await ValueStore.create({
          organizationID: this.organizationID,
          ownerType:      'User',
          ownerID:        this.id,
          namespace:      'config',
          scopeID:        '',
          key,
          value:          JSON.stringify(value),
          signature,
        });
      }
    }
  }

  /**
   * @param {import('../types').Keystore} keystore
   * @param {string} publicKeyPEM
   * @returns {Promise<Record<string, any> | null>}
   */
  async getVerifiedSettings(keystore, publicKeyPEM) {
    let ValueStore = this.getModel('ValueStore');
    let entries    = await ValueStore
      .where.ownerType.EQ('User')
      .ownerID.EQ(this.id)
      .namespace.EQ('config')
      .scopeID.EQ('')
      .all();

    let settings = { ...USER_DEFAULTS };

    for (let entry of entries) {
      if (SIGNED_KEYS.has(entry.key)) {
        if (!entry.signature)
          return null;

        let valid = keystore.verifyWithPublicKey(entry.value, publicKeyPEM, entry.signature);
        if (!valid)
          return null;
      }

      try {
        settings[entry.key] = JSON.parse(entry.value);
      } catch (_e) {
        // Skip corrupted entries
      }
    }

    return settings;
  }
}
