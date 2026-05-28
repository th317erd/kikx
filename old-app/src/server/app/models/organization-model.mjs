/* eslint-disable camelcase */

import Nife           from 'nife';
import { DateTime }   from 'luxon';
import { Types }      from 'mythix';
import { ModelBase }  from './model-base.mjs';
import Utils          from '../utils/index.mjs';

export class Organization extends ModelBase {
  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: Utils.getModelIDPrefixFor('Organization') }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    name: {
      type:         Types.STRING(128),
      allowNull:    false,
      index:        true,
    },
    organizationLinks: {
      type:         Types.Models('OrganizationUserLink', ({ self }, { OrganizationUserLink }, userQuery) => {
        return OrganizationUserLink.$.DISTINCT.organizationID.EQ(self.id).MERGE(userQuery);
      }),
    },
    users: {
      type:         Types.Models('User', ({ self }, { User, OrganizationUserLink }, userQuery) => {
        return User
            .$.DISTINCT
            .id
              .EQ(OrganizationUserLink.$.userID)
            .AND
            .OrganizationUserLink.organizationID
              .EQ(self.id)
            .MERGE(userQuery);
      }),
    },
    userRoles: {
      type:         Types.Models('Role', ({ self }, { Role }, userQuery) => {
        return Role
            .$.DISTINCT
            .targetID
              .EQ(self.id)
            .targetType
              .EQ('Organization')
            .sourceType
              .EQ('User')
            .MERGE(userQuery);
      }),
    },
  };

  async serializeAttributes() {
    return this.toJSON();
  }

  // Invite a user to an organization.
  // Right now inviting a user will automatically
  // add them to the organization. The invited
  // user will then get an email letting them
  // "accept" the invite (although, really, since
  // they have already been added to the organization,
  // the link in the email they will receive is simply,
  // a login link specifying the target organization).
  async inviteUser(invitedByUser, email, _roles, _options) {
    const { User, Role } = this.getModels();

    let options = _options || {};
    let roles = Nife.toArray(_roles).concat([ 'member' ]).filter((role) => {
      if (Nife.isEmpty(role) || !Nife.instanceOf(role, 'string'))
        return false;

      return true;
    });

    // Ensure no user roles are given
    // that the invitingUser doesn't have themselves.
    // Here we are getting all the roles for this organization
    // and also any "non-organization" roles. For example,
    // if a masteradmin is inviting another user to be
    // a masteradmin, then we need to know that (and
    // masteradmin role types aren't tied to an organization).
    let invitingUserOrgRoles  = (invitedByUser && options.noRoleCheck !== true) ? (await invitedByUser.getRolesFor(this, Object.assign({}, options, { namesOnly: true }))) : [];
    let isSupportStaff        = (invitingUserOrgRoles.indexOf('masteradmin') >= 0 || invitingUserOrgRoles.indexOf('support') >= 0);

    // Now filter out roles that the inviting user
    // doesn't have
    if (!isSupportStaff && Nife.isNotEmpty(invitingUserOrgRoles)) {
      roles = Nife.uniq(roles.filter((role) => {
        if (role === 'member')
          return true;

        if (invitingUserOrgRoles.indexOf(role) < 0)
          return false;

        return true;
      }));
    }

    // Try to load the user from the DB
    let user                          = await User.$.email.EQ(email).first(null, options);
    let userCreated                   = false;
    let isAlreadyMemberOfOrganization = false;
    let currentUserRoles              = [];
    let addedUserRoles                = [];

    if (!user) {
      userCreated = true;
      user = await User.create({ email }, options);
      await this.addUser(user, Object.assign({}, options, { userRole: 'member' }));

      addedUserRoles = currentUserRoles = [ 'member' ];
    } else {
      // Now load the users roles for this organization
      currentUserRoles = await user.getRolesFor(this, Object.assign({}, options, { namesOnly: true }));
      isAlreadyMemberOfOrganization = await user.isMemberOfOrganization(this.id, options);
    }

    // Now subtract any roles they might already have
    roles = Nife.arraySubtract(Nife.uniq(roles), currentUserRoles);

    // Add missing roles
    if (Nife.isNotEmpty(roles)) {
      // We need to split apart the role names such
      // that the primary role names are separate from
      // the secondary role names. This is because we
      // can only have one primary role for the user.
      // So we ensure here that we only have one primary
      // role for the user, and that the primary role
      // added is the highest provided.
      let roleDefinitions   = Role.getRoleDefinitionsForRoleNames(roles, [ 'User' ], [ null, 'Organization' ]);
      let primaryRoleNames  = roleDefinitions.filter((roleDefinition) => {
        return (roleDefinition.isPrimaryRole);
      }).map((roleDefinition) => roleDefinition.name);

      let secondaryRoleNames = roleDefinitions.filter((roleDefinition) => {
        return (!roleDefinition.isPrimaryRole);
      }).map((roleDefinition) => roleDefinition.name);

      let highestPrimaryRoleName = Role.getHighestLevelRoleName(primaryRoleNames, [ 'User' ], [ null, 'Organization' ], { primaryRoles: true });

      roles = Nife.uniq(([ highestPrimaryRoleName ].concat(secondaryRoleNames)).filter(Boolean));

      addedUserRoles = roles;

      for (let i = 0, il = roles.length; i < il; i++) {
        let role = roles[i];
        await Role.createFor(user, role, this, options);
      }
    } else if (isAlreadyMemberOfOrganization) {
      return { status: 'not-modified', user, addedRoles: [] }; // Already part of organization
    }

    if (isAlreadyMemberOfOrganization) {
      await user.sendEmail('org/userRolesUpdated', {
        initiatingUser:   invitedByUser,
        organization:     this,
        targetUser:       user,
        addedRoles:       addedUserRoles,
      });

      return { status: 'modified', user, addedRoles: addedUserRoles };
    } else {
      // eslint-disable-next-line no-magic-numbers
      let { magicLinkURL } = await user.generateSessionToken({
        ...options,
        scope:      (addedUserRoles.indexOf('masteradmin') >= 0 || addedUserRoles.indexOf('support') >= 0) ? 'a' : 'u',
        // eslint-disable-next-line no-magic-numbers
        expiresAt:  Math.floor(DateTime.now().plus({ hours: 72 }).toMillis() / 1000.0),
      });

      await user.sendEmail('auth/signUp', {
        initiatingUser:   invitedByUser,
        organization:     this,
        roles:            addedUserRoles,
        magicLinkURL,
      });

      return { status: (userCreated) ? 'created' : 'modified', user, addedRoles: addedUserRoles };
    }
  }

  async addUser(user, _options) {
    const Role  = this.getModel('Role');
    let options = _options || {};

    return await this.getConnection().transaction(async () => {
      let userRole = options.userRole || 'member';

      if (userRole !== 'masteradmin' && userRole !== 'support') {
        let result      = await this.addToUsers(user);
        let resultUser  = result[0];
        if (!resultUser)
          throw new Error('Organization::addUser: Failed while adding user to organization.');
      }

      return await Role.createFor(user, userRole, this);
    }, _options);
  }

  async removeUser(user, _options) {
    return await this.getConnection().transaction(async () => {
      let Role = this.getModel('Role');

      let destroyOrgRolesQuery = Role
          .$.sourceID
            .EQ(user.id)
          .sourceType
            .EQ('User')
          .targetID
            .EQ(this.id)
          .targetType
            .EQ('Organization');

      await destroyOrgRolesQuery.destroy();

      let result = await this.removeFromUsers(user);
      return result;
    }, _options);
  }

  async searchUsers(_options) {
    const {
      OrganizationUserLink,
      Role,
      User,
      Tag,
    } = this.getModels();

    let options = _options || {};
    let {
      filter,
      limit,
      order,
      offset,
    } = options;

    if (limit == null)
    // eslint-disable-next-line no-magic-numbers
      limit = 20;

    if (order == null)
      order = [ '+User:firstName', '+User:lastName' ];

    if (offset == null)
      offset = 0;

    let requestingUser    = options.requestingUser;
    let isSupportStaff    = false;
    let disallowRoleNames = [];
    let organizationID;
    let filterRoles;
    let filterTags;
    let userQuery;
    let roleQuery;
    let highestRole;

    if (requestingUser) {
      let userRoles = await requestingUser.getRolesFor(this, { namesOnly: true });
      highestRole = Role.getHighestLevelRoleName(userRoles, [ 'User' ], [ null, 'Organization' ], { primaryRoles: true });

      disallowRoleNames = Role.getHigherLevelRoleNames(highestRole, [ 'User' ], [ null, 'Organization' ], { primaryRoles: true });
      isSupportStaff    = (highestRole === 'masteradmin' || highestRole === 'support');

      // Don't allow a user to see similar roles to theirs
      if ([ 'support', 'superadmin', 'admin' ].indexOf(highestRole) >= 0)
        disallowRoleNames = Nife.uniq([ highestRole ].concat(disallowRoleNames));
    }

    if (Nife.isNotEmpty(filter)) {
      organizationID = filter.organizationID;
      delete filter['organizationID'];

      // Remove user "roles" from filter
      // and move them to "filterRoles"
      // to be applied to the Roles "where" scope
      filterRoles = Nife.toArray(filter.roles).filter(Boolean);
      delete filter['roles'];

      // Remove user "tags" from filter
      // and move them to "filterTags"
      // to be applied to the Tags "where" scope
      filterTags = Nife.toArray(filter.tags).filter(Boolean).map(Tag._sanitizeTagName);
      delete filter['tags'];

      if (Nife.isNotEmpty(filter)) {
        let orgUserLinkFilter = { ...filter };
        orgUserLinkFilter.userID = orgUserLinkFilter.id;
        delete orgUserLinkFilter.id;

        userQuery = User.where
                        .DISTINCT
                        .LEFT_JOIN.id
                          .EQ(OrganizationUserLink.where.userID)
                        .AND(
                          User.where
                          .AND(this.generateQueryFromFilter(User, filter))
                          .OR(this.generateQueryFromFilter(OrganizationUserLink, orgUserLinkFilter)),
                        );
      }
    }

    if (userQuery == null)
      userQuery = User.where;

    userQuery = userQuery.AND.INNER_JOIN.id.EQ(Role.$.sourceID).AND.Role.sourceType.EQ('User');
    roleQuery = Role.where;

    // Now apply role filters to our query
    if (Nife.isNotEmpty(disallowRoleNames)) {
      roleQuery = roleQuery.AND.NOT.name.EQ(disallowRoleNames);
      filterRoles = Nife.arraySubtract(filterRoles, disallowRoleNames).filter(Boolean);

      // If we have a requesting user, ensure they
      // can see themselves
      if (requestingUser)
        roleQuery = roleQuery.OR.sourceID.EQ(requestingUser.id);
    }

    if (Nife.isNotEmpty(filterRoles))
      roleQuery = roleQuery.AND.name.EQ(filterRoles);

    if (!isSupportStaff) {
      // Non-support staff can only view
      // users in this organization
      roleQuery = roleQuery.AND(Role.$.targetID.EQ(this.id).targetType.EQ('Organization'));
    } else if (organizationID) {
      // Support staff will view all users
      // by default, even those not part of
      // an organization... this is to filter
      // to a specific organization if the
      // user requested we do so.
      roleQuery = roleQuery.AND(
        Role.$
            .AND(Role.$.targetID.EQ(organizationID).targetType.EQ('Organization'))
            .OR(Role.$.targetID.EQ(null).targetType.EQ(null)),
      );
    }

    // Filter on tags as well
    if (Nife.isNotEmpty(filterTags))
      userQuery = userQuery.AND.User.INNER_JOIN.id.EQ(Tag.$.sourceID).AND(Tag.$.sourceType.EQ('User').targetID.EQ(this).targetType.EQ('Organization').name.EQ(filterTags));

    // Now fetch users, using the organizationUserLinks
    // as a sub-query
    userQuery = userQuery.AND.User.id.AND(roleQuery);
    userQuery = userQuery.LIMIT(limit).OFFSET(offset).ORDER(order);

    return await userQuery.all(options);
  }
}
