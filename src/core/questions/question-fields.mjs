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
export const AGENT_ANSWER_SOURCE = 'agent';

// --- Revision intent -------------------------------------------------------

/**
 * What a second submission against a fired default MEANS.
 *
 * `change` is the obvious one: the default was wrong, and this text replaces it.
 * The asking agent must be told, because it may already have acted on the
 * default.
 *
 * `confirm` is the acknowledgement: "the default you applied was right". That
 * carries no new information — the agent already has that answer — so it is
 * recorded and shown without waking anybody.
 *
 * The caller DECLARES which one it is, rather than the server inferring it from
 * the text, because text cannot distinguish them: "ok", "that's right" and
 * "declined to say" are all just strings. Guessing wrong is expensive in both
 * directions — read an acknowledgement as a change and the agent is woken to be
 * told nothing, read a change as an acknowledgement and the agent keeps a wrong
 * assumption forever.
 */
export const REVISION_INTENT_CHANGE = 'change';
export const REVISION_INTENT_CONFIRM = 'confirm';
export const REVISION_INTENTS = [ REVISION_INTENT_CHANGE, REVISION_INTENT_CONFIRM ];

/**
 * Coerce a declared intent.
 *
 * Anything missing, empty, or unrecognized means `change` — the branch that
 * wakes. A malformed request must never be able to suppress a real correction
 * by failing to say what it meant.
 */
export function normalizeRevisionIntent(value) {
  let intent = normalizeOptionalString(value).toLowerCase();
  return REVISION_INTENTS.includes(intent) ? intent : REVISION_INTENT_CHANGE;
}

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

// --- Wake suppression ------------------------------------------------------

/**
 * Marker recorded in place of a real answer when the user dismisses a question
 * instead of answering it.
 *
 * A dismissal is deliberately NOT a `dismissed` status. `dismissed` means the
 * ASKING agent withdrew its own question (`questionsStore.dismissQuestion`);
 * this is the opposite direction: the user declined to answer. Recording it as
 * a normal answered question keeps the whole existing pipeline — history, the
 * answered-question frame, the activity counts — working unchanged, and lets the
 * asking agent look the outcome up later with `ask_user`/the questions API.
 *
 * The literal is served from here rather than written by the client so the
 * stored text can never drift from what the wake-suppression logic expects.
 */
export const NO_RESPONSE_ANSWER_TEXT = '<User chose not to respond>';

/**
 * True when an answer was recorded with wake suppression — stored, but never
 * allowed to start a turn for the asking agent.
 */
export function isWakeSuppressed(question) {
  return question?.wakeSuppressed === true;
}

/**
 * Coerce the `silent` request flag. Only a literal `true` suppresses the wake:
 * a stray string from a hand-written request must not be able to make an answer
 * silently invisible to the agent that is waiting for it.
 */
export function normalizeWakeSuppressed(value) {
  return value === true;
}
