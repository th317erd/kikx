'use strict';

// ============================================================================
// Frame-Based Context Builder
// ============================================================================
// Builds conversation context for AI from frames instead of messages.
// Uses frame compilation to build the effective state.

import {
  getFrames,
  getLatestCompact,
  compileFrames,
  FrameType,
  AuthorType,
} from './index.mjs';
import { getStartupAbilities } from '../abilities/registry.mjs';

// Debug logging
function debug(sessionId, ...args) {
  if (process.env.DEBUG) {
    const prefix = (sessionId) ? `[session_${sessionId}]` : '[FrameContext]';
    console.log(prefix, ...args);
  }
}

/**
 * Strip <interaction> tags from text.
 * These tags represent interactions that were already executed by the server.
 * Showing them to the AI causes confusion (AI might try to execute them again).
 *
 * @param {string} text - Text potentially containing <interaction> tags
 * @returns {string} Text with interaction tags removed
 */
function stripInteractionTags(text) {
  if (!text) return text;
  return text.replace(/<interaction>[\s\S]*?<\/interaction>/g, '').trim();
}

/**
 * Load frames for AI context, using compact frames as checkpoints.
 * Returns frames compiled into a format suitable for the AI.
 *
 * @param {number} sessionId - Session ID
 * @param {Object} [options] - Options
 * @param {number} [options.maxRecentFrames] - Max frames to load after compact
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object[]} Array of messages in AI format [{role, content}]
 */
export function loadFramesForContext(sessionId, options = {}, db = null) {
  const { maxRecentFrames = 50 } = options;

  // Get frames from the most recent compact point forward
  const frames = getFrames(sessionId, { fromCompact: true, limit: maxRecentFrames }, db);

  debug(sessionId, 'Loading frames for context', {
    frameCount: frames.length,
    fromCompact: true,
  });

  if (frames.length === 0) {
    return [];
  }

  // Compile frames to get effective state
  const compiled = compileFrames(frames);

  // Convert compiled frames to AI message format
  const messages = [];

  // Check if we have a compact frame - if so, add its snapshot as context
  const compactFrame = frames.find((f) => f.type === FrameType.COMPACT);
  if (compactFrame && compactFrame.payload.context) {
    messages.push({
      role: 'assistant',
      content: `[RESTORED CONTEXT - Continue from here]\n\n${compactFrame.payload.context}\n\n[END RESTORED CONTEXT - Resume conversation below]`,
    });

    // Re-inject startup abilities after compaction.
    // The original hidden startup frames are behind the compact point and no
    // longer loaded, so the agent loses its core instructions (e.g. the
    // <interaction> tag format).  Re-inject them here so every post-compaction
    // context includes the latest startup content.
    let startupAbilities = getStartupAbilities();
    let startupContent   = startupAbilities
      .filter((a) => a.type === 'process' && a.content)
      .map((a) => a.content)
      .join('\n\n---\n\n');

    if (startupContent) {
      messages.push({
        role:    'user',
        content: `[System Initialization]\n\n${startupContent}`,
      });
      messages.push({
        role:    'assistant',
        content: 'Understood. I\'ve processed the initialization instructions. Ready to assist.',
      });
    }
  }

  // Process message frames in order
  for (const frame of frames) {
    // Skip non-message frames
    if (frame.type !== FrameType.MESSAGE) {
      continue;
    }

    // Get compiled content (may have been updated)
    const content = compiled.get(frame.id);
    if (!content) {
      continue;
    }

    // Determine role from author type or payload
    // Note: Claude API only accepts 'user' and 'assistant' roles,
    // not 'system' (system prompts go in the `system` parameter)
    let role;
    if (content.role) {
      // Map 'system' role to 'user' for API compatibility
      role = (content.role === 'system') ? 'user' : content.role;
    } else if (frame.authorType === AuthorType.USER) {
      role = 'user';
    } else if (frame.authorType === AuthorType.AGENT) {
      role = 'assistant';
    } else if (frame.authorType === AuthorType.SYSTEM) {
      role = 'user'; // System messages sent as user for context
    } else {
      role = 'user';
    }

    // Extract content string
    let messageContent;
    if (typeof content === 'string') {
      messageContent = content;
    } else if (content.content) {
      messageContent = content.content;
    } else if (content.text) {
      messageContent = content.text;
    } else {
      // Fall back to JSON stringification for complex payloads
      messageContent = JSON.stringify(content);
    }

    // Strip <interaction> tags from user messages - they were already executed
    // by the server and showing them to the AI causes confusion
    let cleanedContent = (role === 'user') ? stripInteractionTags(messageContent) : messageContent;

    messages.push({
      role,
      content: cleanedContent,
    });
  }

  // Also include request/result frames as context (important for multi-turn)
  for (const frame of frames) {
    if (frame.type === FrameType.REQUEST) {
      const content = compiled.get(frame.id);
      if (content && content.feedback) {
        // This request has been answered - include the feedback
        messages.push({
          role: 'user',
          content: `[Interaction Result]\n${JSON.stringify(content.feedback)}`,
        });
      }
    } else if (frame.type === FrameType.RESULT) {
      const content = compiled.get(frame.id);
      if (content) {
        messages.push({
          role: 'user',
          content: `[System Result]\n${JSON.stringify(content)}`,
        });
      }
    }
  }

  debug(sessionId, 'Context built from frames', {
    messageCount: messages.length,
    frameCount: frames.length,
  });

  return messages;
}

