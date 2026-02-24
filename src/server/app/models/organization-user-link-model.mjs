import { Types }        from 'mythix';
import { TaggableBase } from './taggable-base.mjs';
import Utils            from '../utils/index.mjs';

// This model has two primary purposes:
// 1) It links users to organizations, and
// 2) It stores information related to the
// user/org combo. For example, the user's
// avatar is different per-organization,
// so it is stored here. Tags for users
// are also stored against this model.
//
// Notes: "userAvatarURL" is a "base URL",
// and is NOT a complete URL. To actually
// get the full URL to the user's avatar,
// a "size" for the avatar must be supplied
// along with the file extension of ".png".
// User avatars are ALWAYS uploaded to S3
// as ".png" images, regardless of their
// original format when uploaded.

export class OrganizationUserLink extends TaggableBase {
  static fields = {
    ...(TaggableBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: Utils.getModelIDPrefixFor('OrganizationUserLink') }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    userID: {
      type:         Types.FOREIGN_KEY('User:id', {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
      allowNull:    false,
      index:        true,
    },
    organizationID: {
      type:         Types.FOREIGN_KEY('Organization:id', {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
      allowNull:    false,
      index:        true,
    },
    userSuspended: {
      type:         Types.BOOLEAN,
      defaultValue: false,
      allowNull:    false,
      index:        true,
    },
    userAvatarURL: {
      // eslint-disable-next-line no-magic-numbers
      type:         Types.STRING(512),
      defaultValue: null,
      allowNull:    true,
    },
    email: {
      type:         Types.STRING(64),
      allowNull:    true,
      index:        true,
      unique:       true,
    },
    phone: {
      type:         Types.STRING(32),
      allowNull:    true,
      index:        true,
    },
    firstName: {
      type:         Types.STRING(32),
      allowNull:    true,
      index:        true,
    },
    lastName: {
      type:         Types.STRING(32),
      allowNull:    true,
      index:        true,
    },
    user: {
      type:         Types.Model('User', ({ self }, { User }, userQuery) => {
        return User.$.id.EQ(self.userID).MERGE(userQuery);
      }),
    },
    organization: {
      type:         Types.Model('Organization', ({ self }, { Organization }, userQuery) => {
        return Organization.$.id.EQ(self.organizationID).MERGE(userQuery);
      }),
    },
    roles: {
      type:         Types.Models('Role', ({ self }, { Role, OrganizationUserLink }, userQuery) => {
        return Role
            .$.ownerID
              .EQ(OrganizationUserLink.$.id)
            .ownerType
              .EQ('OrganizationUserLink')
            .OrganizationUserLink.organizationID
              .EQ(self.id)
            .MERGE(userQuery);
      }),
    },
  };

  async onBeforeRoleAdded(user, roleName, options) {
    let modelName         = this.getModelName();
    let Role              = this.getModel('Role');
    let primaryRoleNames  = Role.getPrimaryRoleNames([ modelName ]);

    if (primaryRoleNames.indexOf(roleName) < 0)
      return;

    // Remove all primary roles before adding a new primary role
    await Role.$.ownerType.EQ(modelName).ownerID.EQ(this.id).name.EQ(primaryRoleNames).destroy(options);
  }
}
