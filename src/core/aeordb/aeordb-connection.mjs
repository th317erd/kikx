'use strict';

import { AeorDBClient } from './aeordb-client.mjs';
import { DIRECTORY_PAGE_LIMIT } from './aeordb-frame-store-constants.mjs';
import { DatabaseConnectionBase } from '../database/database-connection-base.mjs';
import { DatabaseError } from '../database/database-error.mjs';

// AeorDB server caps a single listDirectory page; `entries()` pages at that
// size so streaming never asks for an unbounded result set.
const STREAM_PAGE_SIZE = DIRECTORY_PAGE_LIMIT;

// Built-in database driver wrapping the existing AeorDBClient verbatim. The
// client remains the only place that knows AeorDB's HTTP/auth surface; this
// class translates its errors to `DatabaseError` and exposes the modern
// document contract the rest of the driver layer speaks.
export class AeorDBConnection extends DatabaseConnectionBase {
  static driverID = 'aeordb';
  static displayName = 'AeorDB';
  static description = 'Document store backed by an AeorDB server.';
  static capabilities = {
    read: true,
    write: true,
    mergePatch: true,
    list: true,
    getMany: true,
    search: true,
    query: true,
    events: true,
    auth: true,
    ranges: true,
  };
  static configFields = [
    {
      name: 'baseURL',
      label: 'baseURL',
      type: 'text',
      required: true,
      help: 'AeorDB base URL, e.g. http://127.0.0.1:6830',
    },
    {
      name: 'token',
      label: 'token',
      type: 'text',
      required: false,
      secret: true,
      help: 'AeorDB bearer token',
    },
  ];
  static configKeys = [
    '/aeordb/url',
    '/aeordb/token',
  ];
  // AeorDB has no generic multi-document transaction endpoint, so batch() is
  // sequential and non-transactional (documented for the frame-store layer).
  static batchAtomicity = 'best-effort';

  constructor(options = {}) {
    super(options);
    this.client = options.client || new AeorDBClient({
      baseURL: options.baseURL || options.url || options.secrets?.url || options.secrets?.baseURL,
      token: options.token ?? options.secrets?.token ?? '',
      timeoutMS: options.timeoutMS,
      fetchImpl: options.fetchImpl,
    });
    this._connected = false;
  }

  get baseURL() {
    return this.client?.baseURL;
  }

  get token() {
    return this.client?.token;
  }

  async connect() {
    if (this._connected)
      return this;

    this._connected = true;
    return this;
  }

  async close() {
    this._connected = false;
  }

  async put(path, body, options = {}) {
    assertPath(path);
    try {
      return await this.client.putFile(path, body, options);
    } catch (error) {
      throw toDatabaseError(error, path);
    }
  }

  async get(path, options = {}) {
    assertPath(path);
    let requestOptions = { ...options };
    if (requestOptions.raw === true) {
      delete requestOptions.raw;
      requestOptions.expectJSON = false;
    }

    try {
      return await this.client.getFile(path, requestOptions);
    } catch (error) {
      if (error?.status === 404)
        return null;

      throw toDatabaseError(error, path);
    }
  }

  async merge(path, patch, options = {}) {
    assertPath(path);
    try {
      return await this.client.patchFile(path, patch, options);
    } catch (error) {
      throw toDatabaseError(error, path);
    }
  }

  async delete(path, options = {}) {
    assertPath(path);
    try {
      return await this.client.deleteFile(path, options);
    } catch (error) {
      throw toDatabaseError(error, path);
    }
  }

  async list(path, options = {}) {
    let { recursive = false, glob, limit, offset } = options;
    let depth = recursive ? -1 : 1;

    let result;
    try {
      result = await this.client.listDirectory(path || '/', { depth, glob, limit, offset });
    } catch (error) {
      throw toDatabaseError(error, path);
    }

    let rawItems = Array.isArray(result?.items) ? result.items : [];
    let items = [];
    for (let item of rawItems) {
      let itemPath = item?.path || item?.['@path'];
      if (!itemPath || typeof itemPath !== 'string')
        continue;

      items.push({ path: ensureLeadingSlash(itemPath) });
    }

    let total = typeof result?.total === 'number' ? result.total : items.length;
    let hasMore = result?.has_more ?? result?.hasMore ?? false;
    return { items, total, hasMore };
  }

