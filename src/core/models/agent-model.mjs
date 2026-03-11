'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Agent
// =============================================================================
// Configured agent instance at org level.
// Has a name, plugin type, encrypted API key, and instructions.
// =============================================================================

export class Agent extends ModelBase {
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: 'agt_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    organizationID: {
      type:      Types.FOREIGN_KEY('Organization:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    name: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    // Which agent plugin type (e.g., "claude-agent", "openai-agent")
    pluginID: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    // Encrypted API key: JSON blob { ciphertext, iv, authTag }
    // Encrypted with per-user key derived from UMK
    encryptedAPIKey: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Agent instructions (system prompt additions)
    instructions: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // DM-derived summary (auto-generated from DM sessions)
    dmSummary: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Virtual relationships
    organization: {
      type: Types.Model('Organization', ({ self }, { Organization }, userQuery) => {
        return Organization.$.id.EQ(self.organizationID).MERGE(userQuery);
      }),
    },
  };

  getConfig() {
    return { riskLevel: 'medium' };
  }
}
