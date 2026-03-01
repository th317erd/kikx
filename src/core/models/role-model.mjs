'use strict';

import { ModelBase, Types } from './model-base.mjs';

// =============================================================================
// Role
// =============================================================================
// Org-level role assignment for users.
// Tracks who has what role in which organization.
// =============================================================================

export class Role extends ModelBase {
  static version = 1;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: 'rol_' }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    organizationID: {
      type:      Types.FOREIGN_KEY('Organization:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    userID: {
      type:      Types.FOREIGN_KEY('User:id', { onDelete: 'CASCADE' }),
      allowNull: false,
      index:     true,
    },
    name: {
      type:      Types.STRING(64),
      allowNull: false,
      index:     true,
    },
    // Virtual relationships
    organization: {
      type: Types.Model('Organization', ({ self }, { Organization }, userQuery) => {
        return Organization.$.id.EQ(self.organizationID).MERGE(userQuery);
      }),
    },
    user: {
      type: Types.Model('User', ({ self }, { User }, userQuery) => {
        return User.$.id.EQ(self.userID).MERGE(userQuery);
      }),
    },
  };
}
