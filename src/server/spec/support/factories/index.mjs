import * as FactoryUtils from './factory-utils.mjs';
import * as OrganizationFactories from './organization-factories.mjs';
import * as UserFactories from './user-factories.mjs';

function rebindAllToApplication(application, scope) {
  const rebindMethod = (application, method) => {
    return async function(_args, _callback) {
      let args;
      let callback;

      if (typeof _args === 'function') {
        callback = _args;
        args = {};
      } else {
        args = _args || {};
        callback = _callback;
      }

      return await method.call(application, args, callback);
    };
  };

  let boundScope  = {};
  let keys        = Object.keys(scope);

  for (let i = 0, il = keys.length; i < il; i++) {
    let key   = keys[i];
    let value = scope[key];

    if (typeof value === 'function')
      value = rebindMethod(application, value);

    boundScope[key] = value;
  }

  return boundScope;
}

function createFactories(application) {
  return {
    'reset':                  () => {
      FactoryUtils.resetUUIDCounter();

      application.setDefaultHeader('Authorization', null);
      application.setDefaultHeader('X-Organization-ID', null);
    },
    'organizations':          rebindAllToApplication(application, OrganizationFactories),
    'users':                  rebindAllToApplication(application, UserFactories),
  };
}

export {
  createFactories,
};
