'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// ValueStore
// =============================================================================
// Unified key-value store for agent config, session context, and user settings.
// Replaces inline JSON blob columns with a normalized, queryable table.
//
// Composite indexes:
//   - [ownerType, ownerID, namespace, scopeID, key] — lookup + uniqueness
//   - [ownerType, namespace, key] — cross-owner queries
//   - [ownerType, ownerID, namespace, scopeID] — namespace listing
//
// NOTE: Mythix ORM does not support composite UNIQUE indexes declaratively.
// Uniqueness on (ownerType, ownerID, namespace, scopeID, key) is enforced
// via the composite index on `key` below. If the underlying database needs
// a true UNIQUE constraint, apply it via a migration or raw SQL.
// =============================================================================

export class ValueStore extends ModelBase {
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: 'vs_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    organizationID: {
      type:      Types.FOREIGN_KEY('Organization:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    ownerType: {
      type:      Types.STRING(32),
      allowNull: false,
      index:     true,
    },
    ownerID: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    namespace: {
      type:      Types.STRING(64),
      allowNull: false,
      index:     true,
    },
    scopeID: {
      type:         Types.STRING(128),
      allowNull:    false,
      defaultValue: '',
      index:        true,
    },
    key: {
      type:      Types.STRING(256),
      allowNull: false,
      index:     [true, 'ownerType', 'ownerID', 'namespace', 'scopeID'],
    },
    value: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    signature: {
      type:      Types.STRING(256),
      allowNull: true,
    },
    signingKeyFingerprint: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    note: {
      type:      Types.STRING(256),
      allowNull: true,
      index:     true,
    },
    type: {
      type:      Types.STRING(64),
      allowNull: true,
      index:     true,
    },
  };
}
