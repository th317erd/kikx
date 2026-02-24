/* eslint-disable no-magic-numbers */

import Nife from 'nife';
import {
  createTestApplication,
  createFactories,
  createRunners,
  PREFIXED_XID_REGEXP,
} from '../../../support/application.mjs';

describe('OrganizationModel', function() {
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

  describe('create', () => {
    it('should be able to create an organization model', async () => {
      let { organization } = await factory.organizations.create();
      expect(organization.id).toMatch(PREFIXED_XID_REGEXP);
      expect(organization.name).toEqual('Test');
    });
  });

  describe('inviteUser', () => {
    it('should create a user when inviting if the specified user does not exist', async () => {
      let { organization } = await factory.organizations.create();
      let { user: invitingUser } = await factory.users.create({ organization });

      await models.Role.createFor(invitingUser, 'invite-to-organization', organization);

      spyOn(models.User, 'create').and.callThrough();
      spyOn(models.User.prototype, 'generateSessionToken').and.callFake(() => {
        return { magicLinkURL: 'https://magic-link-url' };
      });

      expect(await models.Notification.count()).toEqual(0);

      let result = await organization.inviteUser(invitingUser, 'test+user@example.com');

      expect(await models.Notification.count()).toEqual(1);

      expect(result.status).toEqual('created');
      expect(result.user).toBeInstanceOf(models.User);
      expect(models.User.create.calls.count()).toEqual(1);
      expect(models.User.create.calls.first().args.length).toEqual(2);
      expect(models.User.create.calls.first().args[0]).toEqual({
        email: 'test+user@example.com',
      });

      let user = await models.User.where.email.EQ('test+user@example.com').first();
      let notification = await models.Notification.first();
      expect(notification.userID).toEqual(user.id);
      expect(notification.category).toEqual('auth/signUp');
    });

    it('should do nothing if the user already exists and is a member of the organization', async () => {
      let { organization }  = await factory.organizations.create();
      let { user: invitingUser }  = await factory.users.create({ organization });
      let { user: user }          = await factory.users.create({ data: { email: 'test+user@example.com' }, organization });

      await models.Role.createFor(invitingUser, 'invite-to-organization', organization);

      spyOn(models.User, 'create').and.callThrough();

      expect(await models.Notification.count()).toEqual(0);

      let result = await organization.inviteUser(invitingUser, user.email);

      expect(await models.Notification.count()).toEqual(0);

      expect(result.status).toEqual('not-modified');
      expect(result.addedRoles).toEqual([]);
      expect(result.user.id).toEqual(user.id);
      expect(models.User.create.calls.count()).toEqual(0);
    });

    it('should disallow adding user roles that the inviting user does not have themselves', async () => {
      let { organization }  = await factory.organizations.create();
      let { user: invitingUser }  = await factory.users.create({ organization });
      let { user: user }          = await factory.users.create({ data: { email: 'test+user@example.com' }, organization });

      await models.Role.createFor(invitingUser, 'invite-to-organization', organization);

      let result = await organization.inviteUser(invitingUser, user.email, [ 'masteradmin', 'support', 'superadmin', 'admin' ]);
      expect(result.status).toEqual('not-modified');
      expect(result.addedRoles).toEqual([]);
      expect(result.user.id).toEqual(user.id);
    });

    it('should allow adding roles to an existing member', async () => {
      let { organization } = await factory.organizations.create();

      let { user: invitingUser }  = await factory.users.create({ organization });
      await models.Role.createFor(invitingUser, 'masteradmin');

      let { user } = await factory.users.create({ data: { email: 'test+user@example.com' }, organization });

      spyOn(models.User, 'create').and.callThrough();

      expect(await models.Notification.count()).toEqual(0);

      let result = await organization.inviteUser(invitingUser, 'test+user@example.com', [ 'superadmin', 'masteradmin' ]);

      expect(await models.Notification.count()).toEqual(1);

      expect(result.status).toEqual('modified');
      expect(result.addedRoles).toEqual([ 'masteradmin' ]);
      expect(result.user).toBeInstanceOf(models.User);
      expect(models.User.create.calls.count()).toEqual(0);

      let notification = await models.Notification.first();
      expect(notification.userID).toEqual(user.id);
      expect(notification.category).toEqual('org/userRolesUpdated');
      expect(notification.subject).toEqual('Your user permissions have been updated');
      expect(notification.content).toMatch(/Your user permissions have been updated for the/);
      expect(notification.content).toMatch(/Master Admin/);
    });
  });

  describe('addUser', () => {
    it('should be able to add a user with a default role', async () => {
      let { organization } = await factory.organizations.create();
      let { user } = await factory.users.create();

      expect(await models.OrganizationUserLink.count()).toEqual(0);

      await organization.addUser(user);

      expect(await models.OrganizationUserLink.count()).toEqual(1);

      let orgs = await user.searchOrganizations();
      expect(orgs).toBeInstanceOf(Array);
      expect(orgs.length).toEqual(1);
      expect(orgs[0].id).toEqual(organization.id);

      let roles = await user.getRolesFor(organization, { namesOnly: true });
      expect(roles).toEqual([
        'member',
      ]);
    });
  });

  describe('removeUser', () => {
    it('should be able to remove a user along with organization roles', async () => {
      let { organization } = await factory.organizations.create();
      let { user } = await factory.users.create();

      expect(await models.OrganizationUserLink.count()).toEqual(0);

      await organization.addUser(user);

      expect(await models.OrganizationUserLink.count()).toEqual(1);

      await organization.removeUser(user);

      expect(await models.User.count()).toEqual(1);
      expect(await models.OrganizationUserLink.count()).toEqual(0);

      let orgs = await user.searchOrganizations();
      expect(orgs).toBeInstanceOf(Array);
      expect(orgs.length).toEqual(0);

      let roles = await user.getRolesFor(organization, { namesOnly: true });
      expect(roles).toEqual([]);
    });
  });

  describe('searchUsers', () => {
    it('should be able to get users without any arguments', async () => {
      let { user, organization } = await factory.users.createWithOrganization(fetchValues);

      let users = await organization.searchUsers();

      expect(users).toBeInstanceOf(Array);
      expect(users.length).toEqual(1);
      expect(users[0].id).toEqual(user.id);
    });

    it('should be able to get users across organizations as masteradmin', async () => {
      let { user, organization } = await factory.users.createWithOrganization({ userData: { email: 'masteradmin1@example.com' }, userRole: 'masteradmin' });

      await factory.users.create({ data: { email: 'support1@example.com' }, organization, userRole: 'support' });
      await factory.users.create({ data: { email: 'superadmin1@example.com' }, organization, userRole: 'superadmin' });
      await factory.users.create({ data: { email: 'admin1@example.com' }, organization, userRole: 'admin' });
      await factory.users.create({ data: { email: 'member1@example.com' }, organization, userRole: 'member' });

      let { organization: organization2 } = await factory.organizations.create();

      await factory.users.create({ data: { email: 'support2@example.com' }, organization: organization2, userRole: 'support' });
      await factory.users.create({ data: { email: 'superadmin2@example.com' }, organization: organization2, userRole: 'superadmin' });
      await factory.users.create({ data: { email: 'admin2@example.com' }, organization: organization2, userRole: 'admin' });
      await factory.users.create({ data: { email: 'member2@example.com' }, organization: organization2, userRole: 'member' });

      let users = await organization.searchUsers({ requestingUser: user });

      expect(users).toBeInstanceOf(Array);
      expect(users.length).toEqual(9);
      expect(Nife.pluck('email', users)).toEqual([
        'masteradmin1@example.com',
        'support1@example.com',
        'superadmin1@example.com',
        'admin1@example.com',
        'member1@example.com',
        'support2@example.com',
        'superadmin2@example.com',
        'admin2@example.com',
        'member2@example.com',
      ]);
    });

    it('should be able to get users across organizations as masteradmin while specifying an organization', async () => {
      let { user, organization } = await factory.users.createWithOrganization({ userData: { email: 'masteradmin1@example.com' }, userRole: 'masteradmin' });

      await factory.users.create({ data: { email: 'support1@example.com' }, organization, userRole: 'support' });
      await factory.users.create({ data: { email: 'superadmin1@example.com' }, organization, userRole: 'superadmin' });
      await factory.users.create({ data: { email: 'admin1@example.com' }, organization, userRole: 'admin' });
      await factory.users.create({ data: { email: 'member1@example.com' }, organization, userRole: 'member' });

      let { organization: organization2 } = await factory.organizations.create();

      await factory.users.create({ data: { email: 'support2@example.com' }, organization: organization2, userRole: 'support' });
      await factory.users.create({ data: { email: 'superadmin2@example.com' }, organization: organization2, userRole: 'superadmin' });
      await factory.users.create({ data: { email: 'admin2@example.com' }, organization: organization2, userRole: 'admin' });
      await factory.users.create({ data: { email: 'member2@example.com' }, organization: organization2, userRole: 'member' });

      let users = await organization.searchUsers({
        requestingUser: user,
        filter:         {
          organizationID: organization2.id,
        },
      });

      expect(users).toBeInstanceOf(Array);
      expect(users.length).toEqual(6);
      expect(Nife.pluck('email', users)).toEqual([
        'masteradmin1@example.com',
        'support1@example.com',
        'support2@example.com',
        'superadmin2@example.com',
        'admin2@example.com',
        'member2@example.com',
      ]);
    });

    it('should be able to provide a filter with user roles', async () => {
      let { user, organization } = await factory.users.createWithOrganization(async (args) => {
        await models.Role.createFor(args.user, 'superadmin', args.organization);
        return args;
      });

      let { user: user1 } = await factory.users.create({ data: { email: 'derpy.pants@example.com', firstName: 'Derpy', lastName: 'Pants' }, organization });

      let users = await organization.searchUsers({
        requestingUser: user,
        filter:         {
          firstName:  'Derpy',
          lastName:   'Pants',
        },
      });

      expect(users).toBeInstanceOf(Array);
      expect(users.length).toEqual(1);
      expect(users[0].id).toEqual(user1.id);
    });

    it('should be able to provide a filter with user roles and user tags', async () => {
      let { user, organization } = await factory.users.createWithOrganization({ userData: { firstName: 'SuperAdmin', lastName: 'Guy' } }, async (args) => {
        await models.Role.createFor(args.user, 'superadmin', args.organization);
        return args;
      });

      let { user: user1 } = await factory.users.create({ data: { firstName: 'Bob', lastName: 'Bro', email: 'test+user1@example.com' }, organization });
      await user1.addTags(organization, [ 'group1', 'group2' ]);

      let { user: user2 } = await factory.users.create({ data: { firstName: 'Carly', lastName: 'Cassandra', email: 'test+user2@example.com' }, organization });
      await user2.addTags(organization, [ 'group1', 'group3' ]);

      let { user: user3 } = await factory.users.create({ data: { firstName: 'Dan', lastName: 'Daniels', email: 'test+user3@example.com' }, organization });
      await user3.addTags(organization, [ 'group2', 'group3', 'group4' ]);

      let users = await organization.searchUsers({
        requestingUser: user,
        filter:         {
          roles:  [ 'member' ],
          tags:   [ 'group1' ],
        },
      });

      expect(users).toBeInstanceOf(Array);
      expect(users.length).toEqual(2);
      expect(users[0].email).toEqual('test+user1@example.com');
      expect(users[1].email).toEqual('test+user2@example.com');

      users = await organization.searchUsers({
        requestingUser: user,
        filter:         {
          tags:   [ 'group4' ],
        },
      });

      expect(users).toBeInstanceOf(Array);
      expect(users.length).toEqual(1);
      expect(users[0].email).toEqual('test+user3@example.com');
    });
  });
});
