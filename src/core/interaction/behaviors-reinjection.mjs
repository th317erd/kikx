'use strict';

// =============================================================================
// Behaviors Re-injection
// =============================================================================
// After context truncation drops the primer (and the behaviors within it),
// this function re-injects the agent's behaviors text into the first user
// message so the agent retains behavioral constraints across long conversations.
//
// Pure function — does not mutate input, returns a new array when changes apply.
// =============================================================================

const TRUNCATION_MARKER_PREFIX = '[Earlier conversation history was truncated';

/**
 * Re-inject agent behaviors into messages after truncation.
 *
 * Conditions for injection (ALL must be true):
 *   1. options.primerInjected is NOT true (primer already has behaviors)
 *   2. agent is present and has behaviors
 *   3. Truncation occurred (marker message detected)
 *   4. A non-marker user message exists to inject into
 *
 * @param {import('../types').ChatMessage[]} messages
 * @param {import('../types').Agent} agent
 * @param {{ primerInjected?: boolean, isDMForAgent?: () => Promise<boolean> }} [options]
 * @returns {Promise<import('../types').ChatMessage[]>}
 */
export async function reinjectBehaviors(messages, agent, options = {}) {
  if (!messages || messages.length === 0)
    return messages || [];

  if (options.primerInjected)
    return messages;

  if (agent == null || typeof agent.hasBehaviors !== 'function' || !await agent.hasBehaviors())
    return messages;

  // Skip behaviors in DM sessions — DMs are for configuring the agent
  if (options.isDMForAgent && await options.isDMForAgent())
    return messages;

  if (!hasTruncationMarker(messages))
    return messages;

  let behaviorsBlock = buildBehaviorsBlock(await agent.getBehaviors());

  // Find the first user message that is NOT the truncation marker
  let targetIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    let message = messages[i];
    if (message.role !== 'user')
      continue;

    if (isTruncationMarker(message))
      continue;

    targetIndex = i;
    break;
  }

  // No non-marker user message found — nothing to inject into
  if (targetIndex < 0)
    return messages;

  // Build a new array without mutating input
  let result = [];
  for (let i = 0; i < messages.length; i++) {
    if (i === targetIndex) {
      let original = messages[i];
      let content  = (original.content || '') + '\n\n' + behaviorsBlock;
      result.push({ ...original, content });
    } else {
      result.push(messages[i]);
    }
  }

  return result;
}

/**
 * Check if any message in the array is a truncation marker.
 *
 * @param {import('../types').ChatMessage[]} messages
 * @returns {boolean}
 */
function hasTruncationMarker(messages) {
  for (let i = 0; i < messages.length; i++) {
    if (isTruncationMarker(messages[i]))
      return true;
  }

  return false;
}

/**
 * Check if a single message is a truncation marker.
 *
 * @param {import('../types').ChatMessage} message
 * @returns {boolean}
 */
function isTruncationMarker(message) {
  if (message.role !== 'user')
    return false;

  if (typeof message.content !== 'string')
    return false;

  return message.content.startsWith(TRUNCATION_MARKER_PREFIX);
}

/**
 * Build the behaviors text block with delimiters and reminder.
 *
 * @param {string} behaviorsText
 * @returns {string}
 */
function buildBehaviorsBlock(behaviorsText) {
  return (
    '--- BEHAVIORS ---\n' +
    behaviorsText + '\n' +
    '--- END BEHAVIORS ---\n' +
    'BEHAVIORS ARE MANDATORY. Before responding to EVERY user message, you MUST:\n' +
    '1. Review your BEHAVIORS section above.\n' +
    '2. Check if any behavior applies to the current message.\n' +
    '3. If a behavior applies, follow its instructions EXACTLY — behaviors override your default behavior.\n' +
    '4. If no behavior applies, respond normally.\n' +
    'Behaviors are not suggestions — they are behavioral rules you must obey on every interaction.'
  );
}
