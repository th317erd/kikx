'use strict';

import XID from 'xid-js';

// =============================================================================
// Shared Utilities
// =============================================================================

/**
 * Safely parse a JSON string, returning a fallback on failure.
 * Handles string, object, null, and undefined inputs.
 *
 * @param {string | object | null | undefined} value
 * @param {any} [fallback={}]
 * @returns {any}
 */
export function safeParseJSON(value, fallback = {}) {
  if (value == null)
    return fallback;

  if (typeof value !== 'string')
    return value;

  try {
    return JSON.parse(value);
  } catch (_e) {
    return fallback;
  }
}

/**
 * Generate an XID with a prefix.
 *
 * @param {string} prefix - e.g. 'frm_', 'int_', 'tl_'
 * @returns {string}
 */
export function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

/**
 * Build a frame data object with sensible defaults.
 * Eliminates the 12-field boilerplate repeated 30+ times across the codebase.
 *
 * @param {string} type - Frame type (e.g. 'Message', 'ToolCall', 'ToolResult')
 * @param {Record<string, any>} content - Frame content payload
 * @param {Partial<import('../types').FrameData>} [overrides={}]
 * @returns {import('../types').FrameData}
 */
export function buildFrameData(type, content, overrides = {}) {
  return {
    id:                    generateID('frm_'),
    type,
    content,
    timestamp:             Date.now(),
    interactionID:         '',
    authorType:            'system',
    authorID:              null,
    parentID:              null,
    hidden:                false,
    deleted:               false,
    processed:             false,
    ...overrides,
  };
}
