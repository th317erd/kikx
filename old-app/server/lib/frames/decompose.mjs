'use strict';

// ============================================================================
// Frame Decomposition
// ============================================================================
// Pure function that decomposes a raw message into an ordered array of
// content and interaction segment descriptors.
//
// No I/O, no database, no imports from framework — just parsing.
// Same input always produces same output.

// Regex to find <interaction> opening tags (with or without HTML attributes).
// Same pattern as detector.mjs — only matches OPENING tags, not full blocks.
const INTERACTION_OPEN_REGEX = /<interaction(?:\s[^>]*)?>[\s]*/g;

const CLOSE_TAG = '</interaction>';

// Maximum parse attempts per tag to prevent infinite loops on pathological input
const MAX_PARSE_ATTEMPTS = 5;

// Fields that must be present for a valid interaction
const REQUIRED_INTERACTION_FIELDS = ['interaction_id', 'target_id', 'target_property'];

// Security-sensitive properties stripped from agent-generated interactions
const SENSITIVE_PROPERTIES = ['sender_id'];

/**
 * Map authorType to conversational role.
 *
 * @param {string} authorType - 'user' | 'assistant' | 'agent' | 'system'
 * @returns {string} 'user' or 'assistant'
 */
function mapRole(authorType) {
  if (authorType === 'assistant' || authorType === 'agent')
    return 'assistant';

  return 'user';
}

/**
 * Validate that an interaction object has the required fields.
 *
 * @param {Object} interaction - Parsed interaction object
 * @returns {boolean} True if valid
 */
function isValidInteraction(interaction) {
  if (typeof interaction !== 'object' || interaction === null)
    return false;

  for (let field of REQUIRED_INTERACTION_FIELDS) {
    if (!interaction[field] || typeof interaction[field] !== 'string')
      return false;
  }

  return true;
}

/**
 * Strip security-sensitive properties from an interaction.
 *
 * @param {Object} interaction - Parsed interaction object
 * @returns {Object} Clean copy without sensitive properties
 */
function stripSensitive(interaction) {
  let clean = { ...interaction };

  for (let property of SENSITIVE_PROPERTIES)
    delete clean[property];

  return clean;
}

/**
 * Find the closing </interaction> tag that produces valid JSON.
 * Handles cases where the JSON payload contains </interaction> as a string.
 *
 * Same strategy as detector.mjs findValidClosing() — try each </interaction>
 * we encounter, and if JSON.parse fails, keep looking.
 *
 * @param {string} text - Full message text
 * @param {number} bodyStart - Index where JSON body starts (after opening tag >)
 * @returns {{ endIndex: number, json: Object }|null}
 */
function findValidClosing(text, bodyStart) {
  let searchFrom = bodyStart;
  let attempts   = 0;

  while (attempts < MAX_PARSE_ATTEMPTS) {
    let closeIndex = text.indexOf(CLOSE_TAG, searchFrom);

    if (closeIndex === -1)
      return null;

    let jsonString = text.slice(bodyStart, closeIndex).trim();

    try {
      let parsed = JSON.parse(jsonString);
      return { endIndex: closeIndex + CLOSE_TAG.length, json: parsed };
    } catch {
      // This </interaction> was inside a JSON string — try the next one
      searchFrom = closeIndex + CLOSE_TAG.length;
      attempts++;
    }
  }

  return null;
}

/**
 * Parse and validate a JSON object as an interaction.
 * Handles both single objects and arrays. Returns first valid interaction.
 *
 * @param {*} parsed - Parsed JSON value
 * @returns {Object|null} Cleaned, valid interaction or null
 */
function validateParsedInteraction(parsed) {
  if (typeof parsed !== 'object' || parsed === null)
    return null;

  if (Array.isArray(parsed)) {
    for (let item of parsed) {
      let clean = stripSensitive(item);
      if (isValidInteraction(clean))
        return clean;
    }
    return null;
  }

  let clean = stripSensitive(parsed);

  if (!isValidInteraction(clean))
    return null;

  return clean;
}

/**
 * Decompose a raw message into an ordered array of segment descriptors.
 *
 * Each segment is either:
 *   { type: 'content', role: string, text: string }
 *   { type: 'interaction', raw: string, parsed: Object }
 *
 * Uses the same find-valid-closing strategy as detector.mjs to correctly
 * handle JSON payloads that contain </interaction> as a string value.
 *
 * @param {string} content - Raw message text (may contain <interaction> tags)
 * @param {string} authorType - 'user' | 'assistant' | 'agent' | 'system'
 * @returns {Array<Object>} Ordered array of segment descriptors
 */
export function decomposeMessage(content, authorType) {
  if (!content || typeof content !== 'string')
    return [];

  let role     = mapRole(authorType);
  let segments = [];

  // Reset regex state (global flag)
  INTERACTION_OPEN_REGEX.lastIndex = 0;

  let lastIndex = 0;
  let match;

  while ((match = INTERACTION_OPEN_REGEX.exec(content)) !== null) {
    let tagStart = match.index;
    let bodyStart = tagStart + match[0].length;

    // Find the valid closing tag (handles </interaction> inside JSON strings)
    let result = findValidClosing(content, bodyStart);

    if (!result) {
      // No valid closing found — skip this opening tag, treat as content
      continue;
    }

    let raw    = content.slice(tagStart, result.endIndex);
    let parsed = validateParsedInteraction(result.json);

    if (parsed) {
      // Content segment before this interaction tag
      let before = content.slice(lastIndex, tagStart).trim();
      if (before)
        segments.push({ type: 'content', role, text: before });

      // Interaction segment
      segments.push({ type: 'interaction', raw, parsed });
      lastIndex = result.endIndex;

      // Advance regex past the full tag to avoid re-matching
      INTERACTION_OPEN_REGEX.lastIndex = result.endIndex;
    } else {
      // Valid JSON but not a valid interaction — skip, treat as content
      INTERACTION_OPEN_REGEX.lastIndex = result.endIndex;
    }
  }

  // Remaining content after the last interaction tag
  let remaining = content.slice(lastIndex).trim();
  if (remaining)
    segments.push({ type: 'content', role, text: remaining });

  return segments;
}
