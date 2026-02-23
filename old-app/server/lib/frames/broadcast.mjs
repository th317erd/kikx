'use strict';

// ============================================================================
// Frame Creation with WebSocket Broadcasting
// ============================================================================
// Helper functions for creating frames and broadcasting them to connected clients.

import { randomUUID } from 'node:crypto';

import { createFrame, FrameType, AuthorType } from './index.mjs';
import { sanitizeHtml } from '../html-sanitizer.mjs';
import { broadcastToSession } from '../websocket.mjs';

// Debug logging
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

function debug(sessionId, ...args) {
  if (DEBUG) {
    const prefix = (sessionId) ? `[session_${sessionId}]` : '[FrameBroadcast]';
    console.log(prefix, ...args);
  }
}

/**
 * Create a frame and broadcast it to the user's connected clients.
 *
 * @param {Object} options - Frame creation options
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID for broadcasting
 * @param {string} options.type - Frame type (message, request, result, update, compact)
 * @param {string} options.authorType - Author type (user, agent, system)
 * @param {number} [options.authorId] - Author ID (user or agent ID)
 * @param {Object} options.payload - Frame payload content
 * @param {string} [options.parentId] - Parent frame ID
 * @param {string[]} [options.targetIds] - Target IDs
 * @param {string} [options.id] - Custom frame ID
 * @param {boolean} [options.skipBroadcast] - Skip WebSocket broadcast
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object} The created frame
 */
export function createAndBroadcastFrame(options, db = null) {
  const {
    sessionId,
    userId,
    type,
    authorType,
    authorId,
    payload,
    parentId,
    targetIds,
    id,
    skipBroadcast = false,
  } = options;

  // Create the frame
  const frame = createFrame({
    id,
    sessionId,
    parentId,
    targetIds,
    type,
    authorType,
    authorId,
    payload,
  }, db);

  debug(sessionId, 'Frame created', {
    id: frame.id,
    type,
    authorType,
    skipBroadcast,
  });

  // Broadcast to ALL session participants via WebSocket
  if (!skipBroadcast && sessionId) {
    broadcastToSession(sessionId, {
      type: 'new_frame',
      sessionId,
      frame: {
        id: frame.id,
        sessionId: frame.sessionId,
        parentId: frame.parentId,
        targetIds: frame.targetIds,
        timestamp: frame.timestamp,
        type: frame.type,
        authorType: frame.authorType,
        authorId: frame.authorId,
        payload: frame.payload,
      },
    });
  }

  return frame;
}

/**
 * Create a user message frame.
 *
 * @param {Object} options - Options
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID
 * @param {string} options.content - Message content
 * @param {boolean} [options.hidden] - Whether message is hidden from UI
 * @param {boolean} [options.skipBroadcast] - Skip broadcast
 * @param {Database} [db] - Optional database for testing
 * @returns {Object} The created frame
 */
export function createUserMessageFrame(options, db = null) {
  const { sessionId, userId, content, hidden = false, targetIds, skipBroadcast = false } = options;

  return createAndBroadcastFrame({
    sessionId,
    userId,
    type: FrameType.MESSAGE,
    authorType: AuthorType.USER,
    authorId: userId,
    payload: {
      role: 'user',
      content,
      hidden,
    },
    targetIds,
    skipBroadcast,
  }, db);
}

/**
 * Create an agent message frame.
 * Content is automatically sanitized to remove dangerous HTML.
 *
 * @param {Object} options - Options
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID (for broadcasting)
 * @param {number} options.agentId - Agent ID
 * @param {string} options.content - Message content (will be sanitized)
 * @param {boolean} [options.hidden] - Whether message is hidden from UI
 * @param {boolean} [options.skipBroadcast] - Skip broadcast
 * @param {boolean} [options.skipSanitize] - Skip HTML sanitization (use with caution)
 * @param {Database} [db] - Optional database for testing
 * @returns {Object} The created frame
 */
export function createAgentMessageFrame(options, db = null) {
  const { sessionId, userId, agentId, content, hidden = false, skipBroadcast = false, skipSanitize = false } = options;

  // Ensure all hml-prompt tags have stable IDs before storage
  let processedContent = content.replace(
    /<hml-prompt(?![^>]*\bid\s*=)/gi,
    () => `<hml-prompt id="prompt-${randomUUID().slice(0, 8)}"`,
  );

  // Sanitize agent content to remove dangerous HTML
  const sanitizedContent = skipSanitize ? processedContent : sanitizeHtml(processedContent);

  return createAndBroadcastFrame({
    sessionId,
    userId,
    type: FrameType.MESSAGE,
    authorType: AuthorType.AGENT,
    authorId: agentId,
    payload: {
      role: 'assistant',
      content: sanitizedContent,
      hidden,
    },
    skipBroadcast,
  }, db);
}

