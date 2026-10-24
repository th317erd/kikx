'use strict';

// Pure question-document layer: the schema normalisers, the two summary shapes
// and the guards.
//
// Extracted from `questions-store.mjs`, which had grown to 911 lines against
// AGENTS.md's 800-line hard limit ("at this point refactoring is mandatory
// before adding more code"). Nothing here touches the database, the clock or
// the locks: every export is a pure function of its arguments, which is why the
// split is by responsibility and not by line count. The store imports these and
// keeps the I/O.
//
// The one thing worth knowing before editing: `normalizeQuestionDoc` and
// `normalizeQuestionList` are allow-lists. A field that is not named there does
// not survive a read-modify-write — it is silently dropped on the next write.
// That is how `defaultAnswer` was lost the first time it was added.

import {
  QUESTION_MODES,
  normalizeContextRefs,
  normalizeOptionalString,
  normalizePriority,
  normalizeQuestionText,
  normalizeTimeoutMs,
  normalizeWakeSuppressed,
} from './question-fields.mjs';

const MODES = QUESTION_MODES;
const TERMINAL_STATUSES = [ 'answered', 'dismissed', 'undeliverable' ];
const STATUSES = [ 'open', 'answered', 'dismissed', 'undeliverable' ];
const MAX_QUESTIONS_PER_CALL = 25;
export const QUESTIONS_INDEX_LOCK_KEY = 'questions:index:open';

export const QUESTION_MAX_PER_CALL = MAX_QUESTIONS_PER_CALL;
export const QUESTION_STATUSES = [ ...STATUSES ];
export const QUESTION_TERMINAL_STATUSES = [ ...TERMINAL_STATUSES ];

export function compareQuestions(left, right) {
  if (left.askedAt !== right.askedAt)
    return left.askedAt - right.askedAt;

  return left.id.localeCompare(right.id);
}

export function compareSummaries(left, right) {
  if (left.askedAt !== right.askedAt)
    return left.askedAt - right.askedAt;

  return left.id.localeCompare(right.id);
}

export function normalizeQuestionList(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError('ask-user requires at least one question');

  if (value.length > MAX_QUESTIONS_PER_CALL)
    throw new TypeError(`ask-user accepts at most ${MAX_QUESTIONS_PER_CALL} questions per call`);

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new TypeError(`questions[${index}] must be an object`);

    if (Object.hasOwn(entry, 'options'))
      throw new TypeError(`questions[${index}] must not carry options; answers are free-form`);

    // Field-by-field rather than spreading the entry: unknown input must not
    // reach the stored doc. Any new per-question field has to be listed here
    // or it is silently dropped — which is exactly how `defaultAnswer` failed
    // to persist the first time.
    return {
      text: normalizeQuestionText(entry.text),
      priority: normalizePriority(entry.priority),
      defaultAnswer: normalizeOptionalString(entry.defaultAnswer ?? entry.default_answer) || null,
      timeoutMs: normalizeTimeoutMs(entry.timeoutMs ?? entry.timeout_ms
        ?? (entry.timeoutSeconds != null || entry.timeout_seconds != null
          ? Number(entry.timeoutSeconds ?? entry.timeout_seconds) * 1000
          : null)),
      // The schema declares `contextRefs` INSIDE each question, so it is a
      // per-question field and must be normalised through this allow-list.
      // Dropping it here is what made the tool union every question's refs into
      // one batch-wide array: the store had no per-question channel to receive
      // them, so `createQuestions` wrote the same set onto every row.
      contextRefs: normalizeContextRefs(entry.contextRefs ?? entry.context_refs),
    };
  });
}

