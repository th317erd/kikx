'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Participant
// =============================================================================
// An agent instance bound to a session.
// Pure join table: { id, sessionID, agentID, createdAt, updatedAt }.
// =============================================================================

/**
 * Participant model — binds an agent to a session with a role.
 * @see {import('../types').Participant}
 */
export class Participant extends ModelBase {
  /** @type {number} */
  static version = 2;

  static fields = {
    ...(ModelBase.fields || {}),
    /** @type {string} */
    id: {
      type:         Types.XID({ prefix: 'prt_' }),
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
    /** @type {string} */
    agentID: {
      type:      Types.FOREIGN_KEY('Agent:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    /** @type {string} */
    role: {
      type:         Types.STRING(32),
      defaultValue: 'member',
      allowNull:    false,
      index:        true,
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
}
