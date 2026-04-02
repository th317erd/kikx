'use strict';

// =============================================================================
// SolrService — Thin HTTP wrapper around Solr REST API
// =============================================================================

const DEFAULT_HOST    = 'http://localhost:8983';
const DEFAULT_CORE    = 'kikx';
const DEFAULT_TIMEOUT = 15000;

/** @type {Set<number>} Status codes worth retrying */
export const RETRYABLE_STATUS_CODES = new Set([ 408, 429, 503, 504 ]);

export class SolrError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {any} body
   */
  constructor(message, status, body) {
    super(message);

    /** @type {string} */
    this.name   = 'SolrError';
    /** @type {number} */
    this.status = status;
    /** @type {any} */
    this.body   = body;
  }

  /**
   * @returns {boolean}
   */
  isRetryable() {
    return RETRYABLE_STATUS_CODES.has(this.status);
  }
}

export class SolrService {
  /**
   * @param {object} [options]
   * @param {import('../types').CascadingContext} [options.context]
   * @param {string} [options.host]
   * @param {string} [options.core]
   * @param {number} [options.timeout]
   */
  constructor({ context, host, core, timeout } = {}) {
    /** @type {import('../types').CascadingContext|null} */
    this._context = context || null;
    /** @type {string} */
    this._host    = host || DEFAULT_HOST;
    /** @type {string} */
    this._core    = core || DEFAULT_CORE;
    /** @type {number} */
    this._timeout = timeout || DEFAULT_TIMEOUT;
  }

  /** @returns {string} */
  getHost() { return this._host; }

  /** @returns {string} */
  getCore() { return this._core; }

  /** @returns {number} */
  getTimeout() { return this._timeout; }

