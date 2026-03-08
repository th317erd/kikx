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
 * @returns {Array} messages suitable for agent execution
 */
export function buildMessages(frames, forAgentID) {
  // Collect toolUseIds that have results — used to filter orphaned pending-actions
  let resolvedToolIds = new Set();
  for (let frame of frames) {
    if (frame.type === 'tool-result' && frame.content && frame.content.toolUseId)
      resolvedToolIds.add(frame.content.toolUseId);
  }

  let messages = [];

  for (let frame of frames) {
    // Skip deleted and hidden frames (hidden = visible in UI but not in agent context)
    if (frame.deleted || frame.hidden)
      continue;

    let type = frame.type;

    // Skip excluded frame types explicitly
    if (EXCLUDED_TYPES.has(type))
      continue;

    if (type === 'user-message') {
      let content = frame.content || {};
      messages.push({ role: 'user', content: content.text || '', frameId: frame.id });
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
        messages.push({ role: 'user', content: wrapped, frameId: frame.id, sourceAgentID: frame.authorID });
      } else {
        // Own message or single-agent → standard assistant role
        messages.push({ role: 'assistant', content: html, frameId: frame.id });
      }
    } else if (type === 'tool-call') {
      let content = frame.content || {};
      messages.push({ type: 'tool-call', content, authorType: 'agent', frameId: frame.id });
    } else if (type === 'pending-action') {
      // Only include pending-actions that were approved (have a matching tool-result)
      let content = frame.content || {};
      if (content.toolUseId && resolvedToolIds.has(content.toolUseId))
        messages.push({ type: 'tool-call', content, authorType: 'agent', frameId: frame.id });
    } else if (type === 'tool-result') {
      let content = frame.content || {};
      messages.push({ type: 'tool-result', content, frameId: frame.id });
    }
  }

  return messages;
}
