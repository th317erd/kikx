import Nife             from 'nife';
import { Types }        from 'mythix';
import { ModelBase }    from './model-base.mjs';
import ApplicationRoles from '../roles/index.mjs';
import Utils            from '../utils/index.mjs';

// Role models contain only a "name" that is used
// to define roles/permissions as user has.
// Roles CAN optionally have a "target", but don't
// always have a target. For example, "masteradmin"
// and "support" roles have no target, because
// they are "global" roles.
//
// This whole role system is driven from the
// ApplicationRoles that are statically defined.
// A Role with a specific "name" can only be created
// if that "name" is first defined as a role inside
// ApplicationRoles.

export class Role extends ModelBase {
  static ApplicationRoles = ApplicationRoles;

  static fields = {
    ...(ModelBase.fields || {}),
    id: {
      type:         Types.XID({ prefix: Utils.getModelIDPrefixFor('Role') }),
      defaultValue: Types.XID.Default.XID,
      allowNull:    false,
      primaryKey:   true,
    },
    name: {
      type:         Types.STRING(64),
      allowNull:    false,
      index:        true,
    },
    sourceType: {
      type:         Types.STRING(64),
      allowNull:    false,
      index:        true,
    },
    sourceID: {
      // eslint-disable-next-line no-magic-numbers
      type:         Types.STRING(24),
      allowNull:    false,
      index:        true,
    },
    targetType: {
      type:         Types.STRING(64),
      defaultValue: null,
      allowNull:    true,
      index:        true,
    },
    targetID: {
      // eslint-disable-next-line no-magic-numbers
      type:         Types.STRING(24),
      defaultValue: null,
      allowNull:    true,
      index:        true,
    },
  };

  static roleSourceAndTargetMatches(roleDefinition, _sourceNames, _targetNames) {
    let sourceNames = (_sourceNames == null) ? [ null ] : Nife.toArray(_sourceNames);
    if (Nife.isEmpty(sourceNames))
      sourceNames = [ null ];

    let targetNames = (_targetNames == null) ? [ null ] : Nife.toArray(_targetNames);
    if (Nife.isEmpty(targetNames))
      targetNames = [ null ];

    if (sourceNames.indexOf(roleDefinition.source) < 0)
      return false;

    if (targetNames.indexOf(roleDefinition.target) < 0)
      return false;

    return true;
  }

  static getRoleDefinitions(filterFunc) {
    let roleDefinitions = this.ApplicationRoles;

    if (typeof filterFunc === 'function')
      roleDefinitions = roleDefinitions.filter(filterFunc);
    else
      roleDefinitions = roleDefinitions.slice();

    return roleDefinitions;
  }

  static getRoleDefinition(roleName, sourceNames, targetNames) {
    let roleDefinitions = this.getRoleDefinitions((def) => {
      // eslint-disable-next-line eqeqeq
      if (!this.roleSourceAndTargetMatches(def, sourceNames, targetNames))
        return false;

      if (def.name !== roleName)
        return false;

      return true;
    });

    return roleDefinitions[0];
  }

  static getRoleDefinitionsForRoleNames(_roleNames, sourceNames, targetNames) {
    let roleNames = Nife.toArray(_roleNames).filter(Boolean);

    return this.getRoleDefinitions((def) => {
      // eslint-disable-next-line eqeqeq
      if (!this.roleSourceAndTargetMatches(def, sourceNames, targetNames))
        return false;

      if (roleNames.indexOf(def.name) < 0)
        return false;

      return true;
    });
  }

  static getRoleDisplayName(roleName, sourceNames, targetNames) {
    let roleDefinition = this.getRoleDefinition(roleName, sourceNames, targetNames);
    if (!roleDefinition)
      return;

    return roleDefinition.displayName;
  }

