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

/**
 * ValueStore model — unified key-value store for agent config, session context, and user settings.
 * @see {import('../types').ValueStoreEntry}
 */
export class ValueStore extends ModelBase {
  /** @type {number} */
  static version = 1;

  // ---------------------------------------------------------------------------
  // Solr indexing — best-effort, never blocks or fails the DB write
  // ---------------------------------------------------------------------------

  /**
   * @param {*} _context
   * @returns {Promise<void>}
   */
  async onAfterSave(_context) {
    try {
      let application = this.constructor.getApplication?.();
      if (!application)
        return;

      let solrService = application.getContext?.()?.getProperty?.('solrService');
      if (!solrService)
        return;

      let document = {
        id:         this.id,
        doc_type:   'value_store',
        type:       this.type || null,
        namespace:  this.namespace || null,
        sessionID:  this.scopeID || null,
        authorType: this.ownerType || null,
        authorID:   this.ownerID || null,
        note:       this.note || null,
        content:    this.value || null,
        timestamp:  (this.createdAt) ? new Date(this.createdAt).getTime() : Date.now(),
        hidden:     false,
        archived:   false,
      };

      await solrService.indexDocuments(document);
    } catch (error) {
      console.error('[SolrIndexing] ValueStore index failed:', this.id, error.message);
    }
  }

  static fields = {
    ...(ModelBase.fields || {}),
    /** @type {string} */
    id: {
      type:         Types.XID({ prefix: 'vs_' }),
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
    ownerType: {
      type:      Types.STRING(32),
      allowNull: false,
      index:     true,
    },
    /** @type {string} */
    ownerID: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    /** @type {string} */
    namespace: {
      type:      Types.STRING(64),
      allowNull: false,
      index:     true,
    },
    /** @type {string} */
    scopeID: {
      type:         Types.STRING(128),
      allowNull:    false,
      defaultValue: '',
      index:        true,
    },
    /** @type {string} */
    key: {
      type:      Types.STRING(256),
      allowNull: false,
      index:     [true, 'ownerType', 'ownerID', 'namespace', 'scopeID'],
    },
    /** @type {string | null} */
    value: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    /** @type {string | null} */
    signature: {
      type:      Types.STRING(256),
      allowNull: true,
    },
    /** @type {string | null} */
    signingKeyFingerprint: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    /** @type {string | null} */
    note: {
      type:      Types.STRING(256),
      allowNull: true,
      index:     true,
    },
    /** @type {string | null} */
    type: {
      type:      Types.STRING(64),
      allowNull: true,
      index:     true,
    },
  };
}
