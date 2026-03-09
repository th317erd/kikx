'use strict';

// =============================================================================
// Context Truncation
// =============================================================================
// Pure functions for truncating conversation context to stay within API limits.
// Two levels:
//   1. Per-message: cap individual large content (tool results, agent responses)
//   2. Conversation-level: drop oldest messages when total exceeds budget
// =============================================================================

const DEFAULT_MAX_CONTENT_LENGTH = 8000;   // ~2K tokens per message
const DEFAULT_MAX_TOTAL_CHARS    = 600000; // ~150K tokens total

/**
 * Get the character length of a message's content for budgeting purposes.
 */
function getContentLength(message) {
  if (message.type === 'tool-result') {
    let output = message.content && message.content.output;
    if (output == null)
      return 0;

    if (typeof output === 'string')
      return output.length;

    // Object output — measure its JSON representation
    let serialized = JSON.stringify(output);
    return serialized.length;
  }

  if (message.type === 'tool-call') {
    let content = message.content;
    if (content == null)
      return 0;

    let serialized = JSON.stringify(content);
    return serialized.length;
  }

  // role-based messages (user / assistant)
  let content = message.content;
  if (content == null)
    return 0;

  if (typeof content === 'string')
    return content.length;

  return 0;
}

/**
 * Truncate individual message content that exceeds maxContentLength.
 *
 * - For role-based messages: truncates the `content` string
 * - For tool-result messages: truncates `content.output`
 * - Appends a marker showing the original length
 * - Returns a new array (does not mutate input)
 *
 * @param {Array} messages
 * @param {object} [options]
 * @param {number} [options.maxContentLength=8000]
 * @returns {Array}
 */
export function truncateContent(messages, options = {}) {
  if (!messages || messages.length === 0)
    return messages || [];

  let maxLength = options.maxContentLength || DEFAULT_MAX_CONTENT_LENGTH;
  let result    = [];

  for (let i = 0; i < messages.length; i++) {
    let message = messages[i];
    let truncated = truncateMessageContent(message, maxLength);
    result.push(truncated);
  }

  return result;
}

/**
 * Truncate a single message's content if it exceeds maxLength.
 * Returns a new message object if truncated, or the original if unchanged.
 */
function truncateMessageContent(message, maxLength) {
  if (message.type === 'tool-result') {
    let output = message.content && message.content.output;
    if (output == null)
      return message;

    let text;
    let originalLength;

    if (typeof output === 'string') {
      text           = output;
      originalLength = output.length;
    } else {
      text           = JSON.stringify(output);
      originalLength = text.length;
    }

    if (originalLength <= maxLength)
      return message;

    let marker       = `\n\n[...content truncated — original was ${originalLength} characters]`;
    let truncatedText = text.slice(0, maxLength) + marker;

    return {
      ...message,
      content: { ...message.content, output: truncatedText },
    };
  }

  if (message.type === 'tool-call')
    return message; // Don't truncate tool calls — they need full arguments

  // Role-based messages (user / assistant)
  let content = message.content;
  if (content == null || typeof content !== 'string')
    return message;

  if (content.length <= maxLength)
    return message;

  let marker        = `\n\n[...content truncated — original was ${content.length} characters]`;
  let truncatedText = content.slice(0, maxLength) + marker;

  return { ...message, content: truncatedText };
}

/**
 * Drop oldest messages when total estimated characters exceed maxTotalChars.
 *
 * Rules:
 * - Never drops the last user message (current turn)
 * - Keeps tool-call + tool-result pairs together (no orphans)
 * - Prepends a marker message when messages are dropped
 * - Returns a new array (does not mutate input)
 *
 * @param {Array} messages
 * @param {object} [options]
 * @param {number} [options.maxTotalChars=600000]
 * @returns {Array}
 */
export function truncateConversation(messages, options = {}) {
  if (!messages || messages.length === 0)
    return messages || [];

  let maxTotalChars = options.maxTotalChars || DEFAULT_MAX_TOTAL_CHARS;

  // Calculate total content size
  let totalChars = 0;
  for (let i = 0; i < messages.length; i++)
    totalChars += getContentLength(messages[i]);

  // Under budget — return as-is
  if (totalChars <= maxTotalChars)
    return messages;

  // Find the last user message index — we never drop it
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  // Build a set of indices that are "paired" — tool-call indices paired with their tool-result
  let toolCallResultPairs = buildToolPairMap(messages);

  // Walk from the front, marking messages for removal until we're under budget
  let removedIndices = new Set();
  let currentTotal   = totalChars;

  for (let i = 0; i < messages.length && currentTotal > maxTotalChars; i++) {
    // Never drop the last user message
    if (i === lastUserIndex)
      continue;

    // Already marked for removal (as part of a pair)
    if (removedIndices.has(i))
      continue;

    let pairedIndex = toolCallResultPairs.get(i);

    // If this message is part of a tool pair, remove both
    if (pairedIndex !== undefined && pairedIndex !== i) {
      // Don't remove the pair if the partner is the last user message
      if (pairedIndex === lastUserIndex)
        continue;

      removedIndices.add(i);
      removedIndices.add(pairedIndex);
      currentTotal -= getContentLength(messages[i]);
      currentTotal -= getContentLength(messages[pairedIndex]);
    } else {
      removedIndices.add(i);
      currentTotal -= getContentLength(messages[i]);
    }
  }

  // If nothing was removed, return as-is (shouldn't happen, but safety)
  if (removedIndices.size === 0)
    return messages;

  // Build the result, skipping removed messages
  let result = [];

  // Prepend truncation marker
  result.push({
    role:    'user',
    content: `[Earlier conversation history was truncated. ${removedIndices.size} messages removed.]`,
  });

  for (let i = 0; i < messages.length; i++) {
    if (!removedIndices.has(i))
      result.push(messages[i]);
  }

  return result;
}

/**
 * Build a map of tool-call ↔ tool-result paired indices.
 * Each tool-call index maps to its tool-result index and vice versa.
 */
function buildToolPairMap(messages) {
  let pairs = new Map();

  // Index tool-calls by toolUseId
  let toolCallsByUseId = new Map();
  for (let i = 0; i < messages.length; i++) {
    let message = messages[i];
    if (message.type === 'tool-call') {
      let toolUseId = message.content && message.content.toolUseId;
      if (toolUseId)
        toolCallsByUseId.set(toolUseId, i);
    }
  }

  // Match tool-results to their tool-calls
  for (let i = 0; i < messages.length; i++) {
    let message = messages[i];
    if (message.type === 'tool-result') {
      let toolUseId = message.content && message.content.toolUseId;
      if (toolUseId && toolCallsByUseId.has(toolUseId)) {
        let callIndex = toolCallsByUseId.get(toolUseId);
        pairs.set(callIndex, i);
        pairs.set(i, callIndex);
      }
    }
  }

  return pairs;
}
