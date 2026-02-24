/* eslint-disable max-classes-per-file */
/* eslint-disable no-magic-numbers */

import Nife from 'nife';
import {
  createTestApplication,
  createFactories,
  createRunners,
  PREFIXED_XID_REGEXP,
} from '../../../support/application.mjs';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 9999999;

describe('UserController', function () {
  let app;
  let factory;
  let models;

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

    app.setDefaultHeader('Authorization', undefined);
    app.setDefaultHeader('X-Organization-ID', undefined);

    jasmine.clock().uninstall();

    await app.truncateAllTables();
  });

  describe('tags', () => {
    describe('addTags', () => {
      it('can add tags to a user', async () => {
        let { user, organization } = await factory.users.createAndLogin();

        let result = await app.put(`/api/v1/user/${user.id}/tags`, {
          data: {
            tags: ['test1', 'test2'],
          },
        });

        expect(result.statusCode).toEqual(200);

        let data = result.body.data;
        expect(data).toBeInstanceOf(Array);
        expect(data.length).toEqual(2);

        expect(data[0].id).toMatch(PREFIXED_XID_REGEXP);
        expect(data[0].sourceType).toEqual('User');
        expect(data[0].sourceID).toEqual(user.id);
        expect(data[0].targetType).toEqual('Organization');
        expect(data[0].targetID).toMatch(PREFIXED_XID_REGEXP);
        expect(data[0].name).toEqual('test1');
        expect(data[0].createdAt).toBeInstanceOf(String);
        expect(data[0].updatedAt).toBeInstanceOf(String);

        expect(data[1].id).toMatch(PREFIXED_XID_REGEXP);
        expect(data[1].sourceType).toEqual('User');
        expect(data[1].sourceID).toEqual(user.id);
        expect(data[1].targetType).toEqual('Organization');
        expect(data[1].targetID).toMatch(PREFIXED_XID_REGEXP);
        expect(data[1].name).toEqual('test2');
        expect(data[1].createdAt).toBeInstanceOf(String);
        expect(data[1].updatedAt).toBeInstanceOf(String);

        expect(await models.Tag.count()).toEqual(2);

        let tags = await user.getTags(organization);
        expect(tags).toBeInstanceOf(Array);
        expect(tags.length).toEqual(2);
        expect(tags.map((tag) => tag.name).sort()).toEqual([
          'test1',
          'test2',
        ]);
      });
    });

    describe('removeTags', () => {
      it('can remove tags from a user', async () => {
        let { user, organization } = await factory.users.createAndLogin();
        await user.addTags(organization, ['test1', 'test2', 'test3', 'test4']);

        let result = await app.delete(`/api/v1/user/${user.id}/tags`, {
          data: {
            tags: [ 'test1', 'test2' ],
          },
        });

        expect(result.statusCode).toEqual(200);

        let data = result.body.data;
        expect(data).toBeInstanceOf(Array);
        expect(data.length).toEqual(2);

        expect(data[0].id).toMatch(PREFIXED_XID_REGEXP);
        expect(data[0].sourceType).toEqual('User');
        expect(data[0].sourceID).toEqual(user.id);
        expect(data[0].targetType).toEqual('Organization');
        expect(data[0].targetID).toMatch(PREFIXED_XID_REGEXP);
        expect(data[0].name).toEqual('test3');
        expect(data[0].createdAt).toBeInstanceOf(String);
        expect(data[0].updatedAt).toBeInstanceOf(String);

        expect(data[1].id).toMatch(PREFIXED_XID_REGEXP);
        expect(data[1].sourceType).toEqual('User');
        expect(data[1].sourceID).toEqual(user.id);
        expect(data[1].targetType).toEqual('Organization');
        expect(data[1].targetID).toMatch(PREFIXED_XID_REGEXP);
        expect(data[1].name).toEqual('test4');
        expect(data[1].createdAt).toBeInstanceOf(String);
        expect(data[1].updatedAt).toBeInstanceOf(String);

        let tags = await user.getTags(organization);
        expect(tags).toBeInstanceOf(Array);
        expect(tags.length).toEqual(2);
        expect(tags.map((tag) => tag.name).sort()).toEqual([
          'test3',
          'test4',
        ]);
      });
    });
  });

  describe('update', () => {
    describe('PATCH', () => {
      it('should fail if user is not logged in', async () => {
        let result = await app.patch('/api/v1/user/current');
        expect(result.statusCode).toEqual(401);
        expect(result.body).toEqual('Unauthorized');
      });

      it('should allow user to update themselves', async () => {
        let { user } = await factory.users.createAndLogin();

        let result = await app.patch('/api/v1/user', {
          data: {
            firstName:  'Johny',
            lastName:   'Bob',
            phone:      '+1-560-452-0919',
            dob:        '2005-02-02',
          },
        });

        expect(result.statusCode).toEqual(200);

        let data = result.body.data;
        expect(data.email).toEqual('test1@example.com');
        expect(data.phone).toEqual('+1-560-452-0919');
        expect(data.firstName).toEqual('Johny');
        expect(data.lastName).toEqual('Bob');
        expect(data.dob).toEqual('2005-02-02');

        user = await models.User.$.id.EQ(user.id).first();
        expect(user.email).toEqual('test1@example.com');
        expect(user.phone).toEqual('15604520919');
        expect(user.firstName).toEqual('Johny');
        expect(user.lastName).toEqual('Bob');
        expect(user.dob.toUTC().toFormat('yyyy-MM-dd')).toEqual('2005-02-02');
      });

      it('should allow support user to update user', async () => {
        let { user } = await factory.users.createAndLogin({
          userData: {
            email:      'support@example.com',
            phone:      '555-555-5555',
            firstName:  'Support',
            lastName:   'Guy',
            dob:        '2001-06-01',
          },
          userRole: 'support',
        });

        let { user: otherUser } = await factory.users.createWithOrganization();

        let result = await app.patch(`/api/v1/user/${otherUser.id}`, {
          data: {
            firstName: 'Johny',
            lastName:  'Bob',
          },
        });

        expect(result.statusCode).toEqual(200);

        // Verify response
        let data = result.body.data;
        expect(data.id).toEqual(otherUser.id);
        expect(data.email).toEqual(otherUser.email);
        expect(data.phone).toEqual('+1-560-452-0919');
        expect(data.firstName).toEqual('Johny');
        expect(data.lastName).toEqual('Bob');
        expect(data.dob).toEqual('2000-01-01');

        // Load from DB to ensure the updates were stored
        let loadedUser = await models.User.$.id.EQ(otherUser.id).first();
        expect(loadedUser.id).toEqual(otherUser.id);
        expect(loadedUser.email).toEqual(otherUser.email);
        expect(loadedUser.phone).toEqual('15604520919');
        expect(loadedUser.firstName).toEqual('Johny');
        expect(loadedUser.lastName).toEqual('Bob');
        expect(loadedUser.dob.toUTC().toFormat('yyyy-MM-dd')).toEqual('2000-01-01');

        // Ensure that the admin user wasn't updated
        expect(user.email).toEqual('support@example.com');
        expect(user.phone).toEqual('555-555-5555');
        expect(user.firstName).toEqual('Support');
        expect(user.lastName).toEqual('Guy');
        expect(user.dob.toUTC().toFormat('yyyy-MM-dd')).toEqual('2001-06-01');
      });

      it('should allow masteradmin user to update another user in any organization', async () => {
        let { user } = await factory.users.createAndLogin({
          userData: {
            email:     'master@example.com',
            phone:     '555-555-5555',
            firstName: 'Master',
            lastName:  'Admin',
            dob:       '2001-06-01',
          },
          userRole: 'masteradmin',
        });

        let { user: otherUser } = await factory.users.createWithOrganization();

        let result = await app.patch(`/api/v1/user/${otherUser.id}`, {
          data: {
            firstName: 'Johny',
            lastName:  'Bob',
          },
        });

        expect(result.statusCode).toEqual(200);

        // Verify response
        let data = result.body.data;
        expect(data.id).toEqual(otherUser.id);
        expect(data.email).toEqual(otherUser.email);
        expect(data.phone).toEqual('+1-560-452-0919');
        expect(data.firstName).toEqual('Johny');
        expect(data.lastName).toEqual('Bob');
        expect(data.dob).toEqual('2000-01-01');

        // Load from DB to ensure the updates were stored
        let loadedUser = await models.User.$.id.EQ(otherUser.id).first();
        expect(loadedUser.id).toEqual(otherUser.id);
        expect(loadedUser.email).toEqual(otherUser.email);
        expect(loadedUser.phone).toEqual('15604520919');
        expect(loadedUser.firstName).toEqual('Johny');
        expect(loadedUser.lastName).toEqual('Bob');
        expect(loadedUser.dob.toUTC().toFormat('yyyy-MM-dd')).toEqual('2000-01-01');

        // Ensure that the admin user wasn't updated
        expect(user.email).toEqual('master@example.com');
        expect(user.phone).toEqual('555-555-5555');
        expect(user.firstName).toEqual('Master');
        expect(user.lastName).toEqual('Admin');
        expect(user.dob.toUTC().toFormat('yyyy-MM-dd')).toEqual('2001-06-01');
      });
    });
  });

  describe('getCurrentUser', () => {
    it('should fail if user is not logged in', async () => {
      let result = await app.get('/api/v1/user/current');
      expect(result.statusCode).toEqual(401);
      expect(result.body).toEqual('Unauthorized');
    });

    it('should allow user to show themselves', async () => {
      let { user, organization } = await factory.users.createAndLogin();

      // Should work without an organizationID being provided
      app.setDefaultHeader('X-Organization-ID', undefined);

      let result = await app.get('/api/v1/user');
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data.id).toEqual(user.id);
      expect(data.roles).toEqual([ 'member' ]);
      expect(data.currentOrganizationID).toEqual(organization.id);
    });

    it('should work properly for a masteradmin user', async () => {
      let { user, organization } = await factory.users.createAndLogin({ userRole: 'masteradmin' });

      // Should work without an organizationID being provided
      app.setDefaultHeader('X-Organization-ID', undefined);

      let result = await app.get('/api/v1/user');
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data.id).toEqual(user.id);
      expect(data.roles).toEqual([ 'masteradmin' ]);
      expect(data.currentOrganizationID).toEqual(organization.id);
    });
  });

  describe('setCurrentOrganization', () => {
    it('should fail if user is not logged in', async () => {
      let { organization } = await factory.users.createWithOrganization();

      let result = await app.post('/api/v1/user/set-current-organization', { data: { organizationID: organization.id } });
      expect(result.statusCode).toEqual(401);
      expect(result.body).toEqual('Unauthorized');
    });

    it('should disallow user to set their current organization if they are not a member', async () => {
      let {
        organization,
        sessionToken,
      } = await factory.users.createAndLogin();

      let { organization: organization2 } = await factory.organizations.create();

      // Should work without an organizationID being provided
      app.setDefaultHeader('X-Organization-ID', undefined);

      let { claims } = await models.User.validateSessionToken(sessionToken, { onlyVerify: true });
      expect(claims.organizationID).toBe(organization.id);

      let result = await app.post('/api/v1/user/set-current-organization', { data: { organizationID: organization2.id } });
      expect(result.statusCode).toEqual(403);
      expect(result.body).toEqual('Forbidden');
    });

    it('should allow user to set their current organization', async () => {
      let {
        user,
        organization,
        sessionToken,
      } = await factory.users.createAndLogin();

      let { organization: organization2 } = await factory.organizations.create();
      await organization2.addUser(user);

      // Should work without an organizationID being provided
      app.setDefaultHeader('X-Organization-ID', undefined);

      let { claims } = await models.User.validateSessionToken(sessionToken, { onlyVerify: true });
      expect(claims.organizationID).toBe(organization.id);

      let result = await app.post('/api/v1/user/set-current-organization', { data: { organizationID: organization2.id } });
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data.userID).toEqual(user.id);
      expect(data.currentOrganizationID).toEqual(organization2.id);
      expect(data.sessionToken).toBeTruthy();

      let newSessionToken = data.sessionToken;
      let { claims: claims2 } = await models.User.validateSessionToken(newSessionToken, { onlyVerify: true });
      expect(claims2.organizationID).toBe(organization2.id);
    });
  });

  describe('show', () => {
    it('should fail if user is not logged in', async () => {
      let { user } = await factory.users.create();

      let result = await app.get(`/api/v1/user/${user.id}`);
      expect(result.statusCode).toEqual(401);
      expect(result.body).toEqual('Unauthorized');
    });

    it('should allow user to show themselves', async () => {
      let { user } = await factory.users.createAndLogin();

      let result = await app.get(`/api/v1/user/${user.id}`);
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toEqual(await user.serializeAttributes());
    });

    it('should disallow user to show another user', async () => {
      await factory.users.createAndLogin({
        userData: {
          email: 'test+{#}@example.com',
        },
      });

      let { user: otherUser } = await factory.users.create({
        data: {
          email: 'test+{#}@example.com',
        },
      });

      let result = await app.get(`/api/v1/user/${otherUser.id}`);
      expect(result.statusCode).toEqual(403);
      expect(result.body).toEqual('Forbidden');
    });

    it('should allow user to show another user (as admin)', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email: 'test+{#}@example.com',
        },
        userRole: 'admin',
      });

      let { user: otherUser } = await factory.users.create({
        data: {
          email: 'test+{#}@example.com',
        },
        organization,
      });

      let result = await app.get(`/api/v1/user/${otherUser.id}`);
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toEqual(await otherUser.serializeAttributes());
    });

    it('should disallow user to show another admin user (as admin)', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email: 'test+{#}@example.com',
        },
        userRole: 'admin',
      });

      let { user: otherUser } = await factory.users.create({
        data: {
          email: 'test+{#}@example.com',
        },
        organization,
        userRole: 'admin',
      });

      let result = await app.get(`/api/v1/user/${otherUser.id}`);
      expect(result.statusCode).toEqual(403);
    });

    it('should disallow user to show another superadmin user (as admin)', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email: 'test+{#}@example.com',
        },
        userRole: 'admin',
      });

      let { user: otherUser } = await factory.users.create({
        data: {
          email: 'test+{#}@example.com',
        },
        organization,
        userRole: 'superadmin',
      });

      let result = await app.get(`/api/v1/user/${otherUser.id}`);
      expect(result.statusCode).toEqual(403);
      expect(result.body).toEqual('Forbidden');
    });

    it('should allow user to show another admin user (as superadmin)', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email: 'test+{#}@example.com',
        },
        userRole: 'superadmin',
      });

      let { user: otherUser } = await factory.users.create({
        data: {
          email: 'test+{#}@example.com',
        },
        organization,
        userRole: 'admin',
      });

      let result = await app.get(`/api/v1/user/${otherUser.id}`);
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toEqual(await otherUser.serializeAttributes());
    });

    it('should disallow user to show another superadmin user (as superadmin)', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email: 'test+{#}@example.com',
        },
        userRole: 'superadmin',
      });

      let { user: otherUser } = await factory.users.create({
        data: {
          email: 'test+{#}@example.com',
        },
        organization,
        userRole: 'superadmin',
      });

      let result = await app.get(`/api/v1/user/${otherUser.id}`);
      expect(result.statusCode).toEqual(403);
    });

    it('should allow user to show another user (as masteradmin)', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email: 'test+{#}@example.com',
        },
        userRole: 'masteradmin',
      });

      let { user: otherUser } = await factory.users.create({
        data: {
          email: 'test+{#}@example.com',
        },
        organization,
      });

      let result = await app.get(`/api/v1/user/${otherUser.id}`);
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toEqual(await otherUser.serializeAttributes());
    });

    it('should allow user to show another user (as support)', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email: 'test+{#}@example.com',
        },
        userRole: 'support',
      });

      let { user: otherUser } = await factory.users.create({
        data: {
          email: 'test+{#}@example.com',
        },
        organization,
      });

      let result = await app.get(`/api/v1/user/${otherUser.id}`);
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toEqual(await otherUser.serializeAttributes());
    });
  });

  describe('list', () => {
    it('should fail if user is not logged in', async () => {
      await factory.users.create();

      let result = await app.get('/api/v1/users');
      expect(result.statusCode).toEqual(401);
      expect(result.body).toEqual('Unauthorized');
    });

    it('should succeed if user is not an admin (but should only list the current user)', async () => {
      let { user } = await factory.users.createAndLogin();

      let result = await app.get('/api/v1/users');
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(1);
      expect(data[0].id).toEqual(user.id);
    });

    it('should succeed if user is an admin', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email:     'test+admin@example.com',
          firstName: 'Super1',
          lastName:  'Admin',
        },
        userRole: 'admin',
      });

      let counter = 1;

      // These users should be filtered out:

      await factory.users.create({
        data: {
          email:     'test+masteradmin@example.com',
          firstName: 'Master',
          lastName:  'Admin',
        },
        userRole: 'masteradmin',
      });

      await factory.users.create({
        data: {
          email:     'test+support@example.com',
          firstName: 'Support',
          lastName:  'User',
        },
        userRole: 'support',
      });

      await factory.users.create({
        data: {
          email:     'test+superadmin@example.com',
          firstName: 'Super2',
          lastName:  'Admin',
        },
        organization,
        userRole: 'superadmin',
      });

      // Admin should be able to see these users:

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      let result = await app.get('/api/v1/users');
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(5);
      expect(Nife.pluck('email', data)).toEqual([
        'test+admin@example.com',
        'user+1@example.com',
        'user+2@example.com',
        'user+3@example.com',
        'user+4@example.com',
      ]);
      expect(data[0].roles).toEqual(['admin']);
      expect(data[1].roles).toEqual(['member']);
      expect(data[2].roles).toEqual(['member']);
      expect(data[3].roles).toEqual(['member']);
      expect(data[4].roles).toEqual(['member']);
    });

    it('should succeed if user is a superadmin', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email:     'test+superadmin1@example.com',
          firstName: 'Super1',
          lastName:  'Admin',
        },
        userRole: 'superadmin',
      });

      let counter = 1;

      // These users should be filtered out:

      await factory.users.create({
        data: {
          email:     'test+masteradmin@example.com',
          firstName: 'Master',
          lastName:  'Admin',
        },
        organization,
        userRole: 'masteradmin',
      });

      await factory.users.create({
        data: {
          email:     'test+support@example.com',
          firstName: 'Support',
          lastName:  'User',
        },
        organization,
        userRole: 'support',
      });

      // Superadmin should be able to see these users:

      await factory.users.create({
        data: {
          email:     'test+admin@example.com',
          firstName: 'Admin',
          lastName:  'User',
        },
        organization,
        userRole: 'admin',
      });

      await factory.users.create({
        data: {
          email:     'test+superadmin2@example.com',
          firstName: 'Super2',
          lastName:  'Admin',
        },
        organization,
        userRole: 'superadmin',
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      let result = await app.get('/api/v1/users');
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(6);
      expect(Nife.pluck('email', data)).toEqual([
        'test+admin@example.com',
        'test+superadmin1@example.com',
        'user+1@example.com',
        'user+2@example.com',
        'user+3@example.com',
        'user+4@example.com',
      ]);

      expect(data[0].roles).toEqual([ 'admin' ]);
      expect(data[1].roles).toEqual([ 'superadmin' ]);
      expect(data[2].roles).toEqual([ 'member' ]);
      expect(data[3].roles).toEqual([ 'member' ]);
      expect(data[4].roles).toEqual([ 'member' ]);
      expect(data[5].roles).toEqual([ 'member' ]);
    });

    it('should succeed if user is a support user', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email:     'test+support1@example.com',
          firstName: 'Support1',
          lastName:  'User',
        },
        addToOrganization:  false,
        userRole:           'support',
      });

      let counter = 1;

      // These users should be filtered out:

      await factory.users.create({
        data: {
          email:     'test+masteradmin@example.com',
          firstName: 'Master',
          lastName:  'Admin',
        },
        userRole: 'masteradmin',
      });

      await factory.users.create({
        data: {
          email:     'test+support2@example.com',
          firstName: 'Support2',
          lastName:  'User',
        },
        userRole: 'support',
      });

      // Support user should be able to see these users:

      await factory.users.create({
        data: {
          email:     'test+admin@example.com',
          firstName: 'Admin',
          lastName:  'User',
        },
        organization,
        userRole: 'admin',
      });

      await factory.users.create({
        data: {
          email:     'test+superadmin1@example.com',
          firstName: 'Super1',
          lastName:  'Admin',
        },
        organization,
        userRole: 'superadmin',
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      let result = await app.get('/api/v1/users');
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(7);
      expect(Nife.pluck('email', data)).toEqual([
        'test+admin@example.com',
        'test+superadmin1@example.com',
        'test+support1@example.com',
        'user+1@example.com',
        'user+2@example.com',
        'user+3@example.com',
        'user+4@example.com',
      ]);

      expect(data[0].roles).toEqual(['admin']);
      expect(data[1].roles).toEqual(['superadmin']);
      expect(data[2].roles).toEqual(['support']);
      expect(data[3].roles).toEqual(['member']);
      expect(data[4].roles).toEqual(['member']);
      expect(data[5].roles).toEqual(['member']);
      expect(data[6].roles).toEqual(['member']);
    });

    it('should succeed if user is a masteradmin', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email:     'test+masteradmin1@example.com',
          firstName: 'Master1',
          lastName:  'Admin',
        },
        userRole: 'masteradmin',
      });

      let counter = 1;

      // Masteradmin user should be able to see these users:

      await factory.users.create({
        data: {
          email:     'test+masteradmin2@example.com',
          firstName: 'Master2',
          lastName:  'Admin',
        },
        organization,
        userRole: 'masteradmin',
      });

      await factory.users.create({
        data: {
          email:     'test+support@example.com',
          firstName: 'Support1',
          lastName:  'User',
        },
        organization,
        userRole: 'support',
      });

      await factory.users.create({
        data: {
          email:     'test+admin@example.com',
          firstName: 'Admin',
          lastName:  'User',
        },
        organization,
        userRole: 'admin',
      });

      await factory.users.create({
        data: {
          email:     'test+superadmin@example.com',
          firstName: 'Super',
          lastName:  'Admin',
        },
        organization,
        userRole: 'superadmin',
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      let result = await app.get('/api/v1/users');
      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(9);
      expect(Nife.pluck('email', data)).toEqual([
        'test+admin@example.com',
        'test+masteradmin1@example.com',
        'test+masteradmin2@example.com',
        'test+superadmin@example.com',
        'test+support@example.com',
        'user+1@example.com',
        'user+2@example.com',
        'user+3@example.com',
        'user+4@example.com',
      ]);

      expect(data[0].roles).toEqual([ 'admin' ]);
      expect(data[1].roles).toEqual([ 'masteradmin' ]);
      expect(data[2].roles).toEqual([ 'masteradmin' ]);
      expect(data[3].roles).toEqual([ 'superadmin' ]);
      expect(data[4].roles).toEqual([ 'support' ]);
      expect(data[5].roles).toEqual([ 'member' ]);
      expect(data[6].roles).toEqual([ 'member' ]);
      expect(data[7].roles).toEqual([ 'member' ]);
      expect(data[8].roles).toEqual([ 'member' ]);
    });

    it('should succeed if user is a masteradmin while specifying a specific organization', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email:     'test+masteradmin1@example.com',
          firstName: 'Master1',
          lastName:  'Admin',
        },
        userRole: 'masteradmin',
      });

      let { organization: organization2 } = await factory.organizations.create();

      let counter = 1;

      // Masteradmin user should be able to see these users:

      await factory.users.create({
        data: {
          email:     'test+masteradmin2@example.com',
          firstName: 'Master2',
          lastName:  'Admin',
        },
        organization,
        userRole: 'masteradmin',
      });

      await factory.users.create({
        data: {
          email:     'test+support@example.com',
          firstName: 'Support1',
          lastName:  'User',
        },
        organization,
        userRole: 'support',
      });

      await factory.users.create({
        data: {
          email:      'test+admin@example.com',
          firstName:  'Admin',
          lastName:   'User',
        },
        organization: organization2,
        userRole:     'admin',
      });

      await factory.users.create({
        data: {
          email:      'test+superadmin@example.com',
          firstName:  'Super',
          lastName:   'Admin',
        },
        organization: organization2,
        userRole:     'superadmin',
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:      `user+${counter}@example.com`,
          firstName:  `Test${counter++}`,
          lastName:   'User',
        },
        organization: organization2,
      });

      await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await factory.users.create({
        data: {
          email:      `user+${counter}@example.com`,
          firstName:  `Test${counter++}`,
          lastName:   'User',
        },
        organization: organization2,
      });

      let result = await app.post('/api/v1/users', {
        data: {
          filter: {
            organizationID: organization2.id,
          },
        },
      });

      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(7);
      expect(Nife.pluck('email', data)).toEqual([
        'test+admin@example.com',
        'test+masteradmin1@example.com',
        'test+masteradmin2@example.com',
        'test+superadmin@example.com',
        'test+support@example.com',
        'user+2@example.com',
        'user+4@example.com',
      ]);

      // expect(data[0].roles).toEqual([ 'admin' ]);
      // expect(data[1].roles).toEqual([ 'masteradmin' ]);
      // expect(data[2].roles).toEqual([ 'masteradmin' ]);
      // expect(data[3].roles).toEqual([ 'superadmin' ]);
      // expect(data[4].roles).toEqual([ 'support' ]);
      // expect(data[5].roles).toEqual([ 'member' ]);
      // expect(data[6].roles).toEqual([ 'member' ]);
      // expect(data[7].roles).toEqual([ 'member' ]);
      // expect(data[8].roles).toEqual([ 'member' ]);
    });

    it('should be able to filter', async () => {
      let { organization } = await factory.users.createAndLogin({
        userData: {
          email:     'test+admin@example.com',
          firstName: 'Admin',
          lastName:  'User',
        },
        userRole: 'admin',
      });

      let counter = 1;

      // Masteradmin user should be able to see these users:

      let { user: masterAdminUser } = await factory.users.create({
        data: {
          email:     'test+masteradmin@example.com',
          firstName: 'Master',
          lastName:  'Admin',
        },
        organization,
        userRole: 'masteradmin',
      });

      let { user: supportUser } = await factory.users.create({
        data: {
          email:     'test+support@example.com',
          firstName: 'Support1',
          lastName:  'User',
        },
        organization,
        userRole: 'support',
      });

      let { user: superAdminUser } = await factory.users.create({
        data: {
          email:     'test+superadmin@example.com',
          firstName: 'Super',
          lastName:  'Admin',
        },
        organization,
        userRole: 'superadmin',
      });

      let { user: user1 } = await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      let { user: user2 } = await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      let { user: user3 } = await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      let { user: user4 } = await factory.users.create({
        data: {
          email:     `user+${counter}@example.com`,
          firstName: `Test${counter++}`,
          lastName:  'User',
        },
        organization,
      });

      await user1.addTags(organization, [ 'group1', 'group2' ]);
      await user2.addTags(organization, [ 'group1', 'group3' ]);
      await user3.addTags(organization, [ 'group3', 'group4' ]);
      await user4.addTags(organization, [ 'group4', 'other' ]);

      // Search by user name
      let result = await app.post('/api/v1/users', {
        data: {
          filter: {
            firstName: ['Test1', 'Test2'],
          },
        },
      });

      expect(result.statusCode).toEqual(200);

      let data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(2);
      expect(Nife.pluck('email', data)).toEqual([
        'user+1@example.com',
        'user+2@example.com',
      ]);

      expect(data[0].roles).toEqual(['member']);
      expect(data[1].roles).toEqual(['member']);

      // Search by user id
      // First, select all user ids
      // to ensure they are properly
      // filtered out based on permissions

      result = await app.post('/api/v1/users', {
        data: {
          filter: {
            id: [
              masterAdminUser.id,
              supportUser.id,
              superAdminUser.id,
              user3.id,
              user4.id,
            ],
          },
        },
      });

      expect(result.statusCode).toEqual(200);

      data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(2);
      expect(Nife.pluck('email', data)).toEqual([
        'user+3@example.com',
        'user+4@example.com',
      ]);

      expect(data[0].roles).toEqual(['member']);
      expect(data[1].roles).toEqual(['member']);

      // Search by email
      // First, select all user emails
      // to ensure they are properly
      // filtered out based on permissions
      result = await app.post('/api/v1/users', {
        data: {
          filter: {
            email: [
              masterAdminUser.email,
              supportUser.email,
              superAdminUser.email,
              user1.email,
              user2.email,
            ],
          },
        },
      });

      expect(result.statusCode).toEqual(200);

      data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(2);
      expect(Nife.pluck('email', data)).toEqual([
        'user+1@example.com',
        'user+2@example.com',
      ]);

      expect(data[0].roles).toEqual(['member']);
      expect(data[1].roles).toEqual(['member']);

      // Search by tags
      result = await app.post('/api/v1/users', {
        data: {
          filter: {
            tags: [ 'group1' ],
          },
        },
      });

      expect(result.statusCode).toEqual(200);

      data = result.body.data;
      expect(data).toBeInstanceOf(Array);
      expect(data.length).toEqual(2);
      expect(Nife.pluck('email', data)).toEqual([
        'user+1@example.com',
        'user+2@example.com',
      ]);

      expect(data[0].roles).toEqual(['member']);
      expect(data[1].roles).toEqual(['member']);
    });
  });
});
