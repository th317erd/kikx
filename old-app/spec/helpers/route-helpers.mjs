'use strict';

/**
 * Express Route Test Harness
 *
 * Provides mock request/response objects and a helper to call Express
 * route handlers in isolation, without spinning up an HTTP server.
 *
 * Usage:
 *   import { createMockRequest, createMockResponse, callRoute } from './route-helpers.mjs';
 *
 *   const req = createMockRequest({
 *     params: { sessionId: '1' },
 *     body: { content: 'Hello' },
 *     user: { id: 1, username: 'testuser' },
 *   });
 *   const res = createMockResponse();
 *
 *   await callRoute(handler, req, res);
 *
 *   assert.equal(res.getStatus(), 200);
 *   assert.deepEqual(res.getBody(), { ok: true });
 */

/**
 * Create a mock Express request object.
 *
 * @param {object} overrides - Properties to set/override on the request
 * @param {object} [overrides.params] - Route params (e.g., { id: '1' })
 * @param {object} [overrides.query] - Query string params
 * @param {object} [overrides.body] - Request body
 * @param {object} [overrides.headers] - Request headers (lowercased keys)
 * @param {object} [overrides.user] - Authenticated user (set by auth middleware)
 * @returns {object} Mock request object
 */
export function createMockRequest(overrides = {}) {
  let headers = overrides.headers || {};

  let request = {
    params: overrides.params || {},
    query: overrides.query || {},
    body: overrides.body || {},
    headers: headers,
    user: overrides.user || null,
    method: overrides.method || 'GET',
    url: overrides.url || '/',
    path: overrides.path || '/',
    ip: overrides.ip || '127.0.0.1',

    /**
     * Get a header value (case-insensitive, like Express).
     * @param {string} name - Header name
     * @returns {string|undefined}
     */
    get(name) {
      return headers[name.toLowerCase()];
    },

    /**
     * Alias for get() — Express uses both.
     * @param {string} name - Header name
     * @returns {string|undefined}
     */
    header(name) {
      return request.get(name);
    },
  };

  // Merge any additional properties (cookies, session, etc.)
  for (let [key, value] of Object.entries(overrides)) {
    if (!(key in request)) {
      request[key] = value;
    }
  }

  return request;
}

/**
 * Create a mock Express response object.
 *
 * Captures all status, json, send, write, setHeader, and end calls
 * for later assertions.
 *
 * @returns {object} Mock response with inspection methods
 */
export function createMockResponse() {
  let statusCode = 200;
  let body = undefined;
  let headers = {};
  let writtenChunks = [];
  let ended = false;
  let jsonCalled = false;
  let sendCalled = false;
  let redirectUrl = null;
  let redirectStatus = null;

  let response = {
    // --- Express response interface ---

    /**
     * Set the HTTP status code. Chainable.
     * @param {number} code
     * @returns {object} this
     */
    status(code) {
      statusCode = code;
      return response;
    },

    /**
     * Send a JSON response.
     * @param {*} data - Data to serialize
     * @returns {object} this
     */
    json(data) {
      jsonCalled = true;
      body = data;
      ended = true;
      return response;
    },

    /**
     * Send a response body.
     * @param {*} data - Response body
     * @returns {object} this
     */
    send(data) {
      sendCalled = true;
      body = data;
      ended = true;
      return response;
    },

    /**
     * Write a chunk to the response.
     * @param {string|Buffer} chunk
     * @returns {boolean}
     */
    write(chunk) {
      writtenChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    },

    /**
     * End the response.
     * @param {string|Buffer} [data]
     * @returns {object} this
     */
    end(data) {
      if (data) {
        writtenChunks.push(typeof data === 'string' ? data : String(data));
      }
      ended = true;
      return response;
    },

    /**
     * Set a header.
     * @param {string} name
     * @param {string} value
     * @returns {object} this
     */
    setHeader(name, value) {
      headers[name] = value;
      return response;
    },

    /**
     * Set a header (alias).
     * @param {string} name
     * @param {string} value
     * @returns {object} this
     */
    set(name, value) {
      headers[name] = value;
      return response;
    },

    /**
     * Redirect to a URL.
     * @param {number|string} statusOrUrl
     * @param {string} [url]
     * @returns {object} this
     */
    redirect(statusOrUrl, url) {
      if (typeof statusOrUrl === 'number') {
        redirectStatus = statusOrUrl;
        redirectUrl = url;
      } else {
        redirectStatus = 302;
        redirectUrl = statusOrUrl;
      }
      ended = true;
      return response;
    },

    // --- Inspection methods ---

    /**
     * Get the status code that was set.
     * @returns {number}
     */
    getStatus() {
      return statusCode;
    },

    /**
     * Get the response body (from json() or send()).
     * @returns {*}
     */
    getBody() {
      return body;
    },

    /**
     * Get all response headers.
     * @returns {object}
     */
    getHeaders() {
      return { ...headers };
    },

    /**
     * Get a specific header value.
     * @param {string} name
     * @returns {string|undefined}
     */
    getHeader(name) {
      return headers[name];
    },

    /**
     * Get chunks written via write().
     * @returns {string[]}
     */
    getWrittenChunks() {
      return [...writtenChunks];
    },

    /**
     * Check whether the response has ended.
     * @returns {boolean}
     */
    isEnded() {
      return ended;
    },

    /**
     * Check whether json() was called.
     * @returns {boolean}
     */
    wasJsonCalled() {
      return jsonCalled;
    },

    /**
     * Check whether send() was called.
     * @returns {boolean}
     */
    wasSendCalled() {
      return sendCalled;
    },

    /**
     * Get redirect info, or null if no redirect was issued.
     * @returns {{ status: number, url: string }|null}
     */
    getRedirect() {
      if (!redirectUrl) return null;
      return { status: redirectStatus, url: redirectUrl };
    },

    /**
     * Reset all captured state.
     */
    reset() {
      statusCode = 200;
      body = undefined;
      headers = {};
      writtenChunks = [];
      ended = false;
      jsonCalled = false;
      sendCalled = false;
      redirectUrl = null;
      redirectStatus = null;
    },
  };

  return response;
}

/**
 * Call an Express route handler with mock req/res and return the result.
 *
 * Handles both synchronous and async handlers. If the handler calls
 * next(error), the error is thrown so tests can catch it.
 *
 * @param {Function} handler - Express route handler (req, res, next)
 * @param {object} request - Mock request object
 * @param {object} response - Mock response object
 * @returns {Promise<object>} The mock response, after the handler completes
 */
export async function callRoute(handler, request, response) {
  let nextError = null;

  let next = (error) => {
    if (error) nextError = error;
  };

  await handler(request, response, next);

  if (nextError) throw nextError;

  return response;
}

export default {
  createMockRequest,
  createMockResponse,
  callRoute,
};
