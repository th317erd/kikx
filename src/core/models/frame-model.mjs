'use strict';

import { ModelBase, Types } from './model-base.mjs';
import { createTypedFrame } from '../../shared/frame-types/index.mjs';

// =============================================================================
// Frame
// =============================================================================
// Persistent frame record matching the plan's frame schema (Section 14).
// 20 columns. Denormalized interactionID for efficient loading.
// =============================================================================

export class Frame extends ModelBase {
  static version = 4;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: 'frm_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    sessionID: {
      type:      Types.FOREIGN_KEY('Session:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    // Root ancestor interaction ID (self if top-level).
    // Denormalized for efficient loading.
    interactionID: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    // Immediate parent (NULL if top-level)
    parentID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    // Server-side monotonic counter per session
    order: {
      type:      Types.INTEGER,
      allowNull: false,
      index:     true,
    },
    // Phantom frame grouping
    groupID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    // Phantom group type
    groupType: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    // Frame type
    type: {
      type:      Types.STRING(64),
      allowNull: false,
      index:     true,
    },
    // JSON payload
    content: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // JSON array of targeted frame IDs
    targets: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Author info
    authorType: {
      type:      Types.STRING(32),
      allowNull: true,
    },
    authorID: {
      type:      Types.STRING(128),
      allowNull: true,
    },
    // Visibility flags
    hidden: {
      type:         Types.BOOLEAN,
      allowNull:    false,
      defaultValue: true,
    },
    deleted: {
      type:         Types.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    },
    // Processing state for interaction replay
    processed: {
      type:         Types.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
      index:        true,
    },
    processedAt: {
      type:      Types.DATETIME,
      allowNull: true,
    },
    // Ed25519 signature hex string
    signature: {
      type:      Types.STRING(256),
      allowNull: true,
    },
    // Fingerprint of the signing key (first 32 hex chars of SHA-256(publicKeyPEM))
    signingKeyFingerprint: {
      type:      Types.STRING(64),
      allowNull: true,
    },
    // Plugin state — JSON-serialized per-frame state bag
    state: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Frame timestamp (milliseconds since epoch)
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

  getContent() {
    if (!this.content)
      return null;

    if (typeof this.content === 'string') {
      try {
        return JSON.parse(this.content);
      } catch (error) {
        return this.content;
      }
    }

    return this.content;
  }

  // ---------------------------------------------------------------------------
  // getContentForIndexing() → Array<{ field: string, value: string }>
  // ---------------------------------------------------------------------------
  // Delegates to frame type classes for type-specific extraction logic.
  // Keeps structural guards for DB-level content parsing (null, non-object,
  // broken JSON, arrays) since typed frames expect pre-parsed object content.
  // ---------------------------------------------------------------------------

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