  /**
   * @param {string} endpoint
   * @param {Record<string, any>} [params]
   * @returns {string}
   */
  _buildURL(endpoint, params) {
    let url = new URL(`${this._host}/solr/${this._core}${endpoint}`);

    if (params) {
      let keys = Object.keys(params);

      for (let i = 0; i < keys.length; i++) {
        let key   = keys[i];
        let value = params[key];

        if (value == null)
          continue;

        if (Array.isArray(value)) {
          for (let j = 0; j < value.length; j++)
            url.searchParams.append(key, String(value[j]));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    url.searchParams.set('wt', 'json');

    return url.toString();
  }

  /**
   * @param {string} endpoint
   * @param {Record<string, any>} [params]
   * @returns {string}
   */
  _buildAdminURL(endpoint, params) {
    let url = new URL(`${this._host}/solr${endpoint}`);

    if (params) {
      let keys = Object.keys(params);

      for (let i = 0; i < keys.length; i++) {
        let key   = keys[i];
        let value = params[key];

        if (value != null)
          url.searchParams.set(key, String(value));
      }
    }

    url.searchParams.set('wt', 'json');

    return url.toString();
  }

  /**
   * @param {string} method
   * @param {string} endpoint
   * @param {object} [options]
   * @param {any} [options.body]
   * @param {Record<string, any>} [options.params]
   * @param {number} [options.timeout]
   * @param {boolean} [options.admin]
   * @returns {Promise<any>}
   */
  async _request(method, endpoint, { body, params, timeout, admin } = {}) {
    let url = (admin)
      ? this._buildAdminURL(endpoint, params)
      : this._buildURL(endpoint, params);

    let requestTimeout = timeout || this._timeout;

    let fetchOptions = {
      method,
      signal: AbortSignal.timeout(requestTimeout),
    };

    if (body !== undefined) {
      fetchOptions.headers = { 'Content-Type': 'application/json' };
      fetchOptions.body    = JSON.stringify(body);
    }

    let response;

    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new SolrError(`Solr request timed out after ${requestTimeout}ms`, 408, null);

      throw new SolrError(`Solr connection failed: ${error.message}`, 0, null);
    }

    let responseText;

    try {
      responseText = await response.text();
    } catch (error) {
      throw new SolrError(`Failed to read Solr response body: ${error.message}`, response.status, null);
    }

    let responseBody;

    try {
      responseBody = JSON.parse(responseText);
    } catch (_error) {
      throw new SolrError(
        `Solr returned non-JSON response: ${responseText.slice(0, 200)}`,
        response.status,
        null,
      );
    }

    if (!response.ok) {
      throw new SolrError(
        responseBody?.error?.msg || `Solr HTTP ${response.status}`,
        response.status,
        responseBody,
      );
    }

    if (responseBody.responseHeader && responseBody.responseHeader.status !== 0) {
      throw new SolrError(
        responseBody?.error?.msg || 'Solr returned non-zero status',
        responseBody.responseHeader.status,
        responseBody,
      );
    }

    return responseBody;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async ping() {
    try {
      await this._request('GET', '/admin/ping');
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * @returns {Promise<any>}
   */
  async getCoreStatus() {
    return this._request('GET', '/admin/cores', {
      params: { action: 'STATUS', core: this._core },
      admin:  true,
    });
  }

  /**
   * @param {string} query
   * @param {object} [options]
   * @param {string|string[]} [options.filterQueries]
   * @param {string|string[]} [options.fields]
   * @param {string} [options.sort]
   * @param {number} [options.rows]
   * @param {number} [options.start]
   * @param {string} [options.defType]
   * @param {string} [options.queryFields]
   * @param {object} [options.highlight]
   * @param {string} [options.cursorMark]
   * @returns {Promise<any>}
   */
  async search(query, options = {}) {
    let {
      filterQueries,
      fields,
      sort,
      rows         = 10,
      start        = 0,
      defType      = 'edismax',
      queryFields,
      highlight,
      cursorMark,
    } = options;

    let params = {
      q:       query,
      defType,
      rows,
    };

    if (cursorMark) {
      params.cursorMark = cursorMark;

      if (!sort)
        params.sort = 'id asc';
    } else {
      params.start = start;
    }

    if (filterQueries)
      params.fq = filterQueries;

    if (fields)
      params.fl = (Array.isArray(fields)) ? fields.join(',') : fields;

    if (sort)
      params.sort = sort;

    if (queryFields)
      params.qf = queryFields;

    if (highlight) {
      params.hl                = 'on';
      params['hl.fl']          = highlight.fields || '_text_';
      params['hl.simple.pre']  = highlight.pre || '<em>';
      params['hl.simple.post'] = highlight.post || '</em>';
    }

    return this._request('GET', '/select', { params });
  }

  /**
   * @param {any|any[]} documents
   * @param {object} [options]
   * @param {number} [options.commitWithin]
   * @returns {Promise<any|null>}
   */
  async indexDocuments(documents, options = {}) {
    if (!Array.isArray(documents))
      documents = [ documents ];

    if (documents.length === 0)
      return null;

    let { commitWithin = 1000 } = options;

    return this._request('POST', '/update/json/docs', {
      body:   documents,
      params: { commitWithin },
    });
  }

  /**
   * @param {string|string[]} identifiers
   * @param {object} [options]
   * @param {boolean} [options.commit]
   * @returns {Promise<any|null>}
   */
  async deleteDocuments(identifiers, options = {}) {
    if (!Array.isArray(identifiers))
      identifiers = [ identifiers ];

    if (identifiers.length === 0)
      return null;

    let { commit = false } = options;
    let body = { 'delete': identifiers };

    if (commit)
      body.commit = {};

    return this._request('POST', '/update', { body });
  }

  /**
   * @param {string} query
   * @param {object} [options]
   * @param {boolean} [options.commit]
   * @returns {Promise<any>}
   */
  async deleteByQuery(query, options = {}) {
    let { commit = false } = options;
    let body = { 'delete': { query } };

    if (commit)
      body.commit = {};

    return this._request('POST', '/update', { body });
  }

  /**
   * @returns {Promise<any>}
   */
  async commit() {
    return this._request('POST', '/update', {
      body: { commit: {} },
    });
  }

  /**
   * Cursor-based streaming async generator.
   * Yields individual documents, transparently paginating via cursorMark.
   * @param {string} query
   * @param {object} [options]
   * @param {string} [options.sort]
   * @param {number} [options.rows]
   * @returns {AsyncGenerator<any, void, undefined>}
   */
  async *stream(query, options = {}) {
    let { sort = 'id asc', rows = 500, ...rest } = options;
    let cursorMark = '*';

    while (true) {
      let result = await this.search(query, {
        ...rest,
        sort,
        rows,
        cursorMark,
      });

      let docs       = result.response.docs;
      let nextCursor = result.nextCursorMark;

      if (docs.length === 0)
        break;

      for (let i = 0; i < docs.length; i++)
        yield docs[i];

      if (nextCursor === cursorMark)
        break;

      cursorMark = nextCursor;
    }
  }
}
