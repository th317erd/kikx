'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Frame
// =============================================================================
// Persistent frame record matching the plan's frame schema (Section 14).
// 20 columns. Denormalized interactionID for efficient loading.
// =============================================================================

export class Frame extends ModelBase {
  static version = 1;

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