/**
 * Get the raw frames for a session, suitable for client display.
 * Unlike loadFramesForContext, this returns the frame objects themselves.
 *
 * @param {number} sessionId - Session ID
 * @param {Object} [options] - Options
 * @param {boolean} [options.fromCompact] - Start from most recent compact
 * @param {string[]} [options.types] - Filter by frame types
 * @param {number} [options.limit] - Max frames to return
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object} Object with frames array and compiled map
 */
export function getFramesForDisplay(sessionId, options = {}, db = null) {
  const frames = getFrames(sessionId, options, db);
  const compiled = compileFrames(frames);

  // Convert Map to plain object for JSON serialization
  const compiledObj = {};
  for (const [id, payload] of compiled) {
    compiledObj[id] = payload;
  }

  return {
    frames,
    compiled: compiledObj,
    count: frames.length,
  };
}

/**
 * Build a summary of the conversation for compaction.
 * Returns the formatted content suitable for an AI to summarize.
 *
 * @param {number} sessionId - Session ID
 * @param {Database} [db] - Optional database instance for testing
 * @returns {string} Formatted conversation for summarization
 */
export function buildConversationForCompaction(sessionId, db = null) {
  const frames = getFrames(sessionId, { fromCompact: true }, db);
  const compiled = compileFrames(frames);

  const lines = [];

  for (const frame of frames) {
    if (frame.type !== FrameType.MESSAGE) {
      continue;
    }

    const content = compiled.get(frame.id);
    if (!content) {
      continue;
    }

    let role = 'User';
    if (frame.authorType === AuthorType.AGENT) {
      role = 'Assistant';
    } else if (frame.authorType === AuthorType.SYSTEM) {
      role = 'System';
    }

    let text;
    if (typeof content === 'string') {
      text = content;
    } else if (content.content) {
      text = content.content;
    } else if (content.text) {
      text = content.text;
    } else {
      text = JSON.stringify(content);
    }

    lines.push(`${role}: ${text}`);
  }

  return lines.join('\n\n');
}

/**
 * Count the number of message frames since the last compact.
 * Used to determine when compaction is needed.
 *
 * @param {number} sessionId - Session ID
 * @param {Database} [db] - Optional database instance for testing
 * @returns {number} Number of message frames since last compact
 */
export function countMessagesSinceCompact(sessionId, db = null) {
  const latestCompact = getLatestCompact(sessionId, db);

  const options = {};
  if (latestCompact) {
    options.fromTimestamp = latestCompact.timestamp;
  }
  options.types = ['message'];

  const frames = getFrames(sessionId, options, db);
  return frames.length;
}

export default {
  loadFramesForContext,
  getFramesForDisplay,
  buildConversationForCompaction,
  countMessagesSinceCompact,
};
