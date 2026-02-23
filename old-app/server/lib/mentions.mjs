'use strict';

// ============================================================================
// @Mention Parsing
// ============================================================================
// Detects @mentions in message text and resolves them to session participants.

import { getSessionParticipants } from '../lib/participants/index.mjs';

// Match @word patterns (alphanumeric, hyphens, underscores)
const MENTION_PATTERN = /@([\w-]+)/g;

/**
 * Extract all @mentions from message text.
 *
 * @param {string} text - Message content
 * @returns {string[]} Array of mention names (without @)
 */
export function extractMentions(text) {
  if (!text) return [];

  let mentions = [];
  let match;

  while ((match = MENTION_PATTERN.exec(text)) !== null) {
    mentions.push(match[1]);
  }

  // Reset regex lastIndex (global flag)
  MENTION_PATTERN.lastIndex = 0;

  return mentions;
}

/**
 * Resolve @mentions to session participants.
 * Matches by alias (preferred) or agent name (case-insensitive).
 *
 * @param {string[]} mentions - Mention names to resolve
 * @param {number} sessionId - Session ID
 * @param {Database} [database] - Optional database instance
 * @returns {Object[]} Resolved participants with agent info
 */
export function resolveMentions(mentions, sessionId, database) {
  if (!mentions || mentions.length === 0) return [];

  let participants = getSessionParticipants(sessionId, database);

  // Only look at agent participants (users can't be routed to)
  let agents = participants.filter((p) => p.participantType === 'agent');

  let resolved = [];

  for (let mention of mentions) {
    let lower = mention.toLowerCase();

    // First try alias match (exact, case-insensitive)
    let byAlias = agents.find((a) => a.alias && a.alias.toLowerCase() === lower);
    if (byAlias) {
      resolved.push(byAlias);
      continue;
    }

    // Then try agent name match (requires DB lookup for agent name)
    // We'll resolve this in the caller where we have agent data
  }

  return resolved;
}

/**
 * Resolve @mentions to agent participants, using enriched participant data
 * that includes agent names.
 *
 * @param {string[]} mentions - Mention names to resolve (without @)
 * @param {Object[]} participants - Enriched participant objects with name field
 * @returns {Object[]} Matching agent participants
 */
export function resolveMentionsFromEnriched(mentions, participants) {
  if (!mentions || mentions.length === 0 || !participants) return [];

  let agents = participants.filter((p) => p.participantType === 'agent');
  let resolved = [];
  let seen = new Set();

  for (let mention of mentions) {
    let lower = mention.toLowerCase();

    // Try alias match first (case-insensitive)
    let byAlias = agents.find((a) => a.alias && a.alias.toLowerCase() === lower && !seen.has(a.participantId));
    if (byAlias) {
      seen.add(byAlias.participantId);
      resolved.push(byAlias);
      continue;
    }

    // Try agent name match (case-insensitive)
    let byName = agents.find((a) => a.name && a.name.toLowerCase() === lower && !seen.has(a.participantId));
    if (byName) {
      seen.add(byName.participantId);
      resolved.push(byName);
    }
  }

  return resolved;
}

/**
 * Find the first @mentioned agent in a message, resolved against session
 * participants. Returns the agent ID to route the message to, or null
 * if no agent mentions found (use coordinator).
 *
 * @param {string} text - Message content
 * @param {Object[]} enrichedParticipants - Participants with name/alias fields
 * @returns {{ agentId: number, participant: Object } | null}
 */
export function findMentionedAgent(text, enrichedParticipants) {
  let mentions = extractMentions(text);
  if (mentions.length === 0) return null;

  let resolved = resolveMentionsFromEnriched(mentions, enrichedParticipants);
  if (resolved.length === 0) return null;

  return {
    agentId:     resolved[0].participantId,
    participant: resolved[0],
  };
}

export default {
  extractMentions,
  resolveMentions,
  resolveMentionsFromEnriched,
  findMentionedAgent,
};
