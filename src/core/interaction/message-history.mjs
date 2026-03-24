'use strict';

// =============================================================================
// Message History Utilities
// =============================================================================
// Pure functions for building agent message history from frames.
// Extracted from InteractionLoop to reduce file size.
// =============================================================================

// Frame types excluded from the agent's message history
const EXCLUDED_TYPES = new Set([
  'permission-request',
  'permission-denied',
  'hook-blocked',
  'tool-error',
  'error',
  'reflection',
  'command-result',
  'tool-activity',
  'stop',
]);

/**
 * Check if this is the first real message in the session
 * (at most one user-message and no assistant messages).
 */
export function isFirstMessage(frames) {
  let userMessageCount    = 0;
  let hasAssistantMessage = false;

  for (let frame of frames) {
    if (frame.deleted || frame.hidden)
      continue;

    if (frame.type === 'user-message')
      userMessageCount++;

    if (frame.type === 'message')
      hasAssistantMessage = true;
  }

  return userMessageCount <= 1 && !hasAssistantMessage;
}

/**
 * Inject primer text into the first user message of the messages array.
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
 * @param {Array} frames      — ordered frames from FrameManager.toArray()
 * @param {string} forAgentID — if set, multi-agent attribution wraps other agents' messages
 * @param {Object} [options]  — optional configuration
 * @param {Object} [options.activeCompaction] — if set, filters frames during active compaction
 *   { order: <number>, frameID: <string> }
 *   Include: all frames with order <= activeCompaction.order
 *   Include: frames with order > activeCompaction.order AND authorType === 'user'
 *   Exclude: all other frames after the compaction start frame
 * @returns {Array} messages suitable for agent execution
 */
export function buildMessages(frames, forAgentID, options = {}) {
  // First pass: collect resolved tool IDs and map each to its result frame.
  // Only consider non-deleted, non-hidden tool-result frames so we don't
  // include a pending-action whose result was removed.
  let resolvedToolIds  = new Set();
  let toolResultFrames = new Map(); // toolUseID → first matching tool-result frame

  for (let frame of frames) {
    if (frame.deleted || frame.hidden)
      continue;

    if (frame.type === 'tool-result' && frame.content && frame.content.toolUseID) {
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

  for (let frame of frames) {
    // Skip deleted and hidden frames (hidden = visible in UI but not in agent context)
    if (frame.deleted || frame.hidden)
      continue;

    let type = frame.type;

    // Skip excluded frame types explicitly
    if (EXCLUDED_TYPES.has(type))
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

    if (type === 'user-message') {
      let content = frame.content || {};
      messages.push({ role: 'user', content: content.html || content.text || '', frameID: frame.id });
    } else if (type === 'message') {
      let content = frame.content || {};
      let html    = content.html || '';

      // Multi-agent attribution: if forAgentID is set, determine whether this
      // message is from the target agent (role:assistant) or another agent
      // (role:user with XML wrapper).
      if (forAgentID && frame.authorID && frame.authorID !== forAgentID) {
        // Other agent's message → wrap in attribution tag, present as user role
        let agentName = frame.authorID;
        let wrapped   = `<agent-message source="${frame.authorID}" name="${agentName}">${html}</agent-message>`;
        messages.push({ role: 'user', content: wrapped, frameID: frame.id, sourceAgentID: frame.authorID });
      } else {
        // Own message or single-agent → standard assistant role
        messages.push({ role: 'assistant', content: html, frameID: frame.id });
      }
    } else if (type === 'tool-call') {
      let content   = frame.content || {};
      let toolUseID = content.toolUseID || content.toolUseId;

      // Only include tool-calls that have a matching tool-result.
      // Orphaned tool-calls (from permission hardBreak, crashes, or errors)
      // cause API errors: "tool_use ids found without tool_result blocks."
      if (toolUseID && !resolvedToolIds.has(toolUseID))
        continue;

      messages.push({ type: 'tool-call', content, authorType: 'agent', frameID: frame.id });
    } else if (type === 'pending-action') {
      // Only include pending-actions that were approved (have a matching tool-result)
      let content = frame.content || {};
      if (content.toolUseID && resolvedToolIds.has(content.toolUseID)) {
        // Strip internal fields (e.g. _parsedCommands) from arguments before
        // exposing to the agent — they are UI/permission-system metadata.
        let cleanContent = content;
        if (content.arguments && content.arguments._parsedCommands) {
          let { _parsedCommands, ...cleanArgs } = content.arguments;
          cleanContent = { ...content, arguments: cleanArgs };
        }

        messages.push({ type: 'tool-call', content: cleanContent, authorType: 'agent', frameID: frame.id });

        // Immediately emit the matching tool-result so the tool_use / tool_result
        // pair stays adjacent. Without this, user messages sent while a permission
        // was pending would land between the pair, causing API errors (e.g.
        // "tool_use ids found without tool_result blocks immediately after").
        let resultFrame = toolResultFrames.get(content.toolUseID);
        if (resultFrame && !emittedToolResults.has(content.toolUseID)) {
          emittedToolResults.add(content.toolUseID);
          messages.push({ type: 'tool-result', content: resultFrame.content || {}, frameID: resultFrame.id });
        }
      }
    } else if (type === 'tool-result') {
      let content  = frame.content || {};
      let resultID = content.toolUseID;

      // Deduplicate: only include the first tool-result per toolUseID
      if (resultID && emittedToolResults.has(resultID))
        continue;

      if (resultID)
        emittedToolResults.add(resultID);

      messages.push({ type: 'tool-result', content, frameID: frame.id });
    }
  }

  return messages;
}
