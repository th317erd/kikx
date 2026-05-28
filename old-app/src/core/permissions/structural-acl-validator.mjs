'use strict';

// =============================================================================
// Structural ACL Commit Validator
// =============================================================================

/** @type {Record<string, Set<string>|null>} Frame types each authorType is allowed to CREATE */
const ALLOWED_TYPES = {
  system: null, // null = any type
  user:   new Set(['UserMessage', 'hml-prompt-value']),
  agent:  new Set(['Message', 'ToolCall', 'Reflection']),
  tool:   new Set(['ToolResult', 'ToolError']),
};

/** @type {Set<string>} Fields that can never change after a frame is created */
const IMMUTABLE_FIELDS = new Set(['type', 'authorType', 'authorID']);

/**
 * Creates a commit validator function that enforces structural ACL rules.
 *
 * @param {object} [options]
 * @param {Record<string, Set<string>|null>} [options.allowedTypes]
 * @param {Set<string>} [options.immutableFields]
 * @returns {(commit: import('../types').Commit, frames: import('../types').FrameData[], actorContext: { authorType: string, authorID?: string }) => { allowed: boolean, reason?: string }}
 */
export function createStructuralACLValidator(options = {}) {
  let allowedTypes    = options.allowedTypes || ALLOWED_TYPES;
  let immutableFields = options.immutableFields || IMMUTABLE_FIELDS;

  /**
   * @param {import('../types').Commit} commit
   * @param {import('../types').FrameData[]} frames
   * @param {{ authorType: string, authorID?: string }} actorContext
   * @returns {{ allowed: boolean, reason?: string }}
   */
  return function validate(commit, frames, actorContext) {
    let authorType = actorContext.authorType;

    // Unknown authorType — deny by default
    if (!authorType || !(authorType in allowedTypes))
      return { allowed: false, reason: `Unknown authorType: "${authorType}"` };

    let typeRestrictions = allowedTypes[authorType];

    for (let i = 0; i < commit.changes.length; i++) {
      let change = commit.changes[i];
      let frame  = frames[i];

      if (!frame)
        continue;

      if (change.operation === 'create') {
        // Rule 1: Type restrictions — check if this authorType can create this frame type
        if (typeRestrictions !== null && !typeRestrictions.has(frame.type)) {
          return {
            allowed: false,
            reason:  `authorType "${authorType}" cannot create frame type "${frame.type}"`,
          };
        }
      } else if (change.operation === 'update') {
        // Rule 2: Ownership — can only modify own frames (system can modify any)
        if (authorType !== 'system') {
          if (frame.authorType && frame.authorType !== authorType) {
            return {
              allowed: false,
              reason:  `authorType "${authorType}" cannot modify frame owned by "${frame.authorType}"`,
            };
          }

          if (frame.authorID && actorContext.authorID && frame.authorID !== actorContext.authorID) {
            return {
              allowed: false,
              reason:  `actor "${actorContext.authorID}" cannot modify frame owned by "${frame.authorID}"`,
            };
          }
        }
      }
    }

    return { allowed: true };
  };
}

// Export constants for testing
export { ALLOWED_TYPES, IMMUTABLE_FIELDS };
