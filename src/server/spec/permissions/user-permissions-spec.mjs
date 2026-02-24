/* eslint-disable camelcase */

import Nife from 'nife';
import { UserPermissions } from '../../app/permissions/index.mjs';
import {
  createTestApplication,
  createFactories,
  createRunners,
} from '../support/application.mjs';

import {
  ALL_ROLE_NAMES,
  generateTests as _generateTests,
} from './permission-test-helpers.mjs';

describe('UserPermissions', function() {
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
      PermissionClass: UserPermissions,
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

  describe('canUpdate', () => {
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
      async ({ expectedResult, permissions, user1, user2 }) => {
        // User should always be allowed to update themselves
        let result = await permissions.can('update:User', user1);
        expect(result).toEqual(true);

        result = await permissions.can('update:User', user2);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );

    generateTests(
      'should #{allow} update of #{role} user from different organization',
      async ({ expectedResult, permissions, user2 }) => {
        let result = await permissions.can('update:User', user2);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );
  });

  describe('canView', () => {
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
      'should #{allow} view of #{role} user from same organization',
      async ({ expectedResult, permissions, user1, user2 }) => {
        // User should always be allowed to view themselves
        let result = await permissions.can('view:User', user1);
        expect(result).toEqual(true);

        result = await permissions.can('view:User', user2);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );

    generateTests(
      'should #{allow} view of #{role} user from different organization',
      async ({ expectedResult, permissions, user2 }) => {
        let result = await permissions.can('view:User', user2);
        expect(result).toEqual(expectedResult);
      },
      shouldPass,
    );
  });
});
