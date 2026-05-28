import Nife               from 'nife';
import { PermissionBase } from '../permission-base.mjs';

// This class handles all Organization permissions

export class OrganizationPermissions extends PermissionBase {
  static getScopeName() {
    return 'Organization';
  }

  // eslint-disable-next-line no-unused-vars
  async canCreate(organizationParams) {
    // Support staff and masteradmins can create organizations
    if (await this.currentUser.hasRolesFor(null, { names: [ 'support', 'masteradmin' ] }))
      return true;

    return false;
  }

  // eslint-disable-next-line no-unused-vars
  async canUpdate(organization, organizationParams) {
    // Support staff and masteradmins can modify anything
    // superadmins are allowed to update organizations they
    // are part of
    if (await this.currentUser.hasRolesFor(organization, { names: [ 'support', 'masteradmin', 'superadmin' ] }))
      return true;

    return false;
  }

  // Used to see if the user can "view" organization
  async canView(organization) {
    // Support staff and masteradmins can view anything
    if (await this.currentUser.hasRolesFor(organization, { names: [ 'support', 'masteradmin' ] }))
      return true;

    // Is user a member of this organization?
    if (await this.currentUser.isMemberOfOrganization(organization))
      return true;

    // If user is not a member of this organization
    // then they are not allowed to do anything with it
    return false;
  }

  async canInviteUser(organization) {
    // Support staff and masteradmins can invite anyone
    if (await this.currentUser.hasRolesFor(organization, { names: [ 'support', 'masteradmin' ] }))
      return true;

    // Is user a member of this organization?
    if (!(await this.currentUser.isMemberOfOrganization(organization)))
      return false;

    // Superadmins can always invite users to the organization
    let roles = await this.currentUser.hasRolesFor(organization, {
      namesOnly:  true,
      names:      [ 'superadmin', 'invite-to-organization' ],
      target:     organization,
    });

    if (roles)
      return true;

    return false;
  }

  async canRemoveUser(user, organization) {
    // masteradmins and support users can remove anyone
    let currentUserRoles = await this.currentUser.getRolesFor(organization, { names: [ 'masteradmin', 'support', 'superadmin', 'admin', 'member' ], namesOnly: true });
    if (Nife.isEmpty(currentUserRoles))
      return false;

    if (currentUserRoles.indexOf('masteradmin') >= 0)
      return true;

    let targetUserRoles = await user.getRolesFor(organization, { namesOnly: true });

    // A support user can remove all except masteradmins
    // and other support users
    if (currentUserRoles.indexOf('support') >= 0) {
      if (targetUserRoles.indexOf('masteradmin') >= 0)
        return false;

      if (targetUserRoles.indexOf('support') >= 0)
        return false;

      return true;
    }

    if (Nife.isEmpty(targetUserRoles))
      return false;

    let Role = this.getModel('Role');
    if (Role.compareAllRoles(currentUserRoles, targetUserRoles, [ 'User' ], [ null, 'Organization' ], { primaryRoles: true }) > 0)
      return true;

    return false;
  }

  // eslint-disable-next-line no-unused-vars
  async canUpdateUser(user, organization, userParams) {
    // User can always update themselves
    if (this.currentUser.id === user.id)
      return true;

    // masteradmins and support users can update anyone
    let currentUserRoles = await this.currentUser.getRolesFor(organization, { names: [ 'masteradmin', 'support', 'superadmin', 'admin', 'member' ], namesOnly: true });
    if (Nife.isEmpty(currentUserRoles))
      return false;

    if (currentUserRoles.indexOf('masteradmin') >= 0)
      return true;

    let targetUserRoles = await user.getRolesFor(organization, { namesOnly: true });

    // A support user can update all except masteradmins
    // and other support users
    if (currentUserRoles.indexOf('support') >= 0) {
      if (targetUserRoles.indexOf('masteradmin') >= 0)
        return false;

      if (targetUserRoles.indexOf('support') >= 0)
        return false;

      return true;
    }

    if (Nife.isEmpty(targetUserRoles))
      return false;

    let Role = this.getModel('Role');
    if (Role.compareAllRoles(currentUserRoles, targetUserRoles, [ 'User' ], [ null, 'Organization' ], { primaryRoles: true }) > 0)
      return true;

    return false;
  }
}
