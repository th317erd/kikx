import {
  ControllerBase as _ControllerBase,
  MythixORMUtils,
} from 'mythix';

import Nife               from 'nife';
import Utils              from '../utils/index.mjs';
import { PermissionBase } from '../permissions/index.mjs';

// This is the base parent controller
// that all other controllers inherit from.
// It just provides common functionality
// for all other controllers.

export class ControllerBase extends _ControllerBase {
  constructor(...args) {
    super(...args);

    Object.defineProperties(this, {
      'currentUser': {
        enumberable:  false,
        configurable: true,
        get:          () => {
          if (!this.request)
            return null;

          return this.request.user;
        },
        set:          () => {},
      },
    });
  }

  getAuthTokenCookieName() {
    let app = this.getApplication();
    return app.getAuthTokenCookieName();
  }

  isValidID(id, modelName) {
    return Utils.isValidID(id, modelName);
  }

  // Simple stub for I18N
  langTerm(...args) {
    return Utils.langTerm(...args);
  }

  // This overloads mythix error methods
  // to inject an error "code" into each
  // error thrown.
  prepareToThrowError(ErrorClass, args) {
    let error     = super.prepareToThrowError(ErrorClass, args);
    let errorCode = args[1];

    if (errorCode)
      error.headers['X-Error-Code'] = errorCode;

    return error;
  }

  // This will re-throw known errors.
  // If the error is unknown, then it
  // will simply fall through so it can
  // be handled elsewhere.
  rethrowIfKnown(error) {
    if (this.isHTTPError(error))
      throw error;

    if (error instanceof Utils.ErrorBase) {
      if (error instanceof Utils.ForbiddenError)
        this.throwForbiddenError(error.message, error.code);
      else if (error instanceof Utils.UnauthorizedError)
        this.throwUnauthorizedError(error.message, error.code);
      else if (error instanceof Utils.NotFoundError)
        this.throwNotFoundError(error.message, error.code);
      else if (error instanceof Utils.ValidationError)
        this.throwBadRequestError(error.message, error.code);
    }
  }

  // This will fetch properties
  // from the specified scopes
  // (params, body, query).
  // Any property key that contains
  // an exclamation point is "required",
  // and if not present, a 400 Bad Request
  // will be thrown.
  // Properties can also have values in the
  // object provided, which must be one of
  // 1) A string, which specifies an "alias"
  // for the target property, or
  // 2) A function, which specifies a formatter
  // for the specified property, or
  // 3) "null" if you simply want to collect
  // the property, and don't want an alias or
  // a formatter for the property's value.
  getParams(params, _sources, _opts) {
    let sources   = _sources;
    let opts      = _opts || {};
    let defaults  = opts.defaults;
    let type      = opts.type;

    if (!(sources instanceof Array))
      sources = [ sources ];

    let finalParams   = {};
    let paramKeys     = Object.keys(params);
    let missingParams = [];

    for (let j = 0, jl = paramKeys.length; j < jl; j++) {
      let paramKey    = paramKeys[j];
      let paramHelper = params[paramKey];
      let required    = false;

      if (paramKey.indexOf('!') >= 0) {
        paramKey = paramKey.replace(/!/g, '');
        required = true;
      }

      let storageKey = paramKey;
      if (typeof paramHelper === 'string')
        storageKey = paramHelper;

      for (let i = 0, il = sources.length; i < il; i++) {
        let source  = sources[i];
        let value   = source[paramKey];

        if (Nife.isEmpty(value) && defaults) {
          value = defaults[paramKey];

          if (Nife.isEmpty(value))
            continue;
        } else {
          if (Nife.isEmpty(value))
            continue;

          if (typeof paramHelper === 'function')
            value = paramHelper.call(this, value, source);
        }

        finalParams[storageKey] = value;

        break;
      }

      if (!Object.prototype.hasOwnProperty.call(finalParams, storageKey)) {
        if (opts.nullMissing)
          finalParams[storageKey] = null;

        if (required)
          missingParams.push(paramKey);
      }
    }

    if (missingParams.length > 0) {
      if (missingParams.length === 1) {
        let paramsStr = missingParams.map((paramName) => `"${paramName}"`).join('');
        this.throwBadRequestError(`${paramsStr} ${(type) ? `${type} ` : ''}is required`, 'bad-request');
      } else {
        let allParams = [].concat(
          missingParams.slice(0, -1).map((paramName) => `"${paramName}"`),
          'and ' + (missingParams.slice(-1).map((paramName) => `"${paramName}"`)[0]),
        );

        let paramsStr = allParams.join(', ');
        this.throwBadRequestError(`${paramsStr} ${(type) ? `${type}s ` : ''}are required`, 'bad-request');
      }
    }

    return finalParams;
  }