  static getHighestLevelRole(roles, sourceNames, targetNames, options) {
    if (Nife.isEmpty(roles))
      return;

    let roleDefinitions = this.getRoleDefinitions((roleDefinition) => {
      if (!this.roleSourceAndTargetMatches(roleDefinition, sourceNames, targetNames))
        return false;

      if (options && options.primaryRoles === true && roleDefinition.isPrimaryRole !== true)
        return false;

      if (roles.indexOf(roleDefinition.name) < 0)
        return false;

      return true;
    });

    return roleDefinitions[0];
  }

  static getHighestLevelRoleName(roles, sourceNames, targetNames, options) {
    let highestLevelRole = this.getHighestLevelRole(roles, sourceNames, targetNames, options);
    return (highestLevelRole) ? highestLevelRole.name : undefined;
  }

  static getHigherLevelRoles(role, sourceNames, targetNames, options) {
    if (Nife.isEmpty(role))
      return [];

    let roleDefinitions = this.getRoleDefinitions((roleDefinition) => {
      if (!this.roleSourceAndTargetMatches(roleDefinition, sourceNames, targetNames))
        return false;

      if (options && options.primaryRoles === true && roleDefinition.isPrimaryRole !== true)
        return false;

      return true;
    });

    let index = roleDefinitions.findIndex((roleDefinition) => (roleDefinition.name === role));
    if (index >= 0)
      return roleDefinitions.slice(0, index);

    return [];
  }

  static getHigherLevelRoleNames(role, sourceNames, targetNames, options) {
    return this.getHigherLevelRoles(role, sourceNames, targetNames, options).map((roleDefinition) => roleDefinition.name);
  }

  static getLowerLevelRoles(role, sourceNames, targetNames, options) {
    if (Nife.isEmpty(role))
      return [];

    let roleDefinitions = this.getRoleDefinitions((roleDefinition) => {
      if (!this.roleSourceAndTargetMatches(roleDefinition, sourceNames, targetNames))
        return false;

      if (options && options.primaryRoles === true && roleDefinition.isPrimaryRole !== true)
        return false;

      return true;
    });

    let index = roleDefinitions.findIndex((roleDefinition) => (roleDefinition.name === role));
    if (index >= 0)
      return roleDefinitions.slice(index + 1);

    return [];
  }

  static getLowerLevelRoleNames(role, sourceNames, targetNames, options) {
    return this.getLowerLevelRoles(role, sourceNames, targetNames, options).map((roleDefinition) => roleDefinition.name);
  }

  static compareRoles(roleName1, roleName2, sourceNames, targetNames) {
    let def1 = this.getRoleDefinition(roleName1, sourceNames, targetNames);
    if (!def1)
      throw new Error(`Role::compareRoles: Unable to locate role ${roleName1}.`);

    let def2 = this.getRoleDefinition(roleName2, sourceNames, targetNames);
    if (!def2)
      throw new Error(`Role::compareRoles: Unable to locate role ${roleName2}.`);

    return Math.sign(def2.priority - def1.priority);
  }

  static compareAllRoles(rolesNames1, rolesNames2, sourceNames, targetNames, options) {
    let highestRoleName1 = this.getHighestLevelRoleName(rolesNames1, sourceNames, targetNames, options);
    let highestRoleName2 = this.getHighestLevelRoleName(rolesNames2, sourceNames, targetNames, options);

    return this.compareRoles(highestRoleName1, highestRoleName2, sourceNames, targetNames);
  }

  static getPrimaryRoles(sourceNames, targetNames) {
    return this.getRoleDefinitions((roleDefinition) => {
      if (!this.roleSourceAndTargetMatches(roleDefinition, sourceNames, targetNames))
        return false;

      if (!roleDefinition.isPrimaryRole)
        return false;

      return true;
    });
  }

  static getPrimaryRoleNames(sourceNames, targetNames) {
    return this.getPrimaryRoles(sourceNames, targetNames).map((roleDefinition) => roleDefinition.name);
  }

  static getRoleDisplayNames(roles, sourceNames, targetNames) {
    if (Nife.isEmpty(roles))
      return [];

    let roleDefinitions = this.getRoleDefinitions((roleDefinition) => {
      if (!this.roleSourceAndTargetMatches(roleDefinition, sourceNames, targetNames))
        return false;

      if (roles.indexOf(roleDefinition.name) < 0)
        return false;

      return true;
    });

    return roleDefinitions.map((roleDefinition) => roleDefinition.displayName);
  }

