/* eslint-disable camelcase */

import {
  PermissionBase,
  UserPermissions,
  OrganizationPermissions,
} from '../../app/permissions/index.mjs';

import {
  createTestApplication,
  createFactories,
  createRunners,
} from '../support/application.mjs';

describe('PermissionBase', function() {
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

    jasmine.clock().uninstall();
    await app.truncateAllTables();
  });

  describe('getOperation', () => {
    it('should return undefined if no options provided', () => {
      expect(PermissionBase.getOperation()).toBe(undefined);
      expect(PermissionBase.getOperation('')).toBe(undefined);
      expect(PermissionBase.getOperation(0)).toBe(undefined);
      expect(PermissionBase.getOperation(null)).toBe(undefined);
    });

    it('should fetch operation if options is a string', () => {
      expect(PermissionBase.getOperation('test:User')).toEqual('test');
      expect(PermissionBase.getOperation('test2:User')).toEqual('test2');
    });

    it('should fetch operation if options an object', () => {
      expect(PermissionBase.getOperation({ operation: 'test' })).toEqual('test');
      expect(PermissionBase.getOperation({ operation: 'test2' })).toEqual('test2');
      expect(PermissionBase.getOperation({ operation: undefined })).toBe(undefined);
    });
  });

  describe('getScopeName', () => {
    it('should return undefined if no options provided', () => {
      expect(PermissionBase.getScopeName()).toBe(undefined);
      expect(PermissionBase.getScopeName('')).toBe(undefined);
      expect(PermissionBase.getScopeName(0)).toBe(undefined);
      expect(PermissionBase.getScopeName(null)).toBe(undefined);
    });

    it('should fetch scope name if options is a string', () => {
      expect(PermissionBase.getScopeName('test:User')).toEqual('User');
      expect(PermissionBase.getScopeName('test2:User')).toEqual('User');
    });

    it('should fetch scope name if options an object', () => {
      expect(PermissionBase.getScopeName({ scope: 'test' })).toEqual('test');
      expect(PermissionBase.getScopeName({ scope: 'test2' })).toEqual('test2');
      expect(PermissionBase.getScopeName({ scope: undefined })).toBe(undefined);
    });
  });

  describe('getArgs', () => {
    it('should return empty array if no options provided', () => {
      expect(PermissionBase.getArgs()).toEqual([]);
      expect(PermissionBase.getArgs('')).toEqual([]);
      expect(PermissionBase.getArgs(0)).toEqual([]);
      expect(PermissionBase.getArgs(null)).toEqual([]);
    });

    it('should return empty array if args array not provided', () => {
      let args = [];

      expect(PermissionBase.getArgs('update:User')).toEqual([]);
      expect(PermissionBase.getArgs('update:User', '')).toEqual([]);
      expect(PermissionBase.getArgs('update:User', 0)).toEqual([]);
      expect(PermissionBase.getArgs('update:User', null)).toEqual([]);
      expect(PermissionBase.getArgs('update:User', 1)).toEqual([]);
      expect(PermissionBase.getArgs('update:User', true)).toEqual([]);
      expect(PermissionBase.getArgs('update:User', 'test')).toEqual([]);
      expect(PermissionBase.getArgs('update:User', args)).toBe(args);
      expect(PermissionBase.getArgs('update:User', [ 'test' ])).toEqual([ 'test' ]);
    });

    it('should return args array from options if options is an object', () => {
      let args = [];
      expect(PermissionBase.getArgs({})).toEqual([]);
      expect(PermissionBase.getArgs({ args })).toBe(args);
      expect(PermissionBase.getArgs({ args: true })).toEqual([]);
      expect(PermissionBase.getArgs({ args: false })).toEqual([]);
      expect(PermissionBase.getArgs({ args: 1 })).toEqual([]);
      expect(PermissionBase.getArgs({ args: 'test' })).toEqual([]);
      expect(PermissionBase.getArgs({ args: {} })).toEqual([]);
    });
  });

  describe('getPermissionClass', () => {
    it('should return a permission class if options is a string', () => {
      expect(PermissionBase.getPermissionClass('update:User')).toBe(UserPermissions);
      expect(PermissionBase.getPermissionClass('User')).toBe(UserPermissions);
      expect(PermissionBase.getPermissionClass('list:Organization')).toBe(OrganizationPermissions);
    });

    it('should return a permission class if options is an object', () => {
      expect(PermissionBase.getPermissionClass({ scope: 'User' })).toBe(UserPermissions);
      expect(PermissionBase.getPermissionClass({ scope: 'Organization' })).toBe(OrganizationPermissions);
    });

    it('should return undefined if no permission class found', () => {
      expect(PermissionBase.getPermissionClass({ scope: 'derp' })).toBe(undefined);
      expect(PermissionBase.getPermissionClass('')).toBe(undefined);
    });
  });

  describe('isDenial', () => {
    it('should work from an instance', () => {
      let permissionBase = new PermissionBase(app);

      // These are all denial conditions
      expect(permissionBase.isDenial(false)).toBe(true);
      expect(permissionBase.isDenial(new Error())).toBe(true);
      expect(permissionBase.isDenial(null)).toBe(true);

      // None of these should be denial conditions
      expect(permissionBase.isDenial(true)).toBe(false);
      expect(permissionBase.isDenial('')).toBe(false);
      expect(permissionBase.isDenial('test')).toBe(false);
      expect(permissionBase.isDenial(0)).toBe(false);
      expect(permissionBase.isDenial(1)).toBe(false);
      expect(permissionBase.isDenial([])).toBe(false);
      expect(permissionBase.isDenial([ null ])).toBe(false);
      expect(permissionBase.isDenial([ new Error() ])).toBe(false);
      expect(permissionBase.isDenial([ false ])).toBe(false);
      expect(permissionBase.isDenial({})).toBe(false);
      expect(permissionBase.isDenial(BigInt(1))).toBe(false);
    });

    it('should be able to properly detect a permission denial', () => {
      // These are all denial conditions
      expect(PermissionBase.isDenial(false)).toBe(true);
      expect(PermissionBase.isDenial(new Error())).toBe(true);
      expect(PermissionBase.isDenial(null)).toBe(true);

      // None of these should be denial conditions
      expect(PermissionBase.isDenial(true)).toBe(false);
      expect(PermissionBase.isDenial('')).toBe(false);
      expect(PermissionBase.isDenial('test')).toBe(false);
      expect(PermissionBase.isDenial(0)).toBe(false);
      expect(PermissionBase.isDenial(1)).toBe(false);
      expect(PermissionBase.isDenial([])).toBe(false);
      expect(PermissionBase.isDenial([ null ])).toBe(false);
      expect(PermissionBase.isDenial([ new Error() ])).toBe(false);
      expect(PermissionBase.isDenial([ false ])).toBe(false);
      expect(PermissionBase.isDenial({})).toBe(false);
      expect(PermissionBase.isDenial(BigInt(1))).toBe(false);
    });
  });

  describe('getApplication', () => {
    it('should return the application instance', () => {
      let app = {};
      let permissionBase = new PermissionBase(app);

      expect(permissionBase.getApplication()).toBe(app);
    });
  });

  describe('getLogger', () => {
    it('should return the logger instance', () => {
      let logger = {};
      let app = { getLogger: () => logger };
      let permissionBase = new PermissionBase(app);

      expect(permissionBase.getLogger()).toBe(logger);
    });
  });

  describe('getModel', () => {
    it('should fetch a model', () => {
      let permissionBase = new PermissionBase(app);
      expect(permissionBase.getModel('User')).toBe(models.User);
    });
  });

  describe('getModel', () => {
    it('should fetch all models', () => {
      let permissionBase = new PermissionBase(app);
      expect(permissionBase.getModels().User).toBe(models.User);
    });
  });
});
