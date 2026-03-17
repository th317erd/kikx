'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Token
// =============================================================================
// Tracks token consumption per interaction turn.
// One row per agent response (created on each 'done' event).
// Allows cost aggregation by organization (global), serviceType, and session.
// =============================================================================

export class Token extends ModelBase {
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: 'tok_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    organizationID: {
      type:      Types.FOREIGN_KEY('Organization:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    sessionID: {
      type:      Types.FOREIGN_KEY('Session:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    agentID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    interactionID: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    serviceType: {
      type:      Types.STRING(64),
      allowNull: false,
      index:     true,
    },
    inputTokens: {
      type:         Types.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    outputTokens: {
      type:         Types.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    cacheReadInputTokens: {
      type:         Types.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
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
