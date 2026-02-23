'use strict';

// ============================================================================
// Conditional Abilities System
// ============================================================================
// Checks user messages against ability conditions ("when" clauses) and
// injects relevant instructions into the context when conditions match.
//
// This allows abilities to automatically activate based on conversation context.

import { getConditionalAbilities } from './registry.mjs';
import { getDatabase } from '../../database.mjs';

/**
 * Check all conditional abilities against the current message context.
 * Returns instructions that should be injected into the agent's context.
 *
 * @param {Object} context - The message context
 * @param {string} context.userMessage - The user's message content
 * @param {number} context.sessionID - The session ID
 * @param {Array} context.recentMessages - Recent messages for context
 * @returns {Promise<Object>} Result with any matching ability instructions
 */
export async function checkConditionalAbilities(context) {
  let { userMessage, sessionID, recentMessages = [] } = context;

  console.log('[Conditional] Checking abilities for message:', userMessage.slice(0, 100));

  let conditionalAbilities = getConditionalAbilities();
  console.log('[Conditional] Found', conditionalAbilities.length, 'conditional abilities');

  if (conditionalAbilities.length === 0) {
    return { matched: false, instructions: [] };
  }

  let matched = [];

  for (let ability of conditionalAbilities) {
    let condition = ability.applies || ability.when;

    if (!condition) continue;

    // Use the ability's built-in matcher if it has one
    if (typeof ability.matchCondition === 'function') {
      let matchResult = await ability.matchCondition(context);

      if (matchResult.matches) {
        console.log('[Conditional] Ability matched:', ability.name);
        matched.push({
          abilityName:  ability.name,
          condition:    condition,
          message:      ability.message || ability.content,
          matchDetails: matchResult.details || {},
        });
      }
    }
  }

  if (matched.length > 0) {
    console.log('[Conditional] Matched abilities:', matched.map(m => m.abilityName));
  }

  return {
    matched:      matched.length > 0,
    instructions: matched,
  };
}

/**
 * Format matched ability instructions for injection into context.
 *
 * @param {Array} instructions - Matched ability instructions
 * @returns {string} Formatted instructions for the agent
 */
export function formatConditionalInstructions(instructions) {
  if (!instructions || instructions.length === 0) {
    return '';
  }

  let parts = ['[System: Conditional Ability Triggered]\n'];

  for (let instruction of instructions) {
    parts.push(`**${instruction.abilityName}**: ${instruction.message}`);

    if (instruction.matchDetails && Object.keys(instruction.matchDetails).length > 0) {
      parts.push('Details:');
      parts.push('```json');
      parts.push(JSON.stringify(instruction.matchDetails, null, 2));
      parts.push('```');
    }

    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Get unanswered hml-prompt elements from recent messages.
 *
 * @param {number} sessionID - The session ID
 * @param {Object} [testDb] - Optional database instance for testing
 * @returns {Array} Array of unanswered prompt objects
 */
export function getUnansweredPrompts(sessionID, testDb = null) {
  let db = testDb || getDatabase();

  // Get recent agent message frames that might contain prompts
  let frames = db.prepare(`
    SELECT id, payload, timestamp
    FROM frames
    WHERE session_id = ? AND type = 'message' AND author_type = 'agent'
    ORDER BY timestamp DESC
    LIMIT 10
  `).all(sessionID);

  let unansweredPrompts = [];

  for (let frame of frames) {
    let payload;

    try {
      payload = JSON.parse(frame.payload);
    } catch {
      continue;
    }

    // Skip hidden frames
    if (payload.hidden) continue;

    let content = payload.content;
    if (typeof content !== 'string') continue;

    // Find all hml-prompt elements (and legacy user-prompt/user_prompt)
    let promptPattern = /<(?:hml-|user[-_])prompt\s+id=["']([^"']+)["'][^>]*(?:\s+answered(?:=["']true["'])?)?[^>]*>([^<]*)/gi;
    let match;

    while ((match = promptPattern.exec(content)) !== null) {
      let fullMatch = match[0];
      let promptID = match[1];
      let question = match[2].trim();

      // Check if this prompt is answered (has answered attribute)
      let isAnswered = /answered(?:=["']true["'])?/.test(fullMatch);

      if (!isAnswered) {
        unansweredPrompts.push({
          messageID: frame.id,  // Frame ID (backward compatible field name)
          promptID:  promptID,
          question:  question,
        });
      }
    }
  }

  console.log('[Conditional] Found unanswered prompts:', unansweredPrompts.length);

  return unansweredPrompts;
}

export default {
  checkConditionalAbilities,
  formatConditionalInstructions,
  getUnansweredPrompts,
};
