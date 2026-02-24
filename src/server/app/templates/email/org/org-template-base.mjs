import { MasterEmailTemplate } from '../master-template.mjs';

export class OrgBaseTemplate extends MasterEmailTemplate {
  formatSingularRoleName(roleName) {
    if (roleName.match(/^[aoiue]/i))
      return `an ${roleName}`;
    else
      return `a ${roleName}`;
  }

  getRoleNamesFromRoles(roles) {
    const Role = this.getModel('Role');
    return Role.getRoleDisplayNames(roles, [ 'User' ], [ null, 'Organization' ]);
  }

  formatRoleName(organizationName, roleName) {
    return `${roleName} for Organization ${organizationName}`;
  }

  formatRoleNames(organization, roleNames) {
    let organizationName = organization.name;
    return roleNames.map((roleName) => this.formatRoleName(organizationName, roleName));
  }
}