  async *entries(path, options = {}) {
    let offset = 0;
    while (true) {
      let page = await this.list(path, { ...options, limit: STREAM_PAGE_SIZE, offset });
      for (let item of page.items)
        yield item;

      if (page.items.length < STREAM_PAGE_SIZE)
        break;

      offset += page.items.length;
      if (typeof page.total === 'number' && offset >= page.total)
        break;
    }
  }

  async getMany(paths, options = {}) {
    try {
      return await this.client.fetchFiles(paths, options);
    } catch (error) {
      throw toDatabaseError(error, paths);
    }
  }

  async search(search, options = {}) {
    try {
      return await this.client.searchFiles(search, options);
    } catch (error) {
      throw toDatabaseError(error, search);
    }
  }

  async query(query, options = {}) {
    try {
      return await this.client.queryFiles(query, options);
    } catch (error) {
      throw toDatabaseError(error, query);
    }
  }

  async getRanges(items, options = {}) {
    try {
      return await this.client.fetchFileRanges(items, options);
    } catch (error) {
      throw toDatabaseError(error, items);
    }
  }

  // Index configuration is a driver concern: AeorDB persists each index
  // document through its client, matching the historical per-document putFile
  // writes the stores used to perform directly.
  async configureIndexes(configs = []) {
    for (let config of configs)
      await this.client.putFile(config.path, config.body);
  }

  eventsURL(params = {}) {
    return this.client.eventsURL(params);
  }

  async auth() {
    return this;
  }

  async batch(operations) {
    if (!Array.isArray(operations))
      throw new TypeError('batch() operations must be an array');

    for (let operation of operations) {
      if (!operation || typeof operation !== 'object')
        throw new TypeError('batch() operations must contain objects');

      let { type, path, body, options } = operation;
      if (type === 'put')
        await this.put(path, body, options);
      else if (type === 'merge')
        await this.merge(path, body);
      else if (type === 'delete')
        await this.delete(path);
      else
        throw new TypeError('Unknown batch operation type: ' + type);
    }

    return { applied: operations.length };
  }

  // --- AeorDB auth passthrough ---------------------------------------------
  // Not part of the base document contract; these keep AccountStore working
  // during P1/P2 while drivers (postgresql/sqlite) grow their own auth story.
  withToken(token) {
    let client = this._delegate('withToken', [ token ]);
    let connection = new AeorDBConnection({
      client,
      context: this.context,
      config: this.config,
      secrets: this.secrets,
    });
    connection._connected = this._connected;
    return connection;
  }

  request(method, path, options = {}) {
    return this._delegate('request', [ method, path, options ]);
  }

  listOwnAPIKeys(options = {}) {
    return this._delegate('listOwnAPIKeys', [ options ]);
  }

  getSystemUser(userID, options = {}) {
    return this._delegate('getSystemUser', [ userID, options ]);
  }

  updateSystemUser(userID, body, options = {}) {
    return this._delegate('updateSystemUser', [ userID, body, options ]);
  }

  requestMagicLink(email, options = {}) {
    return this._delegate('requestMagicLink', [ email, options ]);
  }

  verifyMagicLink(code, options = {}) {
    return this._delegate('verifyMagicLink', [ code, options ]);
  }

  exchangeAPIKey(apiKey, options = {}) {
    return this._delegate('exchangeAPIKey', [ apiKey, options ]);
  }

  refreshToken(refreshToken, options = {}) {
    return this._delegate('refreshToken', [ refreshToken, options ]);
  }

  _delegate(method, args = []) {
    let fn = this.client?.[method];
    if (typeof fn !== 'function')
      throw new Error(`AeorDBConnection client does not support ${method}()`);

    return fn.apply(this.client, args);
  }
}

function assertPath(path) {
  if (!path || typeof path !== 'string')
    throw new TypeError('AeorDBConnection path must be a non-empty string');
}

function ensureLeadingSlash(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

function toDatabaseError(error, path) {
  if (error instanceof DatabaseError)
    return error;

  return new DatabaseError(error?.message || String(error), {
    status: error?.status || 0,
    code: statusCode(error?.status),
    cause: error,
  });
}

function statusCode(status) {
  if (status === 404)
    return 'not_found';

  if (status === 401)
    return 'unauthorized';

  if (status === 403)
    return 'forbidden';

  if (status === 409)
    return 'conflict';

  return null;
}
