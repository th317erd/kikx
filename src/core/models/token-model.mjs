'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Token
// =============================================================================
// Tracks token consumption per interaction turn.
// One row per agent response (created on each 'done' event).
// Allows cost aggregation by organization (global), serviceType, and session.
// =============================================================================

/**
 * Token model — tracks token consumption per interaction turn.
 * @see {import('../types').Token}
 */
export class Token extends ModelBase {
  /** @type {number} */
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    /** @type {string} */
    id: {
      type:         Types.XID({ prefix: 'tok_' }),
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
    sessionID: {
      type:      Types.FOREIGN_KEY('Session:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    /** @type {string | null} */
    agentID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    /** @type {string} */
    interactionID: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    /** @type {string} */
    serviceType: {
      type:      Types.STRING(64),
      allowNull: false,
      index:     true,
    },
    /** @type {number} */
    inputTokens: {
      type:         Types.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    /** @type {number} */
    outputTokens: {
      type:         Types.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    /** @type {number} */
    cacheReadInputTokens: {
      type:         Types.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    /** @type {number} */
    cacheCreationInputTokens: {
      type:         Types.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    // Virtual relationships
    session: {
      type: Types.Model('Session', ({ self }, { Session }, userQuery) => {
        return Session.$.id.EQ(self.sessionID).MERGE(userQuery);
      }),
    },
    organization: {
      type: Types.Model('Organization', ({ self }, { Organization }, userQuery) => {
        return Organization.$.id.EQ(self.organizationID).MERGE(userQuery);
      }),
    },
  };
}
