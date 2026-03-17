'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Agent
// =============================================================================
// Configured agent instance at org level.
// Has a name, plugin type, encrypted API key, instructions, and config.
// Config is stored in the ValueStore table (ownerType='Agent', namespace='config').
// =============================================================================

const AGENT_DEFAULTS = {};

export class Agent extends ModelBase {
  static version = 3;

  static PROTECTED_KEYS = new Set(['apiKey', 'encryptedAPIKey', 'riskLevel']);

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
    // Ed25519 public key (PEM, always readable)
    publicKey: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Ed25519 private key (PEM, encrypted with SMK-derived key)
    encryptedPrivateKey: {
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
  // Config methods (async — backed by ValueStore table)
  // ---------------------------------------------------------------------------

  async getConfig() {
    let ValueStore = this.getModel('ValueStore');
    let entries = await ValueStore
      .where.ownerType.EQ('Agent')
      .ownerID.EQ(this.id)
      .namespace.EQ('config')
      .scopeID.EQ('')
      .all();

    let config = { ...AGENT_DEFAULTS };
    for (let entry of entries) {
      try {
        config[entry.key] = JSON.parse(entry.value);
      } catch (_e) {
        config[entry.key] = entry.value;
      }
    }

    return config;
  }

  async setConfig(value) {
    let ValueStore = this.getModel('ValueStore');

    // Delete all existing config entries
    let existing = await ValueStore
      .where.ownerType.EQ('Agent')
      .ownerID.EQ(this.id)
      .namespace.EQ('config')
      .scopeID.EQ('')
      .all();

    for (let entry of existing)
      await entry.destroy();

    if (value == null)
      return;

    for (let [key, val] of Object.entries(value)) {
      await ValueStore.create({
        organizationID: this.organizationID,
        ownerType:      'Agent',
        ownerID:        this.id,
        namespace:      'config',
        scopeID:        '',
        key,
        value:          JSON.stringify(val),
      });
    }
  }

  async updateConfig(partial) {
    if (!partial || typeof partial !== 'object' || Object.keys(partial).length === 0)
      return;

    let ValueStore = this.getModel('ValueStore');

    for (let [key, val] of Object.entries(partial)) {
      let existing = await ValueStore
        .where.ownerType.EQ('Agent')
        .ownerID.EQ(this.id)
        .namespace.EQ('config')
        .scopeID.EQ('')
        .key.EQ(key)
        .first();

      if (val == null) {
        if (existing)
          await existing.destroy();

        continue;
      }

      if (existing) {
        existing.value = JSON.stringify(val);
        await existing.save();
      } else {
        await ValueStore.create({
          organizationID: this.organizationID,
          ownerType:      'Agent',
          ownerID:        this.id,
          namespace:      'config',
          scopeID:        '',
          key,
          value:          JSON.stringify(val),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Behaviors convenience methods (async)
  // ---------------------------------------------------------------------------

  async getBehaviors() {
    let config    = await this.getConfig();
    let behaviors = config.behaviors || config.abilities || null;

    if (behaviors == null)
      return null;

    // Behaviors should be a plain text string, but agents may store them as
    // structured objects. Serialize to readable text if needed.
    if (typeof behaviors === 'string')
      return behaviors;

    if (typeof behaviors === 'object')
      return JSON.stringify(behaviors, null, 2);

    return String(behaviors);
  }

  async setBehaviors(text) {
    await this.updateConfig({ behaviors: text });
  }

  async hasBehaviors() {
    let behaviors = await this.getBehaviors();
    return !!behaviors;
  }

  async getSafeConfig() {
    let config = await this.getConfig();

    for (let key of Agent.PROTECTED_KEYS)
      delete config[key];

    return config;
  }
}
