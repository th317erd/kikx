import {
  createTestApplication,
  createFactories,
  createRunners,
} from '../../../support/application.mjs';

describe('APIInterfaceController', function() {
  let app;
  let models;
  let factory;
  let API;

  // eslint-disable-next-line no-unused-vars
  const { it, fit } = createRunners(() => app.getConnection());

  beforeAll(async () => {
    app = await createTestApplication();
    models = app.getModels();
    factory = createFactories(app);

    let apiResponse = await app.get('/api/v1/client-interface.js', {
      data: {
        domain:       app.getDefaultURL(),
        environment:  'node',
        globalName:   'none',
        type:         'module',
      },
    });

    let body = apiResponse.body.toString('utf8');

    // eslint-disable-next-line no-eval
    API = eval(body);
    await API.loaded();
  });

  afterAll(async () => {
    await app.stop();
  });

  afterEach(async () => {
    API.setDefaultHeaders({
      'Authorization':      null,
      'X-Organization-ID':  null,
    });

    factory.reset();

    jasmine.clock().uninstall();
    await app.truncateAllTables();
  });

  const fetchValues = (args) => args;

  describe('API', () => {
    it('should be able to get a user', async () => {
      let { user, organization, sessionToken } = await factory.users.createAndLogin(fetchValues);

      API.setDefaultHeaders({
        'Authorization':      `Bearer ${sessionToken}`,
        'X-Organization-ID':  organization.id,
      });

      let fetchedUser = await API.getUser({ params: { userID: user.id } });
      expect(fetchedUser.body.data.id).toEqual(user.id);
    });

    it('should be able to update a user', async () => {
      let { user, organization, sessionToken } = await factory.users.createAndLogin(fetchValues);

      API.setDefaultHeaders({
        'Authorization':      `Bearer ${sessionToken}`,
        'X-Organization-ID':  organization.id,
      });

      let fetchedUser = await API.updateUser({ params: { userID: user.id }, data: { firstName: 'Derp', lastName: 'Burp' } });
      expect(fetchedUser.body.data.id).toEqual(user.id);
      expect(fetchedUser.body.data.firstName).toEqual('Derp');
      expect(fetchedUser.body.data.lastName).toEqual('Burp');

      // Reload to ensure changes were persisted to the DB
      user = await models.User.$.id.EQ(user.id).first();
      expect(user.id).toEqual(user.id);
      expect(user.firstName).toEqual('Derp');
      expect(user.lastName).toEqual('Burp');
    });
  });
});
