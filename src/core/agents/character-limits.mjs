'use strict';

// P6 (D2): a compressed/short character must accompany the full character so
// Brief A can carry a bounded persona even for small-context models. The limit
// is deliberately small enough to force genuine compression.
export const MAX_CHARACTER_COMPRESSED_LENGTH = 400;

// Canonical stored field on the agent record.
export const CHARACTER_COMPRESSED_FIELD = 'characterCompressed';

// Canonical fallback chain for readers (Brief A). Newest canonical field first,
// then historical aliases, then the full character so Brief A never comes up
// empty for an agent created before P6.
export const CHARACTER_COMPRESSED_FALLBACK_FIELDS = [
  'characterCompressed',
  'compressedCharacter',
  'characterShort',
  'shortCharacter',
];

export function resolveCompressedCharacter(agent = {}) {
  if (!agent || typeof agent !== 'object')
    return '';

  for (let field of CHARACTER_COMPRESSED_FALLBACK_FIELDS) {
    let value = agent[field];
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim();
  }

  return '';
}
