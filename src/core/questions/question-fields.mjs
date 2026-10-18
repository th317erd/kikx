'use strict';

/**
 * Shared field normalisation for ask-user question documents.
 *
 * These live in their own module so `questions-store.mjs` — already at its size
 * budget — can use them without growing. Both the store (schema at create time,
 * and `normalizeQuestionDoc`) and the lifecycle maintenance module need the same
 * rules, and duplicating them is how a field silently stops round-tripping.
 */

/**
 * Answer provenance. A default is the agent's own fallback, so the wake text and
 * the stored doc can say plainly that no human answered.
 */
export const DEFAULT_ANSWER_SOURCE = 'default';
export const USER_ANSWER_SOURCE = 'user';

/**
 * Coerce a timeout to whole milliseconds, or null when unset.
 *
 * Rejects negatives rather than clamping: a negative deadline would fire
 * immediately and silently, which is worse than a loud error at ask time.
 */
export function normalizeTimeoutMs(value) {
  if (value == null || value === '')
    return null;

  let ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0)
    throw new TypeError('timeout must be a non-negative number');

  return Math.floor(ms);
}

// --- Question field normalisers --------------------------------------------
//
// Moved verbatim out of `questions-store.mjs` when the P5b delivery fields
// pushed that file past its 800-line hard cap. Pure: no store state, no I/O.

export function normalizeContextRefs(value) {
  if (!Array.isArray(value))
    return [];

  let refs = [];
  for (let ref of value) {
    if (!ref || typeof ref !== 'object')
      continue;

    let type = normalizeOptionalString(ref.type);
    let id = normalizeOptionalString(ref.id);
    if (!type || !id)
      continue;

    refs.push({
      type,
      id,
      label: normalizeOptionalString(ref.label) || null,
      sessionID: normalizeOptionalString(ref.sessionID) || null,
      frameID: normalizeOptionalString(ref.frameID) || null,
      path: normalizeOptionalString(ref.path) || null,
    });
  }

  return refs;
}

export function normalizeQuestionText(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('question text must be a non-empty string');

  return value.trim();
}

export function normalizeAnswerText(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('answer must be a non-empty string');

  return value.trim();
}

export function normalizePriority(value) {
  let priority = normalizeOptionalString(value).toLowerCase();
  if (!priority)
    return 'normal';

  if (!PRIORITIES.includes(priority))
    throw new TypeError(`priority must be one of ${PRIORITIES.join(', ')}`);

  return priority;
}

export function normalizeMode(value) {
  let mode = normalizeOptionalString(value).toLowerCase();
  if (!mode)
    return 'wait';

  if (!MODES.includes(mode))
    throw new TypeError(`mode must be one of ${MODES.join(', ')}`);

  return mode;
}

export function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}

/**
 * Enumerations for the two validated question fields. They live here beside the
 * normalisers that enforce them, so a caller cannot import the validator without
 * the list it validates against. Exported because the store still re-validates
 * `mode` when reading a doc back.
 */
const PRIORITIES = [ 'low', 'normal', 'high' ];
const MODES = [ 'wait', 'continue' ];

export const QUESTION_PRIORITIES = [ ...PRIORITIES ];
export const QUESTION_MODES = [ ...MODES ];
