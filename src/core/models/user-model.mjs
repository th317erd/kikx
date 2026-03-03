'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// User
// =============================================================================
// A user within an organization.
// Password-only auth with zero-knowledge vault (UMK wrapped by password slot).
// =============================================================================

export class User extends ModelBase {
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: 'usr_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    organizationID: {
      type:      Types.FOREIGN_KEY('Organization:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    email: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    firstName: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    lastName: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    // Base64-encoded avatar image (resized to 128x128 max)
    avatar: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Password slot: JSON blob { ciphertext, iv, authTag, salt }
    // Stores UMK encrypted with scrypt-derived key from password
    passwordSlot: {
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

  async onBeforeSave(...args) {
    if (this.email)
      this.email = ('' + this.email).trim().toLowerCase();

    return await super.onBeforeSave(...args);
  }

  getDisplayName() {
    if (this.firstName && this.lastName)
      return `${this.firstName} ${this.lastName}`;

    if (this.firstName)
      return this.firstName;

    return this.email;
  }
}