export function normalizeQuestionDoc(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  if (typeof value.id !== 'string' || value.id.trim() === '')
    return null;

  if (typeof value.text !== 'string' || value.text.trim() === '')
    return null;

  if (!STATUSES.includes(value.status))
    return null;

  return {
    id: value.id.trim(),
    groupID: normalizeOptionalString(value.groupID) || null,
    index: Number.isInteger(value.index) ? value.index : 1,
    status: value.status,
    mode: MODES.includes(value.mode) ? value.mode : 'wait',
    sessionID: normalizeOptionalString(value.sessionID) || null,
    agentID: normalizeOptionalString(value.agentID) || null,
    interactionID: normalizeOptionalString(value.interactionID) || null,
    frameID: normalizeOptionalString(value.frameID) || null,
    toolCallFrameID: normalizeOptionalString(value.toolCallFrameID) || null,
    toolOutputID: normalizeOptionalString(value.toolOutputID) || null,
    todoIDs: Array.isArray(value.todoIDs) ? value.todoIDs.map((id) => String(id)) : [],
    focusAtAsk: normalizeOptionalString(value.focusAtAsk) || null,
    contextRefs: normalizeContextRefs(value.contextRefs),
    text: value.text.trim(),
    priority: normalizePriority(value.priority),
    answer: typeof value.answer === 'string' ? value.answer : null,
    defaultAnswer: normalizeOptionalString(value.defaultAnswer) || null,
    defaultTimeoutMs: normalizeTimeoutMs(value.defaultTimeoutMs),
    defaultDueAt: value.defaultDueAt == null ? null : Number(value.defaultDueAt),
    answerSource: normalizeOptionalString(value.answerSource) || null,
    // Revision provenance: set only by `reviseAnswer`. They must round-trip or
    // the next read-modify-write on this doc would erase the record that a
    // person overrode a fired default.
    supersededDefaultAnswer: normalizeOptionalString(value.supersededDefaultAnswer) || null,
    supersededDefaultAt: value.supersededDefaultAt == null ? null : Number(value.supersededDefaultAt),
    revisedAt: value.revisedAt == null ? null : Number(value.revisedAt),
    wakeSuppressed: normalizeWakeSuppressed(value.wakeSuppressed),
    answeredAt: value.answeredAt || null,
    answeredClock: value.answeredClock || null,
    answeredByUserID: normalizeOptionalString(value.answeredByUserID) || null,
    answerFrameID: normalizeOptionalString(value.answerFrameID) || null,
    dismissalReason: normalizeOptionalString(value.dismissalReason) || null,
    deliveryAttempts: Number.isInteger(value.deliveryAttempts) ? value.deliveryAttempts : 0,
    deliveryLastReason: normalizeOptionalString(value.deliveryLastReason) || null,
    nextDeliveryAt: value.nextDeliveryAt == null ? null : Number(value.nextDeliveryAt),
    askedAt: value.askedAt || value.createdAt || 0,
    askedClock: value.askedClock || null,
    createdAt: value.createdAt || value.askedAt || 0,
    updatedAt: value.updatedAt || value.createdAt || 0,
    readAt: value.readAt || null,
    deleted: value.deleted === true,
  };
}

export function summarizeQuestion(question) {
  return {
    id: question.id,
    groupID: question.groupID,
    index: question.index,
    status: question.status,
    mode: question.mode,
    sessionID: question.sessionID,
    agentID: question.agentID,
    text: question.text,
    priority: question.priority,
    askedAt: question.askedAt,
    askedClock: question.askedClock,
    readAt: question.readAt,
    // The Inbox shows frame-of-reference context per row (plan §6.2) straight
    // from the open index, so the refs must ride along with the summary — the
    // alternative is an N+1 fetch of every question doc on inbox load.
    contextRefs: question.contextRefs,
    // The agent's own fallback and its deadline ride too: a reader that cannot
    // see `defaultDueAt` cannot tell the user their question will self-answer,
    // and the client has no other way to learn it (the inbox never fetches docs).
    defaultAnswer: question.defaultAnswer ?? null,
    defaultTimeoutMs: question.defaultTimeoutMs ?? null,
    defaultDueAt: question.defaultDueAt ?? null,
    // Provenance rides with the summary for the same reason: a reader that
    // cannot see `answerSource` cannot tell a fired default from a human
    // answer, which is exactly the distinction the revision path is built on.
    answerSource: question.answerSource ?? null,
    supersededDefaultAnswer: question.supersededDefaultAnswer ?? null,
  };
}

// `markUndeliverable` is the one recorded transition that legitimately lands
// on a terminal status: delivery is attempted *after* the answer is persisted,
// so by the time the wake is known to be unsendable the doc is already terminal
// 'answered'. Rejecting that (as assertOpen does) would turn a stored answer
// into a failed request — the exact loss this path exists to prevent.
export function assertCanMarkUndeliverable(question) {
  if (question.deleted)
    throw conflict(`Question ${question.id} was deleted; it cannot be marked undeliverable`);

  if (question.status === 'undeliverable')
    throw conflict(`Question ${question.id} is already undeliverable`);

  if (question.status === 'dismissed')
    throw conflict(`Question ${question.id} was dismissed; it cannot be marked undeliverable`);

  if (question.status !== 'open' && question.status !== 'answered')
    throw conflict(`Question ${question.id} is ${question.status}; it cannot be marked undeliverable`);
}

export function assertOpen(question, action) {
  if (question.deleted)
    throw conflict(`Question ${question.id} was deleted; it cannot be ${action}`);

  if (TERMINAL_STATUSES.includes(question.status))
    throw conflict(`Question ${question.id} is already ${question.status}; it cannot be ${action}`);
}

export function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

export function normalizeRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string')
    throw new TypeError('rootPath must be a non-empty string');

  return `/${rootPath.replace(/^\/+|\/+$/g, '')}`;
}

export function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

export function notFound(message) {
  let error = new Error(message);
  error.status = 404;
  return error;
}

export function conflict(message) {
  let error = new Error(message);
  error.status = 409;
  return error;
}
