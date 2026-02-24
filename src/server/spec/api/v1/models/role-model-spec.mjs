/* eslint-disable no-magic-numbers */

import {
  createTestApplication,
  createFactories,
  createRunners,
  PREFIXED_XID_REGEXP,
} from '../../../support/application.mjs';

describe('RoleModel', function() {
  let app;
  let models;
  let factory;

  // eslint-disable-next-line no-unused-vars
  const { it, fit } = createRunners(() => app.getConnection());

  beforeAll(async () => {
    app = await createTestApplication();
    factory = createFactories(app);
    models = app.getModels();
  });

  afterAll(async () => {
    await app.stop();
  });

  afterEach(async () => {
    factory.reset();

    await app.truncateAllTables();
  });

  const fetchValues = (args) => args;

  describe('createFor', () => {
    it('should be able to create a role model with a model instance as a target', async () => {
      let { user, organization, role } = await factory.users.createWithOrganization({ userRole: 'admin' }, fetchValues);

      expect(role.id).toMatch(PREFIXED_XID_REGEXP);
      expect(role.name).toEqual('admin');
      expect(role.sourceType).toEqual('User');
      expect(role.sourceID).toEqual(user.id);
      expect(role.targetType).toEqual('Organization');
      expect(role.targetID).toEqual(organization.id);

      let roles = await user.getRolesFor(organization);
      expect(roles).toBeInstanceOf(Array);
      expect(roles.length).toEqual(1);
      expect(roles[0].id).toEqual(role.id);
      expect(roles[0].name).toEqual('admin');
      expect(roles[0].sourceType).toEqual('User');
      expect(roles[0].sourceID).toEqual(user.id);
      expect(roles[0].targetType).toEqual('Organization');
      expect(roles[0].targetID).toEqual(organization.id);
    });

    it('should be able to list roles for masteradmin even when a target is specified', async () => {
      let { user, organization, role } = await factory.users.createWithOrganization({ userRole: 'masteradmin' }, fetchValues);

      expect(role.id).toMatch(PREFIXED_XID_REGEXP);
      expect(role.name).toEqual('masteradmin');
      expect(role.sourceType).toEqual('User');
      expect(role.sourceID).toEqual(user.id);
      expect(role.targetType).toEqual(null);
      expect(role.targetID).toEqual(null);

      let roles = await user.getRolesFor(organization);
      expect(roles).toBeInstanceOf(Array);
      expect(roles.length).toEqual(1);
      expect(roles[0].id).toEqual(role.id);
      expect(roles[0].name).toEqual('masteradmin');
      expect(roles[0].sourceType).toEqual('User');
      expect(roles[0].sourceID).toEqual(user.id);
      expect(roles[0].targetType).toEqual(null);
      expect(roles[0].targetID).toEqual(null);
    });

    it('should be able to create a role model without a target', async () => {
      let { user } = await factory.users.create();

      let role = await models.Role.createFor(user, 'masteradmin');
      expect(role.id).toMatch(PREFIXED_XID_REGEXP);
      expect(role.name).toEqual('masteradmin');
      expect(role.sourceType).toEqual('User');
      expect(role.sourceID).toEqual(user.id);
      expect(role.targetType).toBe(null);
      expect(role.targetID).toBe(null);
    });

    it('should throw an error if the role is not defined', async () => {
      let { user } = await factory.users.create();
      await expectAsync(models.Role.createFor(user, 'derp')).toBeRejectedWithError(Error, /Role::createFor: Attempting to create role "derp" for "User"/);
    });
  });

  describe('getRoleDefinitions', () => {
    it('should be able to fetch all role definitions', async () => {
      expect(models.Role.getRoleDefinitions()).toEqual(models.Role.ApplicationRoles);
    });

    it('should be able to filter role definitions', async () => {
      let filteredRoles = models.Role.getRoleDefinitions((roleDefinition) => {
        return (roleDefinition.target == null);
      });

      expect(filteredRoles.length).not.toEqual(models.Role.ApplicationRoles.length);
      expect(filteredRoles).not.toEqual(models.Role.ApplicationRoles);
      expect(filteredRoles.length).toEqual(2);
      expect(filteredRoles[0].name).toEqual('masteradmin');
      expect(filteredRoles[1].name).toEqual('support');
    });
  });

  describe('getRoleDefinition', () => {
    it('should be able to fetch role definition', async () => {
      expect(models.Role.getRoleDefinition('masteradmin', [ 'User', 'Organization' ])).toEqual({
        source:         'User',
        target:         null,
        name:           'masteradmin',
        displayName:    'Master Admin',
        priority:       0,
        isPrimaryRole:  true,
      });
    });

    it('should be able to fetch role definition (without providing scope names)', async () => {
      expect(models.Role.getRoleDefinition('support', [ 'User' ])).toEqual({
        source:         'User',
        target:         null,
        name:           'support',
        displayName:    'Support Staff',
        priority:       1,
        isPrimaryRole:  true,
      });
    });
  });

  describe('getHighestLevelRoleName', () => {
    it('should be able to get roles in elevation order', async () => {
      let roles         = [ 'member', 'admin', 'superadmin', 'support', 'masteradmin' ];
      let sourceScopes  = [ 'User', 'Organization' ];
      let targetScopes  = [ null, 'Organization' ];

      expect(models.Role.getHighestLevelRoleName(roles.slice(), sourceScopes, targetScopes)).toEqual('masteradmin');
      expect(models.Role.getHighestLevelRoleName(roles.slice(0, -1), sourceScopes, targetScopes)).toEqual('support');
      expect(models.Role.getHighestLevelRoleName(roles.slice(0, -2), sourceScopes, targetScopes)).toEqual('superadmin');
      expect(models.Role.getHighestLevelRoleName(roles.slice(0, -3), sourceScopes, targetScopes)).toEqual('admin');
      expect(models.Role.getHighestLevelRoleName(roles.slice(0, -4), sourceScopes, targetScopes)).toEqual('member');
    });

    it('should return undefined if empty roles provided', async () => {
      expect(models.Role.getHighestLevelRoleName()).toBe(undefined);
      expect(models.Role.getHighestLevelRoleName([])).toBe(undefined);
    });
  });

  describe('getHigherLevelRoleNames', () => {
    it('should be able to get roles that are more elevated', async () => {
      let sourceScopes  = [ 'User' ];
      let targetScopes  = [ null, 'Organization' ];

      expect(models.Role.getHigherLevelRoleNames('member', sourceScopes, targetScopes)).toEqual([ 'masteradmin', 'support', 'superadmin', 'admin' ]);
      expect(models.Role.getHigherLevelRoleNames('admin', sourceScopes, targetScopes)).toEqual([ 'masteradmin', 'support', 'superadmin' ]);
      expect(models.Role.getHigherLevelRoleNames('superadmin', sourceScopes, targetScopes)).toEqual([ 'masteradmin', 'support' ]);
      expect(models.Role.getHigherLevelRoleNames('support', sourceScopes, targetScopes)).toEqual([ 'masteradmin' ]);
      expect(models.Role.getHigherLevelRoleNames('masteradmin', sourceScopes, targetScopes)).toEqual([]);
    });

    it('should return empty array if empty role provided', async () => {
      expect(models.Role.getHigherLevelRoleNames()).toEqual([]);
      expect(models.Role.getHigherLevelRoleNames('')).toEqual([]);
    });

    it('should return empty array when unknown role is provided', async () => {
      expect(models.Role.getHigherLevelRoleNames('derp', [ 'User' ], [ null, 'Organization' ])).toEqual([]);
    });
  });

  describe('getLowerLevelRoleNames', () => {
    it('should be able to get roles that are more elevated', async () => {
      let sourceScopes  = [ 'User' ];
      let targetScopes  = [ null, 'Organization' ];

      expect(models.Role.getLowerLevelRoleNames('member', sourceScopes, targetScopes)).toEqual([ 'invite-to-organization' ]);
      expect(models.Role.getLowerLevelRoleNames('admin', sourceScopes, targetScopes)).toEqual([ 'member', 'invite-to-organization' ]);
      expect(models.Role.getLowerLevelRoleNames('superadmin', sourceScopes, targetScopes)).toEqual([ 'admin', 'member', 'invite-to-organization' ]);
      expect(models.Role.getLowerLevelRoleNames('support', sourceScopes, targetScopes)).toEqual([ 'superadmin', 'admin', 'member', 'invite-to-organization' ]);
      expect(models.Role.getLowerLevelRoleNames('masteradmin', sourceScopes, targetScopes)).toEqual([ 'support', 'superadmin', 'admin', 'member', 'invite-to-organization' ]);
    });

    it('should return empty array if empty role provided', async () => {
      expect(models.Role.getLowerLevelRoleNames()).toEqual([]);
      expect(models.Role.getLowerLevelRoleNames('')).toEqual([]);
    });

    it('should return empty array when unknown role is provided', async () => {
      expect(models.Role.getLowerLevelRoleNames('derp')).toEqual([]);
    });
  });

  describe('getPrimaryRoles', () => {
    it('should be able to fetch all primary role definitions', async () => {
      let primaryRoles = models.Role.ApplicationRoles.filter((roleDefinition) => {
        return (roleDefinition.target === 'Organization' && roleDefinition.isPrimaryRole);
      });

      expect(models.Role.getPrimaryRoles([ 'User' ], [ 'Organization' ])).toEqual(primaryRoles);
    });

    it('should be able to fetch all primary role definitions (including empty target)', async () => {
      let primaryRoles = models.Role.ApplicationRoles.filter((roleDefinition) => {
        return (roleDefinition.source === 'User' && (roleDefinition.target === null || roleDefinition.target === 'Organization') && roleDefinition.isPrimaryRole);
      });

      expect(models.Role.getPrimaryRoles([ 'User' ], [ null, 'Organization' ])).toEqual(primaryRoles);
    });
  });

  describe('getPrimaryRoleNames', () => {
    it('should be able to fetch all primary role names', async () => {
      let primaryRoleNames = models.Role.ApplicationRoles.filter((roleDefinition) => {
        return (roleDefinition.target === 'Organization' && roleDefinition.isPrimaryRole);
      }).map((roleDefinition) => roleDefinition.name);

      expect(models.Role.getPrimaryRoleNames([ 'User' ], [ 'Organization' ])).toEqual(primaryRoleNames);
    });

    it('should be able to fetch all primary role names (with empty target)', async () => {
      let primaryRoleNames = models.Role.ApplicationRoles.filter((roleDefinition) => {
        return (roleDefinition.source === 'User' && (roleDefinition.target === null || roleDefinition.target === 'Organization') && roleDefinition.isPrimaryRole);
      }).map((roleDefinition) => roleDefinition.name);

      expect(models.Role.getPrimaryRoleNames([ 'User' ], [ null, 'Organization' ])).toEqual(primaryRoleNames);
    });
  });

  describe('displayName', () => {
    it('should be able to fetch displayName for role name for masteradmin', async () => {
      let role = new models.Role();
      role.setAttributes({
        name:       'masteradmin',
        sourceType: 'User',
      });

      expect(role.displayName).toEqual('Master Admin');
    });

    it('should be able to fetch displayName for role name for support', async () => {
      let role = new models.Role();
      role.setAttributes({
        name:       'support',
        sourceType:  'User',
      });

      expect(role.displayName).toEqual('Support Staff');
    });

    it('should be able to fetch displayName for role name for superadmin', async () => {
      let role = new models.Role();
      role.setAttributes({
        name:       'superadmin',
        sourceType: 'User',
      });

      expect(role.displayName).toBe(undefined);

      role.setAttributes({ targetType: 'Organization' });

      expect(role.displayName).toBe('Super Admin');
    });

    it('should be able to fetch displayName for role name for admin', async () => {
      let role = new models.Role();
      role.setAttributes({
        name:       'admin',
        sourceType: 'User',
      });

      expect(role.displayName).toBe(undefined);

      role.setAttributes({ targetType: 'Organization' });

      expect(role.displayName).toBe('Admin');
    });

    it('should be able to fetch displayName for role name for member', async () => {
      let role = new models.Role();
      role.setAttributes({
        name:       'member',
        sourceType: 'User',
      });

      expect(role.displayName).toBe(undefined);

      role.setAttributes({ targetType: 'Organization' });

      expect(role.displayName).toBe('Member');
    });

    it('should be able to fetch displayName for role name for invite-to-organization', async () => {
      let role = new models.Role();
      role.setAttributes({
        name:       'invite-to-organization',
        sourceType: 'User',
      });

      expect(role.displayName).toBe(undefined);

      role.setAttributes({ targetType: 'Organization' });

      expect(role.displayName).toBe('Invite User to Organization');
    });
  });
});
