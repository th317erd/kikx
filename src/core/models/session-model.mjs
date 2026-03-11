'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Session
// =============================================================================
// A chat session within an organization.
// Contains participants and a FrameManager instance.
// =============================================================================

export class Session extends ModelBase {
  static version = 2;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: 'ses_' }),
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
      type:         Types.STRING(256),
      allowNull:    false,
      defaultValue: 'New Session',
    },
    // Session type: 'chat' (default) or 'dm' (direct message for agent config)
    type: {
      type:         Types.STRING(32),
      allowNull:    false,
      defaultValue: 'chat',
      index:        true,
    },
    // For DM sessions: the agent this DM configures
    dmAgentID: {
      type:      Types.STRING(128),
      allowNull: true,
      index:     true,
    },
    archived: {
      type:         Types.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
      index:        true,
    },
    // Links sub-sessions to their parent session
    parentSessionID: {
      type:         Types.FOREIGN_KEY('Session:id', { onDelete: 'CASCADE' }),
      allowNull:    true,
      defaultValue: null,
      index:        true,
    },
    // The frame ID in the parent session representing this sub-session (session-link bubble).
    // Not a FK because the frame lives in a different session's partition.
    linkedFrameID: {
      type:         Types.STRING(128),
      allowNull:    true,
      defaultValue: null,
      index:        true,
    },
    // Maximum number of agent-authored commits allowed before the session is constrained.
    // null means unconstrained (no limit).
    maxInteractions: {
      type:         Types.INTEGER,
      allowNull:    true,
      defaultValue: null,
    },
    // Deadline after which the session is constrained.
    // null means unconstrained (no time limit).
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
}