  static _getTargetAttributes(target) {
    let { type, id } = (this.getModelTypeAndID(target) || {});
    if (!type || !id)
      return;

    return {
      targetType: type || null,
      targetID:   id || null,
    };
  }

  static async createFor(sourceModel, roleName, targetModel) {
    let { Role }        = this.getModels();
    let sourceType      = sourceModel.getModelName();
    let targetInfo      = this._getTargetAttributes(targetModel);
    let sourceScopes    = [ sourceType ];
    let targetScopes    = [ null, (targetInfo && targetInfo.targetType) || null ];
    let roleDefinition  = this.getRoleDefinition(roleName, sourceScopes, targetScopes);
    if (!roleDefinition)
      throw new Error(`Role::createFor: Attempting to create role "${roleName}" for "${sourceType}" "${sourceModel.id}", but no such role was found.`);

    let role = new Role({ sourceID: sourceModel.id, sourceType, name: roleName });
    if (targetInfo && roleDefinition.target != null) {
      role.setAttributes(targetInfo);
      targetScopes = [ targetInfo.targetType ];
    } else {
      targetScopes = [ null ];
    }

    return await this.getConnection().transaction(async () => {
      const destroyOtherPrimaryRoles = async () => {
        const shouldDestroyRole = (targetInfo, roleDefinition) => {
          if (!roleDefinition)
            return false;

          if (!roleDefinition.isPrimaryRole)
            return false;

          if (targetInfo) {
            if (roleDefinition.target != null && !targetInfo.targetID)
              return false;

            if (roleDefinition.target == null && targetInfo.targetID)
              return false;

            if (roleDefinition.target !== targetInfo.targetType)
              return false;
          } else {
            if (roleDefinition.target != null)
              return false;
          }

          return true;
        };

        // If this is a primary role, then first ensure all other
        // primary roles are removed for this source model
        let roleDefinitions = this.getPrimaryRoles(sourceScopes, targetScopes);

        // If the role being created isn't a primary role,
        // then skip deleting other primary roles
        if (roleDefinitions.findIndex((roleDefinition) => (roleDefinition.name === roleName)) < 0)
          return;

        roleDefinitions = roleDefinitions.filter((roleDefinition) => shouldDestroyRole(targetInfo, roleDefinition));
        if (Nife.isNotEmpty(roleDefinitions)) {
          let primaryRoleNames = roleDefinitions.map((roleDefinition) => roleDefinition.name);

          let destroyRolesQuery = Role
              .$.sourceID
                .EQ(sourceModel.id)
              .sourceType
                .EQ(sourceType)
              .targetType
                .EQ((targetInfo && targetInfo.targetType) || null)
              .targetID
                .EQ((targetInfo && targetInfo.targetID) || null)
              .name
                .EQ(primaryRoleNames);

          await destroyRolesQuery.destroy();
        }
      };

      await destroyOtherPrimaryRoles();
      await role.save();

      return role;
    });
  }

  constructor(...args) {
    super(...args);

    // Get the "human readable" name for this role
    Object.defineProperties(this, {
      'displayName': {
        enumberable:  false,
        configurable: true,
        get:          () => {
          return this.constructor.getRoleDisplayName.call(this.constructor, this.name, [ this.sourceType ], [ this.targetType ]);
        },
        set:          () => {
          // NO-OP
        },
      },
    });
  }

  async getSource(options) {
    let sourceType    = this.sourceType;
    const SourceModel = this.getModel(sourceType);

    return await SourceModel.where[SourceModel.getPrimaryKeyFieldName()].EQ(this.sourceID).first(null, options);
  }

  async getTarget(options) {
    let targetType    = this.targetType;
    const TargetModel = this.getModel(targetType);

    return await TargetModel.where[TargetModel.getPrimaryKeyFieldName()].EQ(this.targetID).first(null, options);
  }
}
