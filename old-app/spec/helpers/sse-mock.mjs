'use strict';

/**
 * SSE Response Mock
 *
 * Mock Express response object for testing Server-Sent Events (SSE)
 * endpoints without real HTTP connections.
 *
 * Usage:
 *   import { createSSEResponse } from './sse-mock.mjs';
 *
 *   const res = createSSEResponse();
 *   await handler(req, res);
 *
 *   assert.deepEqual(res.getHeaders(), {
 *     'Content-Type': 'text/event-stream',
 *   });
 *   assert.ok(res.getEvents().length > 0);
 */

/**
 * Parse raw SSE text into structured event objects.
 * Each SSE block is separated by `\n\n`. Lines starting with
 * `event:` set the event name; `data:` lines carry the payload.
 * Comment lines (`:`) are collected separately.
 *
 * @param {string} raw - Raw SSE text written via res.write()
 * @returns {{ events: Array<{ event: string|null, data: string }>, comments: string[] }}
 */
export function parseSSE(raw) {
  let events = [];
  let comments = [];
  let blocks = raw.split('\n\n').filter(Boolean);

  for (let block of blocks) {
    let lines = block.split('\n');
    let event = null;
    let dataLines = [];
    let isComment = false;

    for (let line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line.startsWith(':')) {
        comments.push(line.slice(1).trim());
        isComment = true;
      }
    }

    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') });
    }
  }

  return { events, comments };
}

/**
 * Create a mock Express response object for SSE testing.
 *
 * Captures all setHeader, writeHead, write, end, and flush calls
 * for later inspection. Provides helper methods to extract
 * parsed SSE events and headers.
 *
 * @returns {object} Mock response with inspection methods
 */
export function createSSEResponse() {
  let headers = {};
  let writtenChunks = [];
  let statusCode = 200;
  let ended = false;
  let flushed = 0;
  let headersFlushed = false;

  let response = {
    // --- Express response interface ---

    statusCode,

    setHeader(name, value) {
      headers[name] = value;
      return response;
    },

    writeHead(code, responseHeaders = {}) {
      statusCode = code;
      response.statusCode = code;
      for (let [key, value] of Object.entries(responseHeaders)) {
        headers[key] = value;
      }
      return response;
    },

    write(chunk) {
      if (ended) return false;
      writtenChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    },

    end(...args) {
      if (args.length > 0 && args[0]) {
        writtenChunks.push(typeof args[0] === 'string' ? args[0] : String(args[0]));
      }
      ended = true;
      return response;
    },

    flush() {
      flushed++;
    },

    flushHeaders() {
      headersFlushed = true;
    },

    // Mock socket for code that checks res.socket
    socket: {
      destroyed: false,
      uncork() {},
    },

    // --- Inspection methods ---

    /**
     * Get all headers that were set.
     * @returns {object}
     */
    getHeaders() {
      return { ...headers };
    },

    /**
     * Get a specific header value.
     * @param {string} name - Header name
     * @returns {string|undefined}
     */
    getHeader(name) {
      return headers[name];
    },

    /**
     * Get all raw chunks written via write() and end().
     * @returns {string[]}
     */
    getWrittenChunks() {
      return [...writtenChunks];
    },

    /**
     * Get all written data concatenated as a single string.
     * @returns {string}
     */
    getRawOutput() {
      return writtenChunks.join('');
    },

    /**
     * Get parsed SSE events from all written data.
     * @returns {Array<{ event: string|null, data: string }>}
     */
    getEvents() {
      let raw = writtenChunks.join('');
      return parseSSE(raw).events;
    },

    /**
     * Get SSE comment lines (lines starting with `:`) from written data.
     * @returns {string[]}
     */
    getComments() {
      let raw = writtenChunks.join('');
      return parseSSE(raw).comments;
    },

    /**
     * Check whether end() has been called.
     * @returns {boolean}
     */
    isEnded() {
      return ended;
    },

    /**
     * Get the number of times flush() was called.
     * @returns {number}
     */
    getFlushCount() {
      return flushed;
    },

    /**
     * Check whether flushHeaders() was called.
     * @returns {boolean}
     */
    headersWereFlushed() {
      return headersFlushed;
    },

    /**
     * Get the status code.
     * @returns {number}
     */
    getStatusCode() {
      return response.statusCode;
    },

    /**
     * Reset all captured state for reuse.
     */
    reset() {
      headers = {};
      writtenChunks = [];
      statusCode = 200;
      response.statusCode = 200;
      ended = false;
      flushed = 0;
      headersFlushed = false;
    },
  };

  // Support event listener registration (for 'close' event used by SSE cleanup)
  let listeners = {};

  response.on = (event, callback) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
    return response;
  };

  response.removeListener = (event, callback) => {
    if (listeners[event]) {
      listeners[event] = listeners[event].filter((cb) => cb !== callback);
    }
    return response;
  };

  /**
   * Emit an event (e.g., 'close') to trigger registered handlers.
   * @param {string} event - Event name
   * @param {...*} args - Arguments to pass to handlers
   */
  response.emit = (event, ...args) => {
    if (listeners[event]) {
      for (let callback of listeners[event]) {
        callback(...args);
      }
    }
  };

  return response;
}

export default {
  createSSEResponse,
  parseSSE,
};
