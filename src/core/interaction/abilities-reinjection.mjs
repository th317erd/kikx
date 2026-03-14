'use strict';

// =============================================================================
// Abilities Re-injection
// =============================================================================
// After context truncation drops the primer (and the abilities within it),
// this function re-injects the agent's abilities text into the first user
// message so the agent retains behavioral constraints across long conversations.
//
// Pure function — does not mutate input, returns a new array when changes apply.
// =============================================================================

const TRUNCATION_MARKER_PREFIX = '[Earlier conversation history was truncated';

/**
 * Re-inject agent abilities into messages after truncation.
 *
 * Conditions for injection (ALL must be true):
 *   1. options.primerInjected is NOT true (primer already has abilities)
 *   2. agent is present and has abilities
 *   3. Truncation occurred (marker message detected)
 *   4. A non-marker user message exists to inject into
 *
 * @param {Array}  messages
 * @param {object} agent
 * @param {object} [options]
 * @param {boolean} [options.primerInjected] — true when primer is being injected this turn
 * @returns {Promise<Array>}
 */
export async function reinjectAbilities(messages, agent, options = {}) {
  if (!messages || messages.length === 0)
    return messages || [];

  if (options.primerInjected)
    return messages;

  if (agent == null || typeof agent.hasAbilities !== 'function' || !await agent.hasAbilities())
    return messages;

  if (!hasTruncationMarker(messages))
    return messages;

  let abilitiesBlock = buildAbilitiesBlock(await agent.getAbilities());

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
      let content  = (original.content || '') + '\n\n' + abilitiesBlock;
      result.push({ ...original, content });
    } else {
      result.push(messages[i]);
    }
  }

  return result;
}

/**
 * Check if any message in the array is a truncation marker.
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
 */
function isTruncationMarker(message) {
  if (message.role !== 'user')
    return false;

  if (typeof message.content !== 'string')
    return false;

  return message.content.startsWith(TRUNCATION_MARKER_PREFIX);
}

/**
 * Build the abilities text block with delimiters and reminder.
 */
function buildAbilitiesBlock(abilitiesText) {
  return (
    '--- ABILITIES ---\n' +
    abilitiesText + '\n' +
    '--- END ABILITIES ---\n' +
    'Remember to check each user request against your ABILITIES before proceeding.'
  );
}
