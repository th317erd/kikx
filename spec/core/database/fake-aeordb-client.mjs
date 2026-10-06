'use strict';

// In-memory fake of the AeorDBClient surface used by the AeorDB driver specs.
// It mirrors the subset of AeorDB's HTTP API the driver touches, including
// 404-via-thrown-AeorDBError. Each instance owns its own store unless one is
// shared explicitly (see withToken), so tests are isolated.

import { AeorDBError } from '../../../src/core/aeordb/aeordb-client.mjs';
import { applyMergePatch, matchGlob } from './reference-driver.mjs';

export class FakeAeorDBClient {
  constructor(options = {}) {
    this.baseURL = options.baseURL || 'http://fake.aeordb.test';
    this.token = options.token || '';
    this._store = options.store || new Map();

    for (let [ path, body ] of Object.entries(options.documents || {}))
      this._store.set(keyFor(path), JSON.stringify(body));
  }

  withToken(token) {
    return new FakeAeorDBClient({
      baseURL: this.baseURL,
      token,
      store: this._store,
    });
  }

  async getFile(path, options = {}) {
    let key = keyFor(path);
    if (!this._store.has(key))
      throw notFound(path);

    let text = this._store.get(key);
    if (options?.expectJSON === false)
      return text;

    return JSON.parse(text);
  }

  async putFile(path, body, options = {}) {
    let key = keyFor(path);
    let text = options?.raw === true ? String(body ?? '') : JSON.stringify(body ?? null);
    this._store.set(key, text);
    return { path: `/${key}` };
  }

  async patchFile(path, patch, options = {}) {
    let key = keyFor(path);
    if (!this._store.has(key))
      throw notFound(path);

    let merged = applyMergePatch(JSON.parse(this._store.get(key)), patch);
    this._store.set(key, JSON.stringify(merged));
    return merged;
  }

  async deleteFile(path, options = {}) {
    let key = keyFor(path);
    if (!this._store.has(key))
      throw notFound(path);

    this._store.delete(key);
    return {};
  }

  async listDirectory(path, options = {}) {
    let base = keyFor(path);
    let recursive = options.depth == null ? false : Number(options.depth) < 0;
    let glob = options.glob;
    let matches = [];

    for (let [ key, text ] of this._store) {
      if (base && key === base)
        continue;

      if (base && !key.startsWith(`${base}/`))
        continue;

      let relative = base ? key.slice(base.length + 1) : key;
      if (!recursive && relative.includes('/'))
        continue;

      if (glob && !matchGlob(relative, glob))
        continue;

      matches.push({ path: `/${key}`, text });
    }

    // AeorDB returns entries in path order.
    matches.sort((left, right) => {
      if (left.path < right.path)
        return -1;

      if (left.path > right.path)
        return 1;

      return 0;
    });

    let total = matches.length;
    let offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
    let limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : null;
    let page = limit == null ? matches.slice(offset) : matches.slice(offset, offset + limit);

    return {
      items: page.map((entry) => ({ path: entry.path })),
      total,
      has_more: offset + page.length < total,
    };
  }

  async fetchFiles(paths, options = {}) {
    let result = {};
    for (let path of paths) {
      let key = keyFor(path);
      if (!this._store.has(key))
        throw notFound(path);

      result[path] = { path, content: this._store.get(key) };
    }

    return result;
  }

  async searchFiles(search, options = {}) {
    return { items: [], total: 0, results: [] };
  }

  async queryFiles(query, options = {}) {
    return { items: [], total: 0, results: [] };
  }

  async fetchFileRanges(items, options = {}) {
    return { items: [], has_errors: false };
  }

  eventsURL(params = {}) {
    return `${this.baseURL}/system/events`;
  }

  async request(method, path, options = {}) {
    if (method === 'GET' && path === '/system/health')
      return {};

    if (method === 'GET' && path === '/auth/keys')
      return { keys: [] };

    throw new AeorDBError(`FakeAeorDBClient has no route for ${method} ${path}`, { status: 404 });
  }

  listOwnAPIKeys(options = {}) {
    return this.request('GET', '/auth/keys', options);
  }

  getSystemUser(userID, options = {}) {
    return this.request('GET', `/system/users/${encodeURIComponent(userID)}`, options);
  }

  updateSystemUser(userID, body, options = {}) {
    return this.request('PATCH', `/system/users/${encodeURIComponent(userID)}`, {
      ...options,
      body,
    });
  }

  requestMagicLink(email, options = {}) {
    return { message: 'sent', email };
  }

  verifyMagicLink(code, options = {}) {
    return { token: `token-${code}`, expires_in: 3600 };
  }

  exchangeAPIKey(apiKey, options = {}) {
    return { token: `token-${apiKey}`, refresh_token: `refresh-${apiKey}`, expires_in: 3600 };
  }

  refreshToken(refreshToken, options = {}) {
    return { token: `token-${refreshToken}`, refresh_token: refreshToken, expires_in: 3600 };
  }
}

function keyFor(path) {
  if (!path || typeof path !== 'string')
    throw new TypeError('FakeAeorDBClient path must be a non-empty string');

  return path.replace(/^\/+/g, '').replace(/\/+$/g, '');
}

function notFound(path) {
  return new AeorDBError(`AeorDB document not found: ${path}`, { status: 404 });
}
