'use strict';

import { ModelBase, Types } from './model-base.mjs';
import { createTypedFrame } from '../../shared/frame-types/index.mjs';
import { safeParseJSON }    from '../lib/utils.mjs';

// =============================================================================
// Frame
// =============================================================================
// Persistent frame record matching the plan's frame schema (Section 14).
// 20 columns. Denormalized interactionID for efficient loading.
// =============================================================================

/**
 * Frame model — persistent frame record for session messages and events.
 * @see {import('../types').FrameData}
 */
export class Frame extends ModelBase {
  /** @type {number} */
  static version = 4;

  static fields = {
    ...(ModelBase.fields || {}),
    /** @type {string} */
    id: {
      type:         Types.XID({ prefix: 'frm_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    /** @type {string} */
    sessionID: {
      type:      Types.FOREIGN_KEY('Session:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    // Root ancestor interaction ID (self if top-level).
    // Denormalized for efficient loading.
    /** @type {string} */
    interactionID: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    // Immediate parent (NULL if top-level)
    /** @type {string | null} */
    parentID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    // Server-side monotonic counter per session
    /** @type {number} */
    order: {
      type:      Types.INTEGER,
      allowNull: false,
      index:     true,
    },
    // Phantom frame grouping
    /** @type {string | null} */
    groupID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    // Phantom group type
    /** @type {string | null} */
    groupType: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    // Frame type
    /** @type {import('../types').FrameType} */
    type: {
      type:      Types.STRING(64),
      allowNull: false,
      index:     true,
    },
    // JSON payload
    /** @type {string | null} */
    content: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // JSON array of targeted frame IDs
    /** @type {string | null} */
    targets: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Author info
    /** @type {string | null} */
    authorType: {
      type:      Types.STRING(32),
      allowNull: true,
    },
    /** @type {string | null} */
    authorID: {
      type:      Types.STRING(128),
      allowNull: true,
    },
    // Visibility flags
    /** @type {boolean} */
    hidden: {
      type:         Types.BOOLEAN,
      allowNull:    false,
      defaultValue: true,
    },
    /** @type {boolean} */
    deleted: {
      type:         Types.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    },
    // Processing state for interaction replay
    /** @type {boolean} */
    processed: {
      type:         Types.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
      index:        true,
    },
    /** @type {Date | null} */
    processedAt: {
      type:      Types.DATETIME,
      allowNull: true,
    },
    // Ed25519 signature hex string
    /** @type {string | null} */
    signature: {
      type:      Types.STRING(256),
      allowNull: true,
    },
    // Fingerprint of the signing key (first 32 hex chars of SHA-256(publicKeyPEM))
    /** @type {string | null} */
    signingKeyFingerprint: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    // Plugin state — JSON-serialized per-frame state bag
    /** @type {string | null} */
    state: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Frame timestamp (milliseconds since epoch)
    /** @type {number} */
    timestamp: {
      type:      Types.BIGINT,
      allowNull: false,
    },
    // Virtual relationships
    session: {
      type: Types.Model('Session', ({ self }, { Session }, userQuery) => {
        return Session.$.id.EQ(self.sessionID).MERGE(userQuery);
      }),
    },
  };

  /**
   * @returns {Record<string, any> | string | null}
   */
  getContent() {
    if (!this.content)
      return null;

    return safeParseJSON(this.content, this.content);
  }

  // ---------------------------------------------------------------------------
  // getContentForIndexing() → Array<{ field: string, value: string }>
  // ---------------------------------------------------------------------------
  // Delegates to frame type classes for type-specific extraction logic.
  // Keeps structural guards for DB-level content parsing (null, non-object,
  // broken JSON, arrays) since typed frames expect pre-parsed object content.
  // ---------------------------------------------------------------------------

  /**
   * @returns {Array<{ field: string, value: string }>}
   */
  getContentForIndexing() {
    let content;

    try {
      content = this.getContent();
    } catch (_error) {
      return [];
    }

    if (content == null)
      return [];

    // Non-object content (raw string from broken JSON, plain text, etc.)
    if (typeof content !== 'object') {
      let raw = String(content);
      if (!raw)
        return [];

      return [{ field: 'content', value: raw }];
    }

    // Array content — stringify as default
    if (Array.isArray(content))
      return [{ field: 'content', value: JSON.stringify(content) }];

    // Delegate to frame type class for type-specific extraction
    let typed   = createTypedFrame({ type: this.type, content }, null);
    let entries = typed.getContentForIndexing();

    if (!entries || entries.length === 0)
      return [];

    // Map { content_text, content_html } → { field, value }
    return entries
      .map((entry) => {
        let value = entry.content_text || entry.content_html;
        if (!value)
          return null;

        return { field: 'content', value: String(value) };
      })
      .filter(Boolean);
  }

  /**
   * @returns {string[]}
   */
  getTargets() {
    if (!this.targets)
      return [];

    if (typeof this.targets === 'string') {
      try {
        return JSON.parse(this.targets);
      } catch (error) {
        return [];
      }
    }

    return this.targets;
  }
}
