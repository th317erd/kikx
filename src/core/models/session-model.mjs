'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Session
// =============================================================================
// A chat session within an organization.
// Contains participants and a FrameManager instance.
// =============================================================================

export class Session extends ModelBase {
  static version = 1;

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
  };
}
