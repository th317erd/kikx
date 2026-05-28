import {
  createTestApplication,
  createFactories,
  createRunners,
} from '../../../support/application.mjs';

import Utils from '../../../../app/utils/index.mjs';
import * as EmailTemplates from '../../../../app/templates/email/index.mjs';

describe('ModelBase', function() {
  let app;
  let models;
  let factory;

  // eslint-disable-next-line no-unused-vars
  const { it, fit } = createRunners(() => app.getConnection());

  beforeAll(async () => {
    app = await createTestApplication();
    models = app.getModels();
    factory = createFactories(app);
  });

  afterAll(async () => {
    await app.stop();
  });

  afterEach(async () => {
    factory.reset();

    await app.truncateAllTables();
  });

  describe('getEmailTemplateClassFromTemplateName', () => {
    it('should be able to generate a template method name from a template name', async () => {
      const instance = new models.User();
      expect(instance.getEmailTemplateClassFromTemplateName('auth/signIn')).toBe(EmailTemplates.AuthSignInEmailTemplate);
    });

    it('should strip any prefixing forward slashes', async () => {
      const instance = new models.User();
      expect(instance.getEmailTemplateClassFromTemplateName('//auth/signIn')).toBe(EmailTemplates.AuthSignInEmailTemplate);
    });

    it('should return template name postfixing with "Template" if no template identifier given', async () => {
      const instance = new models.User();
      expect(instance.getEmailTemplateClassFromTemplateName('auth/signIn')).toBe(EmailTemplates.AuthSignInEmailTemplate);
    });
  });

  describe('isValidID', () => {
    it('should be able to check if a value is a XID', async () => {
      const instance = new models.User();
      expect(instance.isValidID('derp')).toBe(false);
      expect(instance.isValidID(null)).toBe(false);
      expect(instance.isValidID(undefined)).toBe(false);
      expect(instance.isValidID(NaN)).toBe(false);
      expect(instance.isValidID(Infinity)).toBe(false);
      expect(instance.isValidID({})).toBe(false);
      expect(instance.isValidID([])).toBe(false);
      expect(instance.isValidID(1)).toBe(false);
      expect(instance.isValidID(true)).toBe(false);
    });
  });

  describe('throwForbiddenError', () => {
    it('should be able to throw an error', async () => {
      const instance = new models.Role();

      try {
        instance.throwForbiddenError('test');
        fail('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(Utils.ForbiddenError);
        expect(error.message).toEqual('test');
        expect(error.code).toEqual('operation-not-permitted');
      }
    });
  });
});
