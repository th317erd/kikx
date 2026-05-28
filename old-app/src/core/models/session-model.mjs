'use strict';

import { ModelBase, Types } from './model-base.mjs';
import { safeParseJSON }    from '../lib/utils.mjs';

// =============================================================================
// Session
// =============================================================================
// A chat session within an organization.
// Contains participants and a FrameManager instance.
// =============================================================================

/**
 * Session model — a chat session within an organization.
 * @see {import('../types').Session}
 */
export class Session extends ModelBase {
  /** @type {number} */
  static version = 4;

  static fields = {
    ...(ModelBase.fields || {}),
    /** @type {string} */
    id: {
      type:         Types.XID({ prefix: 'ses_' }),
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
    name: {
      type:         Types.STRING(256),
      allowNull:    false,
      defaultValue: 'New Session',
    },
    // Session type: 'chat' (default) or 'dm' (direct message for agent config)
    /** @type {'chat' | 'dm' | 'self' | string} */
    type: {
      type:         Types.STRING(32),
      allowNull:    false,
      defaultValue: 'chat',
      index:        true,
    },
    // For DM sessions: the agent this DM configures
    /** @type {string | null} */
    dmAgentID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    /** @type {boolean} */
    archived: {
      type:         Types.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
      index:        true,
    },
    // Links sub-sessions to their parent session
    /** @type {string | null} */
    parentSessionID: {
      type:         Types.FOREIGN_KEY('Session:id', { onDelete: 'CASCADE' }),
      allowNull:    true,
      defaultValue: null,
      index:        true,
    },
    // The frame ID in the parent session representing this sub-session (session-link bubble).
    // Not a FK because the frame lives in a different session's partition.
    /** @type {string | null} */
    linkedFrameID: {
      type:         Types.STRING(128),
      allowNull:    true,
      defaultValue: null,
      index:        true,
    },
    // Maximum number of agent-authored commits allowed before the session is constrained.
    // null means unconstrained (no limit).
    /** @type {number | null} */
    maxInteractions: {
      type:         Types.INTEGER,
      allowNull:    true,
      defaultValue: null,
    },
    // Deadline after which the session is constrained.
    // null means unconstrained (no time limit).
    /** @type {Date | null} */
    endsAt: {
      type:         Types.DATETIME,
      allowNull:    true,
      defaultValue: null,
    },
    // Virtual relationships
    organization: {
      type: Types.Model('Organization', ({ self }, { Organization }, userQuery) => {
        return Organization.$.id.EQ(self.organizationID).MERGE(userQuery);
      }),
    },
    participants: {
      type: Types.Models('Participant', ({ self }, { Participant }, userQuery) => {
        return Participant.$.sessionID.EQ(self.id).MERGE(userQuery);
      }),
    },
    parentSession: {
      type: Types.Model('Session', ({ self }, { Session }, userQuery) => {
        return Session.$.id.EQ(self.parentSessionID).MERGE(userQuery);
      }),
    },
    children: {
      type: Types.Models('Session', ({ self }, { Session }, userQuery) => {
        return Session.$.parentSessionID.EQ(self.id).MERGE(userQuery);
      }),
    },
  };

  // ---------------------------------------------------------------------------
  // Context methods (async -- backed by ValueStore table)
  // ---------------------------------------------------------------------------

  /**
   * @returns {Promise<Record<string, any>>}
   */
  async getContext() {
    let ValueStore = this.getModel('ValueStore');
    let entries = await ValueStore
      .where.ownerType.EQ('Session')
      .ownerID.EQ(this.id)
      .namespace.EQ('context')
      .scopeID.EQ('')
      .all();

    let context = {};
    for (let entry of entries) {
      context[entry.key] = safeParseJSON(entry.value, entry.value);
    }

    return context;
  }

  /**
   * @param {Record<string, any> | null} value
   * @returns {Promise<void>}
   */
  async setContext(value) {
    let ValueStore = this.getModel('ValueStore');

    // Delete all existing context entries
    let existing = await ValueStore
      .where.ownerType.EQ('Session')
      .ownerID.EQ(this.id)
      .namespace.EQ('context')
      .scopeID.EQ('')
      .all();

    for (let entry of existing)
      await entry.destroy();

    if (value == null)
      return;

    for (let [key, val] of Object.entries(value)) {
      await ValueStore.create({
        organizationID: this.organizationID,
        ownerType:      'Session',
        ownerID:        this.id,
        namespace:      'context',
        scopeID:        '',
        key,
        value:          JSON.stringify(val),
      });
    }
  }

  /**
   * @param {Record<string, any>} partial
   * @returns {Promise<void>}
   */
  async updateContext(partial) {
    if (!partial || typeof partial !== 'object' || Object.keys(partial).length === 0)
      return;

    let ValueStore = this.getModel('ValueStore');

    for (let [key, val] of Object.entries(partial)) {
      let existing = await ValueStore
        .where.ownerType.EQ('Session')
        .ownerID.EQ(this.id)
        .namespace.EQ('context')
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
          ownerType:      'Session',
          ownerID:        this.id,
          namespace:      'context',
          scopeID:        '',
          key,
          value:          JSON.stringify(val),
        });
      }
    }
  }

  /**
   * @returns {Promise<Record<string, any>>}
   */
  async getEffectiveContext() {
    let Session  = this.getModel('Session');
    let contexts = [];
    let current  = this;

    // Collect contexts from child (this) up to root
    contexts.push(await current.getContext());

    while (current.parentSessionID) {
      let parent = await Session.where.id.EQ(current.parentSessionID).first();
      if (!parent)
        break;

      contexts.push(await parent.getContext());
      current = parent;
    }

    // Merge from root down (deepest child wins)
    contexts.reverse();
    let effective = {};
    for (let ctx of contexts)
      Object.assign(effective, ctx);

    // Return deep-cloned copy
    return JSON.parse(JSON.stringify(effective));
  }
}