  // This is a wrapper around the "currentUser"
  // to check if the "currentUser" has the permissions
  // specified. An 403 Forbidden error will be thrown
  // if the user doesn't have the permissions requested.
  async permissible(..._args) {
    const isPermissible = async (args) => {
      if (!this.currentUser)
        return false;

      try {
        return await this.currentUser.permissible.apply(this.currentUser, args);
      } catch (error) {
        return error;
      }
    };

    let opts = _args[0];
    if (!opts || typeof opts === 'string')
      opts = {};

    let permit = await isPermissible(_args);
    if (PermissionBase.isDenial(permit)) {
      if (opts.throwError !== false) {
        if (permit instanceof Error)
          this.throwForbiddenError(permit.message);
        else
          this.throwForbiddenError();
      }

      return false;
    }

    return permit;
  }

  // Generic helper method to parse
  // order, limit, and offset from any request.
  getLimitOffsetOrder(_sources) {
    let sources = Nife.toArray(_sources).filter(Boolean);
    let limit   = 20;
    let offset  = 0;
    let order   = null;

    for (let i = 0, il = sources.length; i < il; i++) {
      let source    = sources[i];
      let hasLimit  = Object.prototype.hasOwnProperty.call(source, 'limit');
      let hasOffset = Object.prototype.hasOwnProperty.call(source, 'offset');
      let hasOrder  = Object.prototype.hasOwnProperty.call(source, 'order');

      if (hasLimit || hasOffset || hasOrder) {
        if (hasLimit) {
          limit = Nife.coerceValue(source.limit, 'number', null);
          if (limit == null)
            this.throwBadRequestError('"limit" malformed', 'bad-request');
        }

        if (hasOffset) {
          offset = Nife.coerceValue(source.offset, 'number', null);
          if (offset == null)
            this.throwBadRequestError('"offset" malformed', 'bad-request');
        }

        // TODO: Need to ensure this is a fully qualified name
        if (hasOrder) {
          order = ('' + source.order).trim();

          let prefixChar = order.charAt(0);
          if (prefixChar !== '+' && prefixChar !== '-')
            order = `+${order}`;
          else
            order = `${prefixChar}${order.replace(/^[+-]+/, '')}`;
        }

        break;
      }
    }

    return { limit, offset, order };
  }

  // This will take a "query object"
  // and convert it into a Mythix ORM query
  generateQueryFromFilter(Model, filter) {
    if (Nife.isEmpty(filter))
      return;

    return MythixORMUtils.generateQueryFromFilter(this.getConnection(), Model, filter);
  }

  // This will fetch the specified user from the DB.
  // If the user is not found, it will fallback to
  // the "defaultValue" provided.
  async getTargetUser(targetUserID, defaultValue) {
    let app = this.getApplication();
    let User = app.getModel('User');
    let user;

    if (Nife.isNotEmpty(targetUserID)) {
      if (!Utils.isValidID(targetUserID))
        this.throwNotFoundError('User not found', 'user-not-found');

      user = await User.$.id.EQ(targetUserID).first();
      if (!user)
        this.throwNotFoundError('User not found', 'user-not-found');
    }

    if (!user) {
      if (defaultValue && defaultValue instanceof User)
        return defaultValue;

      this.throwNotFoundError('User not found', 'user-not-found');
    }

    return user;
  }

  getAndVerifyRequestFiles() {
    let app               = this.getApplication();
    let httpServer        = app.getHTTPServer();
    let httpServerOptions = httpServer.getOptions();
    let uploadPath        = Nife.get(httpServerOptions, 'uploads.path');

    // Security: ensure upload path is set... if not, fail hard
    if (Nife.isEmpty(uploadPath))
      this.throwInternalServerError('ControllerBase::getAndVerifyRequestFiles: HTTP Server upload path is empty. Refusing to continue.');

    let files       = this.request.files;
    let keys        = Object.keys(files || {});
    let finalFiles  = {};

    for (let i = 0, il = keys.length; i < il; i++) {
      let key       = keys[i];
      let thisFile  = files[key];
      let fileObj   = {
        done:       thisFile.done,
        encoding:   thisFile.encoding,
        field:      thisFile.field,
        filePath:   thisFile.file,
        fileName:   thisFile.filename,
        mimeType:   thisFile.mimetype,
        truncated:  thisFile.truncated,
        uuid:       thisFile.uuid,
      };

      // Security: ensure file paths are what we
      // expect them to be... if not, fail hard
      if (!fileObj.filePath.startsWith(uploadPath))
        this.throwInternalServerError(`ControllerBase::getAndVerifyRequestFiles: File upload path doesn't match file upload location. Refusing to continue. File path: ${fileObj.filePath}`);

      if (Nife.isEmpty(fileObj.fileName))
        this.throwBadRequestError('"filename" field required in multipart upload', 'file-name-not-supplied');

      finalFiles[key] = fileObj;
    }

    return finalFiles;
  }
}
