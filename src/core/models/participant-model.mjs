'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Participant
// =============================================================================
// An agent instance bound to a session, with optional alias/overrides.
// Represents the "agent IN a session" concept from the plan.
// =============================================================================

export class Participant extends ModelBase {
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: 'prt_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    sessionID: {
      type:      Types.FOREIGN_KEY('Session:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    agentID: {
      type:      Types.FOREIGN_KEY('Agent:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    // Session-level alias (e.g., "/invite @claude as BobTheBurgerGuy")
    alias: {
      type:      Types.STRING(128),
      allowNull: true,
    },
    // Session-level instruction overrides (JSON)
    overrides: {
      type:      Types.TEXT('long'),
      allowNull: true,
    },
    // Virtual relationships
    session: {
      type: Types.Model('Session', ({ self }, { Session }, userQuery) => {
        return Session.$.id.EQ(self.sessionID).MERGE(userQuery);
      }),
    },
    agent: {
      type: Types.Model('Agent', ({ self }, { Agent }, userQuery) => {
        return Agent.$.id.EQ(self.agentID).MERGE(userQuery);
      }),
    },
  };

  getDisplayName() {
    return this.alias || null;
  }
}
