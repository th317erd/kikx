import Nife               from 'nife';
import { PermissionBase } from '../permission-base.mjs';

// This class handles all User permissions

export class UserPermissions extends PermissionBase {
  static getScopeName() {
    return 'User';
  }

  async canUpdate(user) {
    // User can always update themselves
    if (this.currentUser.id === user.id)
      return true;

    let organization = {
      type: 'Organization',
      id:   user.getCurrentOrganizationID() || this.currentUser.getCurrentOrganizationID(),
    };

    if (!organization.id)
      return false;

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

  async canView(user) {
    // User can always view themselves
    if (this.currentUser.id === user.id)
      return true;

    let organization = {
      type: 'Organization',
      id:   user.getCurrentOrganizationID() || this.currentUser.getCurrentOrganizationID(),
    };

    if (!organization.id)
      return false;

    // masteradmins and support users can view anyone
    let currentUserRoles = await this.currentUser.getRolesFor(organization, { names: [ 'masteradmin', 'support', 'superadmin', 'admin', 'member' ], namesOnly: true });
    if (Nife.isEmpty(currentUserRoles))
      return false;

    if (currentUserRoles.indexOf('masteradmin') >= 0)
      return true;

    let targetUserRoles = await user.getRolesFor(organization, { namesOnly: true });

    // A support user can view all except masteradmins
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
