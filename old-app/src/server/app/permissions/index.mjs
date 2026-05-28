import {
  PermissionBase,
  setPermissionClasses,
} from './permission-base.mjs';

import * as PermissionClasses from './permission-classes/index.mjs';
export * from './permission-classes/index.mjs';

setPermissionClasses(PermissionClasses);

// This module is the framework for permission checking.
// It works by instantiating permission classes by name.
// For example, if I check a permission such as:
// this.permissible('update:User');
// then the "User" permission class will be instantiated,
// and the "canUpdate" method on that class will be called.
// Permission methods are asynchronous, because they often
// need to read from the DB.
// Permission checking methods can return any value.
// The permission check 'failed' only if the return
// value from a permission checking method is "false",
// or an instance of "Error", or if the permission
// checking method throws an error.
// Allowing permission checking methods to return values,
// is by design, and is for performance reasons. For
// example, it is often necessary not only to check
// that a user has the proper permissions requested,
// but also to then know the roles that user has.
// User roles are one of the common return values from
// permission checking methods.

export const getPermissionClass = PermissionBase.getPermissionClass.bind(PermissionBase);

export {
  PermissionBase,
};

