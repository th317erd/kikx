'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Agent
// =============================================================================
// Configured agent instance at org level.
// Has a name, plugin type, encrypted API key, instructions, and config.
// =============================================================================

const AGENT_DEFAULTS = { riskLevel: 'medium' };

export class Agent extends ModelBase {
  static version = 2;

  static PROTECTED_KEYS = new Set(['apiKey', 'encryptedAPIKey']);

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
    // Persisted JSON config (risk level, model preferences, abilities, etc.)
    config: {
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

  // ---------------------------------------------------------------------------
  // Config methods
  // ---------------------------------------------------------------------------

  getConfig() {
    let stored = null;

    if (this.config != null) {
      try {
        stored = JSON.parse(this.config);
      } catch (_e) {
        // Graceful degradation: invalid JSON → defaults
        stored = null;
      }
    }

    if (!stored || typeof stored !== 'object')
      return { ...AGENT_DEFAULTS };

    // Deep-clone to prevent mutation leaking back
    return { ...AGENT_DEFAULTS, ...JSON.parse(JSON.stringify(stored)) };
  }

  setConfig(value) {
    if (value == null) {
      this.config = null;
      return;
    }

    this.config = JSON.stringify(value);
  }

  updateConfig(partial) {
    if (!partial || typeof partial !== 'object' || Object.keys(partial).length === 0)
      return;

    let current = this.getConfig();
    let merged  = { ...current, ...partial };
    this.setConfig(merged);
  }

  // ---------------------------------------------------------------------------
  // Abilities convenience methods
  // ---------------------------------------------------------------------------

  getAbilities() {
    return this.getConfig().abilities || null;
  }

  setAbilities(text) {
    this.updateConfig({ abilities: text });
  }

  hasAbilities() {
    return !!this.getAbilities();
  }

  getSafeConfig() {
    let config = this.getConfig();

    for (let key of Agent.PROTECTED_KEYS)
      delete config[key];

    return config;
  }
}
