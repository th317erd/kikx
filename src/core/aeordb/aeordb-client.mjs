'use strict';

const DEFAULT_TIMEOUT_MS = 15000;

export class AeorDBError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AeorDBError';
    this.status = options.status ?? 0;
    this.body = options.body ?? null;
    this.url = options.url ?? null;
    this.cause = options.cause;
  }
}

export class AeorDBClient {
  constructor(options = {}) {
    let {
      baseURL = process.env.AEORDB_URL,
      token = process.env.AEORDB_TOKEN,
      timeoutMS = DEFAULT_TIMEOUT_MS,
      fetchImpl = globalThis.fetch,
    } = options;

    if (!baseURL || typeof baseURL !== 'string')
      throw new TypeError('AeorDBClient requires baseURL');

    if (typeof fetchImpl !== 'function')
      throw new TypeError('AeorDBClient requires a fetch implementation');

    this.baseURL = baseURL.replace(/\/+$/g, '');
    this.token = token || '';
    this.timeoutMS = timeoutMS;
    this.fetch = fetchImpl;
  }

  async getFile(path, options = {}) {
    return this.request('GET', this.filePath(path), options);
  }

  async putFile(path, body, options = {}) {
    return this.request('PUT', this.filePath(path), {
      ...options,
      body,
    });
  }

  async patchFile(path, patch, options = {}) {
    return this.request('PATCH', this.filePath(path), {
      ...options,
      body: patch,
      contentType: 'application/merge-patch+json',
    });
  }

  async deleteFile(path, options = {}) {
    return this.request('DELETE', this.filePath(path), options);
  }

  async queryFiles(query, options = {}) {
    return this.request('POST', '/files/query', {
      ...options,
      body: query,
    });
  }

  async searchFiles(search, options = {}) {
    return this.request('POST', '/files/search', {
      ...options,
      body: search,
    });
  }

  eventsURL(params = {}) {
    let url = this.url('/system/events');

    for (let [key, value] of Object.entries(params)) {
      if (value == null)
        continue;

      if (Array.isArray(value))
        value = value.join(',');

      url.searchParams.set(key, String(value));
    }

    if (this.token)
      url.searchParams.set('token', this.token);

    return url.toString();
  }

  filePath(path) {
    if (!path || typeof path !== 'string')
      throw new TypeError('AeorDB file path must be a non-empty string');

    let cleanPath = path.replace(/^\/+/g, '');
    return `/files/${cleanPath}`;
  }

  url(path) {
    let normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return new URL(`${this.baseURL}${normalizedPath}`);
  }

  async request(method, path, options = {}) {
    let {
      body,
      headers = {},
      timeoutMS = this.timeoutMS,
      contentType = 'application/json',
      expectJSON = true,
    } = options;

    let url = this.url(path);
    let requestHeaders = { ...headers };
    let requestBody;

    if (this.token)
      requestHeaders.Authorization = `Bearer ${this.token}`;

    if (body !== undefined) {
      requestHeaders['Content-Type'] = contentType;
      requestBody = (contentType === 'application/json' || contentType === 'application/merge-patch+json')
        ? JSON.stringify(body)
        : body;
    }

    let response;

    try {
      response = await this.fetch(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMS),
      });
    } catch (error) {
      let message = (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? `AeorDB request timed out after ${timeoutMS}ms`
        : `AeorDB request failed: ${error.message}`;

      throw new AeorDBError(message, { url: url.toString(), cause: error });
    }

    let text = await response.text();
    let parsed = null;

    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        if (expectJSON) {
          throw new AeorDBError('AeorDB returned a non-JSON response', {
            status: response.status,
            body: text.slice(0, 500),
            url: url.toString(),
            cause: error,
          });
        }

        parsed = text;
      }
    }

    if (!response.ok) {
      let message = parsed?.error?.message || parsed?.message || `AeorDB HTTP ${response.status}`;
      throw new AeorDBError(message, {
        status: response.status,
        body: parsed,
        url: url.toString(),
      });
    }

    return parsed;
  }
}

