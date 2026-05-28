'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Organization
// =============================================================================
// Top-level tenant. Multi-tenant from day one.
// Equivalent to a Discord Server — contains users, agents, sessions.
// =============================================================================

/**
 * Organization model — top-level tenant containing users, agents, and sessions.
 * @see {import('../types').Organization}
 */
export class Organization extends ModelBase {
  /** @type {number} */
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    /** @type {string} */
    id: {
      type:         Types.XID({ prefix: 'org_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    /** @type {string} */
    name: {
      type:      Types.STRING(128),
      allowNull: false,
      index:     true,
    },
    // Virtual relationships
    users: {
      type: Types.Models('User', ({ self }, { User }, userQuery) => {
        return User.$.organizationID.EQ(self.id).MERGE(userQuery);
      }),
    },
    agents: {
      type: Types.Models('Agent', ({ self }, { Agent }, userQuery) => {
        return Agent.$.organizationID.EQ(self.id).MERGE(userQuery);
      }),
    },
    sessions: {
      type: Types.Models('Session', ({ self }, { Session }, userQuery) => {
        return Session.$.organizationID.EQ(self.id).MERGE(userQuery);
      }),
    },
    roles: {
      type: Types.Models('Role', ({ self }, { Role }, userQuery) => {
        return Role.$.organizationID.EQ(self.id).MERGE(userQuery);
      }),
    },
  };
}
