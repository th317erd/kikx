/* eslint-disable no-magic-numbers */

import {
  createTestApplication,
  createFactories,
  createRunners,
  PREFIXED_XID_REGEXP,
} from '../../../support/application.mjs';

describe('UserModel', function() {
  let app;
  let models;
  let factory;

  // eslint-disable-next-line no-unused-vars
  const { it, fit } = createRunners(() => app.getConnection());

  beforeAll(async () => {
    try {
      app = await createTestApplication();
      factory = createFactories(app);
      models = app.getModels();
    } catch (error) {
      console.error('Error in beforeAll: ', error);
    }
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
    it('should be able to create a user model', async () => {
      let { user } = await factory.users.create();

      let userData = user.toJSON();

      expect(userData.id).toMatch(PREFIXED_XID_REGEXP);
      expect(userData.email).toEqual('test1@example.com');
      expect(userData.phone).toEqual('15604520919');
      expect(userData.firstName).toEqual('Test');
      expect(userData.lastName).toEqual('User');
      expect(userData.dob).toEqual('2000-01-01');
    });
  });

  describe('destroy', () => {
    it('should not delete organization when user is deleted', async () => {
      expect(await models.Organization.count()).toEqual(0);
      expect(await models.OrganizationUserLink.count()).toEqual(0);

      let { user } = await factory.users.createWithOrganization();

      expect(await models.Organization.count()).toEqual(1);
      expect(await models.OrganizationUserLink.count()).toEqual(1);

      await user.destroy();

      expect(await models.Organization.count()).toEqual(1);
      expect(await models.OrganizationUserLink.count()).toEqual(0);
    });
  });

  describe('requestLoginToken', () => {
    it('should be able to send an email', async () => {
      let { user } = await factory.users.create();

      spyOn(user, 'sendEmail').and.callThrough();

      await user.requestLoginToken();

      expect(user.sendEmail).toHaveBeenCalled();
      expect(user.sendEmail.calls.count()).toEqual(1);

      let callArgs = user.sendEmail.calls.first().args;
      expect(callArgs).toBeInstanceOf(Array);
      expect(callArgs.length).toEqual(2);
      expect(callArgs[0]).toEqual('auth/signIn');
      expect(callArgs[1]).toBeInstanceOf(Object);

      let notification = await models.Notification.first();
      let emailBodyMatch;

      notification.content.replace(/<a\s+href\s*=\s*"(https:\/\/test\.hero\.com\/api\/v1\/auth\/login[^"]+)/i, (m, href) => {
        emailBodyMatch = href;
      });

      expect((/https:\/\/test\.hero\.com\/api\/v1\/auth\/login\?magicToken=[A-Za-z0-9_=-]+/).test(emailBodyMatch)).toEqual(true);
    });
  });

  describe('isMemberOfOrganization', () => {
    it('should be able to validate that a user is a member of an organization', async () => {
      let { user } = await factory.users.create();
      let { organization } = await factory.organizations.create();

      expect(await user.isMemberOfOrganization(organization)).toEqual(false);

      await organization.addUser(user);
      expect(await user.isMemberOfOrganization(organization)).toEqual(true);

      await models.Role.createFor(user, 'admin', organization);
      expect(await user.isMemberOfOrganization(organization)).toEqual(true);

      await organization.removeUser(user);
      // All organization rules should have been removed at this point
      expect(await user.isMemberOfOrganization(organization)).toEqual(false);
    });

    it('should be able to validate that a user is a member of an organization via id', async () => {
      let { user } = await factory.users.create();
      let { organization } = await factory.organizations.create();

      expect(await user.isMemberOfOrganization(organization.id)).toEqual(false);

      await organization.addUser(user);
      expect(await user.isMemberOfOrganization(organization.id)).toEqual(true);
    });

    it('should be able to validate that a user is a member of an organization with null argument', async () => {
      let { user } = await factory.users.create();
      let { organization } = await factory.organizations.create();

      expect(await user.isMemberOfOrganization(organization.id)).toEqual(false);

      await organization.addUser(user);
      expect(await user.isMemberOfOrganization(organization.id)).toEqual(true);
      expect(await user.isMemberOfOrganization(null)).toEqual(false);
    });
  });

  describe('addTags', () => {
    it('should be able to add user tags', async () => {
      let { user, organization } = await factory.users.createWithOrganization();

      let tags = await user.addTags(organization, [ 'test1', 'test2' ]);
      expect(tags).toBeInstanceOf(Array);
      expect(tags.length).toEqual(2);
      expect(tags[0].name).toEqual('test1');
      expect(tags[1].name).toEqual('test2');
    });

    it('should not add empty tags', async () => {
      let { user, organization } = await factory.users.createWithOrganization();

      let tags = await user.addTags(organization, [ 'test1', '   ', null, undefined ]);
      expect(tags).toBeInstanceOf(Array);
      expect(tags.length).toEqual(1);
      expect(tags[0].name).toEqual('test1');
    });

    it('should not add tags that already exist', async () => {
      let { user, organization } = await factory.users.createWithOrganization();

      let tags = await user.addTags(organization, [ 'test1', 'test2' ]);
      expect(tags).toBeInstanceOf(Array);
      expect(tags.length).toEqual(2);
      expect(tags[0].name).toEqual('test1');
      expect(tags[1].name).toEqual('test2');

      await user.addTags(organization, [ 'test1', 'test2' ]);

      tags = await user.getTags(organization);
      expect(tags).toBeInstanceOf(Array);
      expect(tags.length).toEqual(2);
      expect(tags[0].name).toEqual('test1');
      expect(tags[1].name).toEqual('test2');
    });

    it('should not add duplicate tags', async () => {
      let { user, organization } = await factory.users.createWithOrganization();

      let tags = await user.addTags(organization, [ 'test', 'test' ]);
      expect(tags).toBeInstanceOf(Array);
      expect(tags.length).toEqual(1);
      expect(tags[0].name).toEqual('test');
    });
  });

  describe('removeTags', () => {
    it('should be able to remove user tags', async () => {
      let { user: user1, organization: organization1 } = await factory.users.createWithOrganization({ userData: { email: 'test01-user@example.com' } });
      let { user: user2, organization: organization2 } = await factory.users.createWithOrganization({ userData: { email: 'test02-user@example.com' } });

      await user1.addTags(organization1, [ 'test1', 'test2' ]);
      await user2.addTags(organization2, [ 'test3', 'test4' ]);

      expect(await user1.countTags(organization1)).toEqual(2);
      expect(await user2.countTags(organization2)).toEqual(2);

      await user1.removeTags(organization1, [ 'test1' ]);

      expect(await user1.countTags(organization1)).toEqual(1);
      expect(await user2.countTags(organization2)).toEqual(2);

      let tags = await user1.getTags(organization1);
      expect(tags).toBeInstanceOf(Array);
      expect(tags.length).toEqual(1);
      expect(tags[0].name).toEqual('test2');
    });
  });

  describe('getRolesFor', () => {
    it('should be able to fetch user role names', async () => {
      let { user, organization } = await factory.users.createWithOrganization();

      await models.Role.createFor(user, 'admin', organization);
      await models.Role.createFor(user, 'masteradmin');

      let roles = await user.getRolesFor(organization, { namesOnly: true });
      expect(roles).toEqual([
        'admin',
        'masteradmin',
      ]);
    });

    it('should be able to fetch user roles', async () => {
      let { user, organization } = await factory.users.createWithOrganization();

      await models.Role.createFor(user, 'admin', organization);
      await models.Role.createFor(user, 'masteradmin');

      let roles = await user.getRolesFor(organization);
      expect(roles).toBeInstanceOf(Array);
      expect(roles.length).toEqual(2);

      expect(roles[0].name).toEqual('admin');
      expect(roles[0].sourceID).toEqual(user.id);
      expect(roles[0].sourceType).toEqual('User');
      expect(roles[0].targetID).toEqual(organization.id);
      expect(roles[0].targetType).toEqual('Organization');

      expect(roles[1].name).toEqual('masteradmin');
      expect(roles[1].sourceID).toEqual(user.id);
      expect(roles[1].sourceType).toEqual('User');
      expect(roles[1].targetID).toEqual(null);
      expect(roles[1].targetType).toEqual(null);
    });

    it('should be able to fetch user roles specifying role names', async () => {
      let { user, organization } = await factory.users.createWithOrganization(fetchValues);

      await models.Role.createFor(user, 'masteradmin');
      await models.Role.createFor(user, 'superadmin', organization);

      let roles = await user.getRolesFor(organization, { namesOnly: true, names: 'masteradmin' });
      expect(roles).toEqual([ 'masteradmin' ]);

      roles = await user.getRolesFor(organization, { namesOnly: true, names: [ 'masteradmin', 'superadmin' ] });
      expect(roles).toEqual([ 'masteradmin', 'superadmin' ]);

      roles = await user.getRolesFor(organization, { target: organization, names: [ 'masteradmin', 'superadmin' ] });
      expect(roles).toBeInstanceOf(Array);
      expect(roles.length).toEqual(2);

      expect(roles[0].name).toEqual('masteradmin');
      expect(roles[0].sourceID).toEqual(user.id);
      expect(roles[0].sourceType).toEqual('User');
      expect(roles[0].targetID).toEqual(null);
      expect(roles[0].targetType).toEqual(null);

      expect(roles[1].name).toEqual('superadmin');
      expect(roles[1].sourceID).toEqual(user.id);
      expect(roles[1].sourceType).toEqual('User');
      expect(roles[1].targetID).toEqual(organization.id);
      expect(roles[1].targetType).toEqual('Organization');
    });
  });

  describe('hasRolesFor', () => {
    it('should be able to check if a user has the specified roles', async () => {
      let { user, organization } = await factory.users.createWithOrganization();
      await models.Role.createFor(user, 'support');

      expect(await user.hasRolesFor(organization, { names: [ 'member', 'derp' ] })).toEqual([ 'member' ]);
      expect(await user.hasRolesFor(organization, { names: [ 'support', 'derp' ] })).toEqual([ 'support' ]);
      expect(await user.hasRolesFor(organization, { names: [ 'support', 'member' ] })).toEqual([ 'member', 'support' ]);
    });

    it('should be able to check if a user has the exact roles specified', async () => {
      let { user, organization } = await factory.users.createWithOrganization({ userRole: 'admin' });
      await models.Role.createFor(user, 'support');

      expect(await user.hasRolesFor(organization, { names: [ 'admin', 'derp' ], exact: true })).toEqual(false);
      expect(await user.hasRolesFor(organization, { names: [ 'admin' ], exact: true })).toEqual([ 'admin' ]);
      expect(await user.hasRolesFor(organization, { names: [ 'support' ], exact: true })).toEqual([ 'support' ]);
    });

    it('should return false if empty arguments provided', async () => {
      let { user } = await factory.users.create();
      expect(await user.hasRolesFor()).toEqual(false);
      expect(await user.hasRolesFor(null, {})).toEqual(false);
    });

    it('should return false if names are empty', async () => {
      let { user } = await factory.users.create();
      expect(await user.hasRolesFor(null, { names: null })).toEqual(false);
      expect(await user.hasRolesFor(null, { names: [] })).toEqual(false);
    });
  });

  describe('serializeAttributes', () => {
    it('should be able to serialize attributes', async () => {
      let { user } = await factory.users.create();
      let data = await user.serializeAttributes();

      expect(data.createdAt).toBeInstanceOf(String);
      expect(data.updatedAt).toBeInstanceOf(String);
      delete data.createdAt;
      delete data.updatedAt;

      expect(data).toEqual({
        id:         data.id,
        email:      'test1@example.com',
        firstName:  'Test',
        lastName:   'User',
        phone:      '+1-560-452-0919',
        dob:        '2000-01-01',
        roles:      [],
        tags:       [],
      });
    });

    it('should be able to serialize roles (fetching as models)', async () => {
      let { user } = await factory.users.createWithOrganization();
      let data = await user.serializeAttributes();

      expect(data.createdAt).toBeInstanceOf(String);
      expect(data.updatedAt).toBeInstanceOf(String);
      delete data.createdAt;
      delete data.updatedAt;

      expect(data).toEqual({
        id:         data.id,
        email:      'test1@example.com',
        firstName:  'Test',
        lastName:   'User',
        phone:      '+1-560-452-0919',
        dob:        '2000-01-01',
        roles:      [ 'member' ],
        tags:       [],
      });
    });

    it('should be able to serialize roles (as raw models)', async () => {
      let { user } = await factory.users.createWithOrganization();

      await models.Role.create([
        new models.Role({ name: 'test1', sourceType: 'User', sourceID: user.id }),
        new models.Role({ name: 'test2', sourceType: 'User', sourceID: user.id }),
      ]);

      let data = await user.serializeAttributes();

      expect(data.createdAt).toBeInstanceOf(String);
      expect(data.updatedAt).toBeInstanceOf(String);
      delete data.createdAt;
      delete data.updatedAt;

      expect(data).toEqual({
        id:         data.id,
        email:      'test1@example.com',
        firstName:  'Test',
        lastName:   'User',
        phone:      '+1-560-452-0919',
        dob:        '2000-01-01',
        roles:      [ 'member', 'test1', 'test2' ],
        tags:       [],
      });
    });
  });

  describe('searchOrganizations', () => {
    it('should be able to get organizations with no attributes', async () => {
      let { user } = await factory.users.createWithOrganization();

      let organizations = await user.searchOrganizations();

      expect(organizations).toBeInstanceOf(Array);
      expect(organizations.length).toEqual(1);
    });

    it('should set default limit, offset, and order', async () => {
      let { user } = await factory.users.createWithOrganization();

      spyOn(user, '_getOrganizations').and.callThrough();

      let organizations = await user.searchOrganizations();
      expect(organizations).toBeInstanceOf(Array);
      expect(organizations.length).toEqual(1);

      let args = user._getOrganizations.calls.argsFor(0);
      expect(args.length).toEqual(2);

      let queryEngine   = args[0];
      let queryContext  = queryEngine.getOperationContext();
      expect(queryContext.limit).toEqual(20);
      expect(queryContext.offset).toEqual(0);
      expect(Array.from(queryContext.order.values())).toEqual([
        {
          direction:  '+',
          value:      models.Organization.fields.name,
        },
      ]);
    });

    it('should be able to provide a limit, offset, and order', async () => {
      let { user } = await factory.users.createWithOrganization();

      spyOn(user, '_getOrganizations').and.callThrough();

      let organizations = await user.searchOrganizations({ limit: 100, offset: 50, order: [ '-Organization:id' ] });
      expect(organizations).toBeInstanceOf(Array);
      expect(organizations.length).toEqual(0);

      let args = user._getOrganizations.calls.argsFor(0);
      expect(args.length).toEqual(2);

      let queryEngine   = args[0];
      let queryContext  = queryEngine.getOperationContext();
      expect(queryContext.limit).toEqual(100);
      expect(queryContext.offset).toEqual(50);
    });

    it('should disallow an admin user from pulling other organizations', async () => {
      let { user, organization }  = await factory.users.createWithOrganization({ userRole: 'admin' });

      // Other organization
      await factory.organizations.create();

      let organizations = await user.searchOrganizations();
      expect(organizations).toBeInstanceOf(Array);
      expect(organizations.length).toEqual(1);
      expect(organizations[0].id).toEqual(organization.id);
    });

    it('should be able to list all organizations if a support user', async () => {
      let { user, organization } = await factory.users.createWithOrganization({ orgData: { 'name': 'Derp' }, userRole: 'support' });

      let { organization: organization2 } = await factory.organizations.create({ data: { name: 'Test' } });

      let organizations = await user.searchOrganizations();
      expect(organizations).toBeInstanceOf(Array);
      expect(organizations.length).toEqual(2);
      expect(organizations[0].id).toEqual(organization.id);
      expect(organizations[1].id).toEqual(organization2.id);
    });
  });
});
