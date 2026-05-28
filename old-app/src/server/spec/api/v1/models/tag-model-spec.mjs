
import {
  createTestApplication,
  createFactories,
  createRunners,
  PREFIXED_XID_REGEXP,
} from '../../../support/application.mjs';

describe('TagModel', function() {
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
    it('should be able to create a Tag model', async () => {
      let { user, organization } = await factory.users.createWithOrganization(fetchValues);
      let [ tag ] = await models.Tag.createFor(user, 'test', organization);

      expect(tag.id).toMatch(PREFIXED_XID_REGEXP);
      expect(tag.name).toEqual('test');

      let tags = await user.getTags(organization);
      expect(tags).toBeInstanceOf(Array);
      expect(tags.length).toEqual(1);
      expect(tags.map((tag) => tag.name)).toEqual([ 'test' ]);

      let tagSource = await tags[0].getSource();
      expect(tagSource).toBeInstanceOf(models.User);
      expect(tagSource.id).toEqual(user.id);

      let tagTarget = await tags[0].getTarget();
      expect(tagTarget).toBeInstanceOf(models.Organization);
      expect(tagTarget.id).toEqual(organization.id);

      // Shouldn't create duplicate tags
      await user.addTags(organization, [ 'test', 'derp' ]);

      tags = await user.getTags(organization);
      expect(tags).toBeInstanceOf(Array);
      expect(tags.length).toEqual(2);
      expect(tags.map((tag) => tag.name).sort()).toEqual([
        'derp',
        'test',
      ]);
    });
  });
});
