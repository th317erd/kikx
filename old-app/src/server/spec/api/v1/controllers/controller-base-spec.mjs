/* eslint-disable no-magic-numbers */
/* eslint-disable camelcase */

import { ControllerBase } from '../../../../app/controllers/controller-base.mjs';
import {
  createTestApplication,
  createFactories,
  createRunners,
} from '../../../support/application.mjs';
import { HTTPErrors } from 'mythix';

describe('ControllerBase', function() {
  let app;
  let factory;

  // eslint-disable-next-line no-unused-vars
  const { it, fit } = createRunners(() => app.getConnection());

  beforeAll(async () => {
    app = await createTestApplication();
    factory = createFactories(app);
  });

  afterAll(async () => {
    await app.stop();
  });

  afterEach(async () => {
    factory.reset();

    jasmine.clock().uninstall();
    await app.truncateAllTables();
  });

  describe('prepareToThrowError', () => {
    it('should add error code header', async () => {
      const instance = new ControllerBase(app);
      let error = instance.prepareToThrowError(HTTPErrors.HTTPBadRequestError, [ 'Test Error', 'test-error-code' ]);

      expect(error).toBeInstanceOf(HTTPErrors.HTTPBadRequestError);
      expect(error.message).toEqual('Test Error');
      expect(error.headers['X-Error-Code']).toEqual('test-error-code');
    });

    it('should add error code header when call through an error raising method', async () => {
      const instance = new ControllerBase(app);

      try {
        instance.throwBadRequestError('Test Error', 'test-error-code');
        fail('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPErrors.HTTPBadRequestError);
        expect(error.message).toEqual('Test Error');
        expect(error.headers['X-Error-Code']).toEqual('test-error-code');
      }
    });
  });

  describe('getParams', () => {
    it('should succeed with one source', async () => {
      const instance = new ControllerBase(app);

      let result = instance.getParams({
        email:      null,
        firstName:  'first_name',
        lastName:   (value) => `DERP->${value}`,
      }, { email: 'test.user@example.com', firstName: 'Test', lastName: 'User' });

      expect(result).toEqual({
        email:      'test.user@example.com',
        first_name: 'Test',
        lastName:   'DERP->User',
      });
    });

    it('should null missing fields if requested', async () => {
      const instance = new ControllerBase(app);

      let result = instance.getParams({
        email:      null,
        firstName:  'first_name',
        lastName:   (value) => `DERP->${value}`,
      }, { email: 'test.user@example.com', lastName: 'User' }, { nullMissing: true });

      expect(result).toEqual({
        email:      'test.user@example.com',
        first_name: null,
        lastName:   'DERP->User',
      });
    });

    it('should succeed with multiple sources', async () => {
      const instance = new ControllerBase(app);

      let result = instance.getParams({
        email:      null,
        firstName:  'first_name',
        lastName:   (value) => `DERP->${value}`,
      }, [ { email: 'test.user@example.com' }, { firstName: 'Test' }, { lastName: 'User' } ]);

      expect(result).toEqual({
        email:      'test.user@example.com',
        first_name: 'Test',
        lastName:   'DERP->User',
      });
    });

    it('should fail when required field is empty', async () => {
      const instance = new ControllerBase(app);

      const callback = () => {
        instance.getParams({
          'email!':   null,
          firstName:  'first_name',
          lastName:   (value) => `DERP->${value}`,
        }, [ { firstName: 'Test' }, { lastName: 'User' } ]);
      };

      expect(callback).toThrow(new HTTPErrors.HTTPBadRequestError(null, '"email" is required'));
    });

    it('should fail when required fields are empty', async () => {
      const instance = new ControllerBase(app);

      const callback = () => {
        instance.getParams({
          'email!':     null,
          '!firstName': 'first_name',
          lastName:     (value) => `DERP->${value}`,
        }, [ { lastName: 'User' } ]);
      };

      expect(callback).toThrow(new HTTPErrors.HTTPBadRequestError(null, '"email", and "firstName" are required'));
    });
  });

  describe('getLimitOffsetOrder', () => {
    it('should be able to get a default limit and offset', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset } = instance.getLimitOffsetOrder();

      // eslint-disable-next-line no-magic-numbers
      expect(limit).toEqual(20);
      expect(offset).toEqual(0);
    });

    it('should be able specify a limit', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset } = instance.getLimitOffsetOrder({ limit: 100 });

      // eslint-disable-next-line no-magic-numbers
      expect(limit).toEqual(100);
      expect(offset).toEqual(0);
    });

    it('should be able specify an offset', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset } = instance.getLimitOffsetOrder({ offset: 100 });

      expect(limit).toEqual(20);
      expect(offset).toEqual(100);
    });

    it('should be able specify a limit and an offset', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset } = instance.getLimitOffsetOrder({ limit: 10, offset: 100 });

      expect(limit).toEqual(10);
      expect(offset).toEqual(100);
    });

    it('should be able use string values', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset } = instance.getLimitOffsetOrder({ limit: '10', offset: '100' });

      expect(limit).toEqual(10);
      expect(offset).toEqual(100);
    });

    it('should throw error on parsing issue', async () => {
      const instance = new ControllerBase(app);
      expect(() => instance.getLimitOffsetOrder({ limit: 'derp' })).toThrow(new HTTPErrors.HTTPBadRequestError(null, '"limit" malformed'));
      expect(() => instance.getLimitOffsetOrder({ offset: 'derp' })).toThrow(new HTTPErrors.HTTPBadRequestError(null, '"offset" malformed'));
    });

    it('should be able to specify order #1', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset, order } = instance.getLimitOffsetOrder({ limit: '10', offset: '100', order: 'derp' });
      expect(limit).toEqual(10);
      expect(offset).toEqual(100);
      expect(order).toEqual('+derp');
    });

    it('should be able to specify order #2', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset, order } = instance.getLimitOffsetOrder({ limit: '10', offset: '100', order: '+derp' });
      expect(limit).toEqual(10);
      expect(offset).toEqual(100);
      expect(order).toEqual('+derp');
    });

    it('should be able to specify order #3', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset, order } = instance.getLimitOffsetOrder({ limit: '10', offset: '100', order: '-derp' });
      expect(limit).toEqual(10);
      expect(offset).toEqual(100);
      expect(order).toEqual('-derp');
    });

    it('should be able to specify order #3', async () => {
      const instance = new ControllerBase(app);

      let { limit, offset, order } = instance.getLimitOffsetOrder({ limit: '10', offset: '100', order: ' -+derp ' });
      expect(limit).toEqual(10);
      expect(offset).toEqual(100);
      expect(order).toEqual('-derp');
    });
  });

  describe('permissible', () => {
    it('should fail without currentUser being set', async () => {
      let { user } = await factory.users.create();

      // Ensure it succeeds with a user set
      try {
        const successInstance = new ControllerBase(app, null, { user });
        await successInstance.permissible('view:User', user);
      } catch (error) {
        fail('unreachable');
      }

      // Now ensure it fails without a user set
      try {
        const failureInstance = new ControllerBase(app);
        await failureInstance.permissible('view:User', user);
        fail('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPErrors.HTTPForbiddenError);
        expect(error.message).toEqual('Forbidden');
      }
    });

    it('should fail if permission checker throws an error', async () => {
      let { user } = await factory.users.create();

      spyOn(user, 'permissible').and.callFake(async () => {
        throw new Error('Derpy pants failed');
      });

      try {
        const failureInstance = new ControllerBase(app, null, { user });
        await failureInstance.permissible('view:User', user);
        fail('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPErrors.HTTPForbiddenError);
        expect(error.message).toEqual('Derpy pants failed');
      }
    });

    it('should fail if permission checker returns an error', async () => {
      let { user } = await factory.users.create();

      spyOn(user, 'permissible').and.callFake(async () => {
        return new Error('Derpy pants failed');
      });

      try {
        const failureInstance = new ControllerBase(app, null, { user });
        await failureInstance.permissible('view:User', user);
        fail('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPErrors.HTTPForbiddenError);
        expect(error.message).toEqual('Derpy pants failed');
      }
    });

    it('should fail if permission checker returns false', async () => {
      let { user } = await factory.users.create();

      spyOn(user, 'permissible').and.callFake(async () => {
        return false;
      });

      try {
        const failureInstance = new ControllerBase(app, null, { user });
        await failureInstance.permissible('view:User', user);
        fail('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPErrors.HTTPForbiddenError);
        expect(error.message).toEqual('Forbidden');
      }
    });

    it('should fail if permission checker returns undefined', async () => {
      let { user } = await factory.users.create();

      spyOn(user, 'permissible').and.callFake(async () => {
        return;
      });

      try {
        const failureInstance = new ControllerBase(app, null, { user });
        await failureInstance.permissible('view:User', user);
        fail('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPErrors.HTTPForbiddenError);
        expect(error.message).toEqual('Forbidden');
      }
    });

    it('should fail if permission checker returns null', async () => {
      let { user } = await factory.users.create();

      spyOn(user, 'permissible').and.callFake(async () => {
        return null;
      });

      try {
        const failureInstance = new ControllerBase(app, null, { user });
        await failureInstance.permissible('view:User', user);
        fail('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPErrors.HTTPForbiddenError);
        expect(error.message).toEqual('Forbidden');
      }
    });

    it('should return result instead of throwing if requested to do so', async () => {
      let { user } = await factory.users.create();

      spyOn(user, 'permissible').and.callFake(async () => {
        return new Error('Derp');
      });

      const failureInstance = new ControllerBase(app, null, { user });
      let result = await failureInstance.permissible({ operation: 'view', scope: 'User', throwError: false }, user);
      expect(result).toBe(false);
    });
  });
});