/**
 * Create a system message frame.
 *
 * @param {Object} options - Options
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID (for broadcasting)
 * @param {string} options.content - Message content
 * @param {boolean} [options.hidden] - Whether message is hidden from UI
 * @param {boolean} [options.skipBroadcast] - Skip broadcast
 * @param {Database} [db] - Optional database for testing
 * @returns {Object} The created frame
 */
export function createSystemMessageFrame(options, db = null) {
  const { sessionId, userId, content, hidden = true, skipBroadcast = false } = options;

  return createAndBroadcastFrame({
    sessionId,
    userId,
    type: FrameType.MESSAGE,
    authorType: AuthorType.SYSTEM,
    payload: {
      role: 'system',
      content,
      hidden,
    },
    skipBroadcast,
  }, db);
}

/**
 * Create an interaction request frame.
 *
 * @param {Object} options - Options
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID (for broadcasting)
 * @param {number} options.agentId - Agent ID
 * @param {string} options.parentId - Parent message frame ID
 * @param {string} options.action - Interaction action (websearch, prompt, etc.)
 * @param {Object} options.data - Interaction data
 * @param {string[]} [options.targetIds] - Target IDs
 * @param {boolean} [options.skipBroadcast] - Skip broadcast
 * @param {Database} [db] - Optional database for testing
 * @returns {Object} The created frame
 */
export function createRequestFrame(options, db = null) {
  const {
    sessionId,
    userId,
    agentId,
    parentId,
    action,
    data,
    targetIds = ['system:' + action],
    skipBroadcast = false,
  } = options;

  return createAndBroadcastFrame({
    sessionId,
    userId,
    type: FrameType.REQUEST,
    authorType: AuthorType.AGENT,
    authorId: agentId,
    parentId,
    targetIds,
    payload: {
      action,
      ...data,
    },
    skipBroadcast,
  }, db);
}

/**
 * Create an interaction result frame.
 *
 * @param {Object} options - Options
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID (for broadcasting)
 * @param {string} options.parentId - Parent request frame ID
 * @param {number} options.agentId - Agent ID (target for result)
 * @param {Object} options.result - Result data
 * @param {boolean} [options.skipBroadcast] - Skip broadcast
 * @param {Database} [db] - Optional database for testing
 * @returns {Object} The created frame
 */
export function createResultFrame(options, db = null) {
  const { sessionId, userId, parentId, agentId, result, skipBroadcast = false } = options;

  return createAndBroadcastFrame({
    sessionId,
    userId,
    type: FrameType.RESULT,
    authorType: AuthorType.SYSTEM,
    parentId,
    targetIds: ['agent:' + agentId],
    payload: result,
    skipBroadcast,
  }, db);
}

/**
 * Create a compact frame (checkpoint).
 *
 * @param {Object} options - Options
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID (for broadcasting)
 * @param {string} options.context - Summarized context
 * @param {Object} [options.snapshot] - Snapshot of compiled state
 * @param {boolean} [options.skipBroadcast] - Skip broadcast
 * @param {Database} [db] - Optional database for testing
 * @returns {Object} The created frame
 */
export function createCompactFrame(options, db = null) {
  const { sessionId, userId, context, snapshot = {}, skipBroadcast = false } = options;

  return createAndBroadcastFrame({
    sessionId,
    userId,
    type: FrameType.COMPACT,
    authorType: AuthorType.SYSTEM,
    payload: {
      context,
      snapshot,
    },
    skipBroadcast,
  }, db);
}

/**
 * Create an update frame to modify existing frame content.
 *
 * @param {Object} options - Options
 * @param {number} options.sessionId - Session ID
 * @param {number} options.userId - User ID (for broadcasting)
 * @param {string} options.targetFrameId - ID of frame to update
 * @param {Object} options.payload - New payload content
 * @param {boolean} [options.skipBroadcast] - Skip broadcast
 * @param {Database} [db] - Optional database for testing
 * @returns {Object} The created frame
 */
export function createUpdateFrame(options, db = null) {
  const { sessionId, userId, targetFrameId, payload, skipBroadcast = false } = options;

  return createAndBroadcastFrame({
    sessionId,
    userId,
    type: FrameType.UPDATE,
    authorType: AuthorType.SYSTEM,
    targetIds: ['frame:' + targetFrameId],
    payload,
    skipBroadcast,
  }, db);
}

export default {
  createAndBroadcastFrame,
  createUserMessageFrame,
  createAgentMessageFrame,
  createSystemMessageFrame,
  createRequestFrame,
  createResultFrame,
  createCompactFrame,
  createUpdateFrame,
};
