import Nife from 'nife';
import { OrganizationPermissions } from '../../app/permissions/index.mjs';
import {
  createTestApplication,
  createFactories,
  createRunners,
} from '../support/application.mjs';

import {
  ALL_ROLE_NAMES,
  generateTests as _generateTests,
} from './permission-test-helpers.mjs';

describe('OrganizationPermissions', function() {
  let app;
  let models;
  let factory;
  let generateTests;
  let context;

  // eslint-disable-next-line no-unused-vars
  const { it, fit } = createRunners(() => app.getConnection());

  const contextProvider = () => context;

  generateTests = _generateTests.bind({
    describe,
    it,
    contextProvider,
  });

  beforeAll(async () => {
    app = await createTestApplication();
    factory = createFactories(app);
    models = app.getModels();

    context = {
      PermissionClass: OrganizationPermissions,
      describe,
      it,
      app,
      factory,
      models,
    };
  });

  afterAll(async () => {
    await app.stop();
  });

  afterEach(async () => {
    factory.reset();

    jasmine.clock().uninstall();
    await app.truncateAllTables();
  });

  describe('canInviteUser', () => {
    const permissionMatrix = {
      'member':       false,
      'admin':        false,
      'superadmin':   true,
      'support':      true,
      'masteradmin':  true,
    };

    const shouldPass = ({ user1Role }) => {
      return permissionMatrix[user1Role];
    };

    generateTests(
      'should #{allow} invitation of user to organization',
      async ({ expectedResult, permissions, org1 }) => {
        let result = await permissions.can('inviteUser:Organization', org1);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );

    generateTests(
      'should #{allow} invitation of user to organization when has invite-to-organization role',
      async ({ expectedResult, permissions, user1, org1 }) => {
        await models.Role.createFor(user1, 'invite-to-organization', org1);
        let result = await permissions.can('inviteUser:Organization', org1);
        expect(result).toEqual(expectedResult);
      },
      () => true,
    );
  });

  describe('canRemoveUser', () => {
    const permissionMatrix = {
      'member': {
        'sameOrg':  [],
        'otherOrg': [],
      },
      'admin': {
        'sameOrg':  [ 'member' ],
        'otherOrg': [],
      },
      'superadmin': {
        'sameOrg':  [ 'admin', 'member' ],
        'otherOrg': [],
      },
      'support': {
        'sameOrg':  [ 'superadmin', 'admin', 'member' ],
        'otherOrg': [ 'superadmin', 'admin', 'member' ],
      },
      'masteradmin': {
        'sameOrg':  ALL_ROLE_NAMES,
        'otherOrg': ALL_ROLE_NAMES,
      },
    };

    const shouldPass = ({ user1Role, user2Role, orgType }) => {
      let allowedRoles = Nife.get(permissionMatrix, `${user1Role}.${orgType}`);
      return (allowedRoles.indexOf(user2Role) >= 0);
    };

    generateTests(
      'should #{allow} removal of #{role} user from same organization',
      async ({ expectedResult, permissions, user2, org1 }) => {
        let result = await permissions.can('removeUser:Organization', user2, org1);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );

    generateTests(
      'should #{allow} removal of #{role} user from different organization',
      async ({ expectedResult, permissions, user2, org2 }) => {
        let result = await permissions.can('removeUser:Organization', user2, org2);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );
  });

  describe('canCreate', () => {
    const permissionMatrix = {
      'member':       false,
      'admin':        false,
      'superadmin':   false,
      'support':      true,
      'masteradmin':  true,
    };

    const shouldPass = ({ user1Role }) => {
      return permissionMatrix[user1Role];
    };

    generateTests(
      'should #{allow} creation of user for organization',
      async ({ expectedResult, permissions }) => {
        let result = await permissions.can('create:Organization');
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );
  });

  describe('canUpdate', () => {
    const permissionMatrix = {
      'member': {
        'sameOrg':  false,
        'otherOrg': false,
      },
      'admin': {
        'sameOrg':  false,
        'otherOrg': false,
      },
      'superadmin': {
        'sameOrg':  true,
        'otherOrg': false,
      },
      'support': {
        'sameOrg':  true,
        'otherOrg': true,
      },
      'masteradmin': {
        'sameOrg':  true,
        'otherOrg': true,
      },
    };

    const shouldPass = ({ user1Role, orgType }) => {
      return Nife.get(permissionMatrix, `${user1Role}.${orgType}`);
    };

    generateTests(
      'should #{allow} user to update same organization',
      async ({ expectedResult, permissions, org1 }) => {
        let result = await permissions.can('update:Organization', org1);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );

    generateTests(
      'should #{allow} user to update different organization',
      async ({ expectedResult, permissions, org2 }) => {
        let result = await permissions.can('update:Organization', org2);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );
  });

  describe('canView', () => {
    const permissionMatrix = {
      'member': {
        'sameOrg':  true,
        'otherOrg': false,
      },
      'admin': {
        'sameOrg':  true,
        'otherOrg': false,
      },
      'superadmin': {
        'sameOrg':  true,
        'otherOrg': false,
      },
      'support': {
        'sameOrg':  true,
        'otherOrg': true,
      },
      'masteradmin': {
        'sameOrg':  true,
        'otherOrg': true,
      },
    };

    const shouldPass = ({ user1Role, orgType }) => {
      return Nife.get(permissionMatrix, `${user1Role}.${orgType}`);
    };

    generateTests(
      'should #{allow} view of same organization',
      async ({ expectedResult, permissions, org1 }) => {
        let result = await permissions.can('view:Organization', org1);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );

    generateTests(
      'should #{allow} view of different organization',
      async ({ expectedResult, permissions, org2 }) => {
        let result = await permissions.can('view:Organization', org2);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );
  });

  describe('canUpdateUser', () => {
    const permissionMatrix = {
      'member': {
        'sameOrg':  [],
        'otherOrg': [],
      },
      'admin': {
        'sameOrg':  [ 'member' ],
        'otherOrg': [],
      },
      'superadmin': {
        'sameOrg':  [ 'admin', 'member' ],
        'otherOrg': [],
      },
      'support': {
        'sameOrg':  [ 'superadmin', 'admin', 'member' ],
        'otherOrg': [ 'superadmin', 'admin', 'member' ],
      },
      'masteradmin': {
        'sameOrg':  ALL_ROLE_NAMES,
        'otherOrg': ALL_ROLE_NAMES,
      },
    };

    const shouldPass = ({ user1Role, user2Role, orgType }) => {
      let allowedRoles = Nife.get(permissionMatrix, `${user1Role}.${orgType}`);
      return (allowedRoles.indexOf(user2Role) >= 0);
    };

    generateTests(
      'should #{allow} update of #{role} user from same organization',
      async ({ expectedResult, permissions, user1, user2, org1 }) => {
        // User should always be allowed to update themselves
        let result = await permissions.can('updateUser:Organization', user1, org1);
        expect(result).toEqual(true);

        result = await permissions.can('updateUser:Organization', user2, org1);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );

    generateTests(
      'should #{allow} update of #{role} user from different organization',
      async ({ expectedResult, permissions, user2, org2 }) => {
        let result = await permissions.can('updateUser:Organization', user2, org2);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );
  });
});
