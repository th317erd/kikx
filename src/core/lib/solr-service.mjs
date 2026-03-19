'use strict';

// =============================================================================
// SolrService — Thin HTTP wrapper around Solr REST API
// =============================================================================
// Uses Node 24 built-in fetch(). No external dependencies.
// Accessed via context.getProperty('solrService').
//
// Core methods:
//   ping()              — health check, returns true/false
//   getCoreStatus()     — admin core status info
//   search()            — full-text search with eDisMax, filtering, pagination
//   indexDocuments()     — batch index (single doc or array)
//   deleteDocuments()    — delete by ID (single or array)
//   deleteByQuery()     — delete by Solr query
//   commit()            — force hard commit
//   stream()            — async generator for cursor-based pagination
// =============================================================================

const DEFAULT_HOST    = 'http://localhost:8983';
const DEFAULT_CORE    = 'kikx';
const DEFAULT_TIMEOUT = 15000;

// Status codes worth retrying (used by callers, not internally)
export const RETRYABLE_STATUS_CODES = new Set([ 408, 429, 503, 504 ]);

export class SolrError extends Error {
  constructor(message, status, body) {
    super(message);

    this.name   = 'SolrError';
    this.status = status;
    this.body   = body;
  }

  isRetryable() {
    return RETRYABLE_STATUS_CODES.has(this.status);
  }
}

export class SolrService {
  constructor({ context, host, core, timeout } = {}) {
    this._context = context || null;
    this._host    = host || DEFAULT_HOST;
    this._core    = core || DEFAULT_CORE;
    this._timeout = timeout || DEFAULT_TIMEOUT;
  }

  // ---------------------------------------------------------------------------
  // Configuration accessors
  // ---------------------------------------------------------------------------

  getHost() {
    return this._host;
  }

  getCore() {
    return this._core;
  }

  getTimeout() {
    return this._timeout;
  }

  // ---------------------------------------------------------------------------
  // URL construction
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Low-level request
  // ---------------------------------------------------------------------------

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

    // Read body as text first so we can parse or report raw content
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

    // HTTP-level error
    if (!response.ok) {
      throw new SolrError(
        responseBody?.error?.msg || `Solr HTTP ${response.status}`,
        response.status,
        responseBody,
      );
    }

    // Solr-level error (HTTP 200 but status != 0)
    if (responseBody.responseHeader && responseBody.responseHeader.status !== 0) {
      throw new SolrError(
        responseBody?.error?.msg || 'Solr returned non-zero status',
        responseBody.responseHeader.status,
        responseBody,
      );
    }

    return responseBody;
  }

  // ---------------------------------------------------------------------------
  // Health & Admin
  // ---------------------------------------------------------------------------

  async ping() {
    try {
      await this._request('GET', '/admin/ping');
      return true;
    } catch (_error) {
      return false;
    }
  }

  async getCoreStatus() {
    return this._request('GET', '/admin/cores', {
      params: { action: 'STATUS', core: this._core },
      admin:  true,
    });
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

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

    // Cursor pagination is mutually exclusive with start offset
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

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------

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

  async deleteByQuery(query, options = {}) {
    let { commit = false } = options;
    let body = { 'delete': { query } };

    if (commit)
      body.commit = {};

    return this._request('POST', '/update', { body });
  }

  // ---------------------------------------------------------------------------
  // Commit
  // ---------------------------------------------------------------------------

  async commit() {
    return this._request('POST', '/update', {
      body: { commit: {} },
    });
  }

  // ---------------------------------------------------------------------------
  // Cursor-based streaming (async generator)
  // ---------------------------------------------------------------------------
  // Yields individual documents, transparently paginating via cursorMark.
  // Use for large exports or full-index scans without OOM risk.
  //
  // Usage:
  //   for await (let doc of solrService.stream('*:*', { rows: 500 })) {
  //     console.log(doc.id);
  //   }
  // ---------------------------------------------------------------------------

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

      // When nextCursorMark equals the current one, we've exhausted results
      if (nextCursor === cursorMark)
        break;

      cursorMark = nextCursor;
    }
  }
}
