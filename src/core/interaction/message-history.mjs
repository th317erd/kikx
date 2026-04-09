'use strict';

// =============================================================================
// Message History Utilities
// =============================================================================
// Pure functions for building agent message history from frames.
// Extracted from InteractionLoop to reduce file size.
// =============================================================================

import { createTypedFrame } from '../../shared/frame-types/index.mjs';

/**
 * Check if this is the first real message in the session
 * (at most one user-message and no assistant messages).
 *
 * @param {import('../types').FrameData[]} frames
 * @returns {boolean}
 */
export function isFirstMessage(frames) {
  let userMessageCount    = 0;
  let hasAssistantMessage = false;

  for (let frame of frames) {
    if (frame.deleted || frame.hidden)
      continue;

    if (frame.type === 'UserMessage')
      userMessageCount++;

    if (frame.type === 'Message')
      hasAssistantMessage = true;
  }

  return userMessageCount <= 1 && !hasAssistantMessage;
}

/**
 * Inject primer text into the first user message of the messages array.
 *
 * @param {import('../types').ChatMessage[]} messages
 * @param {string} primer
 * @returns {import('../types').ChatMessage[]}
 */
export function injectPrimer(messages, primer) {
  if (!messages || messages.length === 0)
    return [{ role: 'user', content: primer }];

  let result = [...messages];
  for (let i = 0; i < result.length; i++) {
    if (result[i].role === 'user') {
      result[i] = { ...result[i], content: primer + '\n\n' + (result[i].content || '') };
      break;
    }
  }

  return result;
}

/**
 * Build agent-facing message history from a frame array.
 *
 * @param {import('../types').FrameData[]} frames — ordered frames from FrameManager.toArray()
 * @param {string} forAgentID — if set, multi-agent attribution wraps other agents' messages
 * @param {Object} [options]  — optional configuration
 * @param {{ order: number, frameID: string }} [options.activeCompaction] — if set, filters frames during active compaction
 * @param {Map<string, { name: string }>} [options.agents] — agent name map for attribution
 * @param {Map<string, { name: string }>} [options.users] — user name map for attribution
 * @returns {import('../types').ChatMessage[]} messages suitable for agent execution
 */
export function buildMessages(frames, forAgentID, options = {}) {
  // First pass: collect resolved tool IDs and map each to its result frame.
  // Only consider non-deleted, non-hidden tool-result frames so we don't
  // include a tool-call whose result was removed.
  let resolvedToolIds  = new Set();
  let toolResultFrames = new Map(); // toolUseID → first matching tool-result frame

  for (let frame of frames) {
    if (frame.deleted || frame.hidden)
      continue;

    if (frame.type === 'ToolResult' && frame.content && frame.content.toolUseID) {
      resolvedToolIds.add(frame.content.toolUseID);

      if (!toolResultFrames.has(frame.content.toolUseID))
        toolResultFrames.set(frame.content.toolUseID, frame);
    }
  }

  let messages = [];

  // Track which toolUseIDs already have a tool-result in the output —
  // prevents duplicate tool_result blocks that cause Anthropic API errors
  let emittedToolResults = new Set();

  // --- Compaction: extract active compaction filter ---
  let activeCompaction = options.activeCompaction || null;

  // Options passed to each frame type's toAgentMessage()
  let msgOptions = {
    forAgentID,
    toolResultMap:    resolvedToolIds,
    emittedToolResults,
    toolResultFrames,
    agents: options.agents || null,
  };

  for (let frame of frames) {
    // Skip deleted and hidden frames (hidden = visible in UI but not in agent context)
    if (frame.deleted || frame.hidden)
      continue;

    let typed = createTypedFrame(frame);

    // Use frame type class to determine if this type belongs in agent context
    if (!typed.isIncludedInAgentContext())
      continue;

    // --- Compaction: filter frames during active compaction ---
    // When compaction is in progress, only include:
    //   - All frames up to and including the compaction start frame (order <= activeCompaction.order)
    //   - User-authored frames AFTER the compaction start frame
    //   - Exclude everything else after the compaction start frame
    if (activeCompaction && frame.order > activeCompaction.order) {
      if (frame.authorType !== 'user')
        continue;
    }

    let msg = typed.toAgentMessage(msgOptions);
    if (!msg)
      continue;

    messages.push(msg);

    // Backward compat: when a PendingAction is converted to a ToolCall,
    // immediately emit its adjacent ToolResult to keep the pair together.
    // This prevents user messages inserted between PendingAction and
    // ToolResult from splitting the tool-call/tool-result pair.
    if (typeof typed.emitAdjacentToolResult === 'function') {
      let adjacentResult = typed.emitAdjacentToolResult(msgOptions);
      if (adjacentResult)
        messages.push(adjacentResult);
    }
  }

  // Sanitize: ensure every tool_use has a matching tool_result and vice versa.
  // Orphaned tool calls/results cause Claude API to reject the history.
  return sanitizeToolPairs(messages);
}

/**
 * Removes orphaned tool_use blocks (no matching tool_result) and orphaned
 * tool_result blocks (no matching tool_use) from the message history.
 * This prevents Claude API "inconsistent tool state" errors caused by
 * corrupted frame data (e.g., rogue frames with wrong interactionIDs).
 *
 * @param {import('../types').ChatMessage[]} messages
 * @returns {import('../types').ChatMessage[]}
 */
function sanitizeToolPairs(messages) {
  // Collect all tool_use IDs and tool_result IDs
  let toolUseIDs    = new Set();
  let toolResultIDs = new Set();

  for (let msg of messages) {
    if (!Array.isArray(msg.content))
      continue;

    for (let block of msg.content) {
      if (block.type === 'tool_use' && block.id)
        toolUseIDs.add(block.id);
      else if (block.type === 'tool_result' && block.tool_use_id)
        toolResultIDs.add(block.tool_use_id);
    }
  }

  // Find orphans
  let orphanedUseIDs    = new Set();
  let orphanedResultIDs = new Set();

  for (let id of toolUseIDs) {
    if (!toolResultIDs.has(id))
      orphanedUseIDs.add(id);
  }

  for (let id of toolResultIDs) {
    if (!toolUseIDs.has(id))
      orphanedResultIDs.add(id);
  }

  if (orphanedUseIDs.size === 0 && orphanedResultIDs.size === 0)
    return messages;

  // Strip orphaned blocks from messages
  let cleaned = [];

  for (let msg of messages) {
    if (!Array.isArray(msg.content)) {
      cleaned.push(msg);
      continue;
    }

    let filteredContent = msg.content.filter((block) => {
      if (block.type === 'tool_use' && orphanedUseIDs.has(block.id))
        return false;

      if (block.type === 'tool_result' && orphanedResultIDs.has(block.tool_use_id))
        return false;

      return true;
    });

    // Only include the message if it still has content
    if (filteredContent.length > 0)
      cleaned.push({ ...msg, content: filteredContent });
  }

  return cleaned;
}
