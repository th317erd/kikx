import Nife   from 'nife';
import Utils  from '../utils/index.mjs';

// PermissionBase class handles all permission requests.
// It will instantiate a permission handler class based
// on a "scope" name. The scope name is what postfixes the
// permission action, i.e. a permission check of 'update:User'
// has a "scope" of "User" (the scope is what comes after
// the colon). Once the permission class is instantiated
// from the scope name, then the permission checker method
// is called based on the permission being checked. For
// example, checking a permission of "update:User", will
// instantiate the UserPermissions class, and call the
// "canUpdate" method to check permissions.
// Permission checker methods can and do return values
// (such as the user's roles), so it is important to
// call "PermissionBase.isDenial(result)" on any result
// returned from a permission checker to see if the permission
// was denied. Falsy values, and instanceof Error results
// are considered "denials". If a permission handler throws
// an error that will also count as a denial.

let permissionClasses = {};

export function setPermissionClasses(klasses) {
  permissionClasses = klasses;
}

export class PermissionBase {
  // Get operation name (permission method checker name)
  // from the provided options or string.
  static getOperation(opts) {
    if (!opts)
      return;

    if (typeof opts === 'string')
      return opts.replace(/^(\w+)(:+.*)?/, '$1');

    if (opts.operation)
      return opts.operation;
  }

  // Get scope name (permission instance class name)
  // from the provided options or string.
  static getScopeName(opts) {
    if (!opts)
      return;

    if (typeof opts === 'string')
      return opts.replace(/^(\w+):+(.*)/, '$2');

    if (opts.scope)
      return opts.scope;
  }

  // Get the arguments provided to the permission checker method.
  // This is needed because it is possible to call permission
  // checks in multiple different ways.
  static getArgs(opts, args) {
    if (!opts)
      return [];

    if (typeof opts === 'string')
      return (Array.isArray(args)) ? args : [];

    if (opts.args)
      return (Array.isArray(opts.args)) ? opts.args : [];

    return [];
  }

  // Find the correct permission class based on scope name.
  // If this fails, then a "denial" of the permission is
  // automatic and immediate.
  static getPermissionClass(opts) {
    const findPermissionClass = (scopeName) => {
      let klassNames = Object.keys(permissionClasses);

      for (let i = 0, il = klassNames.length; i < il; i++) {
        let klassName       = klassNames[i];
        let Klass           = permissionClasses[klassName];
        let classScopeName  = Klass.getScopeName();

        if (classScopeName === scopeName)
          return Klass;
      }
    };

    let scopeName = PermissionBase.getScopeName(opts);
    return findPermissionClass(scopeName);
  }

  // Check if an action is permissible for the "currentUser"
  static async permissible(application, currentUser, ...args) {
    let instance = new PermissionBase(application, currentUser);
    return await instance.permissible(...args);
  }

  // Check if a permission checker result is a denial
  static isDenial(result) {
    if (result === false || result == null || result instanceof Error)
      return true;

    return false;
  }

  constructor(application, currentUser) {
    Object.defineProperties(this, {
      'application': {
        writable:     false,
        enumberable:  false,
        configurable: true,
        value:        application,
      },
      'currentUser': {
        writable:     false,
        enumberable:  false,
        configurable: false,
        value:        currentUser,
      },
    });
  }

  getApplication() {
    return this.application;
  }

  getLogger() {
    let application = this.getApplication();
    return application.getLogger();
  }

  getModel(name) {
    let application = this.getApplication();
    return application.getModel(name);
  }

  getModels() {
    let application = this.getApplication();
    return application.getModels();
  }

  async permissible(...args) {
    const Klass               = PermissionBase.getPermissionClass(args[0]);
    const permissionInstance  = new Klass(this.getApplication(), this.currentUser);

    return await permissionInstance.can(...args);
  }

  async can(opts, ...args) {
    let operation = this.constructor.getOperation(opts);
    let methodKey = `can${Nife.capitalize(operation)}`;

    if (typeof this[methodKey] !== 'function')
      return false;

    try {
      return await this[methodKey].apply(this, this.constructor.getArgs(opts, args));
    } catch (error) {
      return error;
    }
  }

  isDenial(result) {
    return PermissionBase.isDenial(result);
  }

  // Arguments to permission checkers can be provided in multiple ways.
  // For example, an organization might be provided, or maybe just the
  // ID of the organization. The following two methods are simple utility
  // methods for permission checker methods to fetch the correct data
  // they need.
  getOrganizationID(organization) {
    let organizationID;

    if (Utils.isValidID(organization))
      organizationID = organization;
    else if (organization)
      organizationID = organization.id;

    organizationID = organizationID || this.currentUser.getCurrentOrganizationID();

    if (Nife.isEmpty(organizationID))
      throw new Error('Specified organization not found');

    return organizationID;
  }

  getUserID(user) {
    let userID;

    if (Utils.isValidID(user))
      userID = user;
    else if (user)
      userID = user.id;

    if (Nife.isEmpty(userID))
      throw new Error('Specified user not found');

    return userID;
  }
}
