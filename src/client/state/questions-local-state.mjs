'use strict';

// Local mutations to the questions model, applied the instant a user action
// succeeds rather than when the server's runtime event eventually arrives.
//
// Why this exists at all: the Inbox used to wait for a `question.answered`
// event (or the next fetch) before removing a row. That made answering feel
// broken — the row stayed, the badge stayed, and the user could not tell
// whether anything had happened. Worse, a `fetchQuestions` already in flight
// when the answer POST resolved could return a pre-answer payload and put the
// row straight back as open.
//
// The rule these helpers enforce: a question that has reached a terminal
// status stays closed. `questions-state.mjs` owns the closed-id set; this
// module is the only thing that writes to it in response to a local action.

import {
  forgetClosedQuestionID,
  openQuestionCount,
  restoreQuestion,
  settleQuestion,
  normalizeQuestionList,
  rememberClosedQuestionID,
  USER_ANSWER_SOURCE,
} from './questions-state.mjs';

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function questionIDOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Drop a question this tab just answered and remember it as closed.
 *
 * Called the moment the answer POST resolves — before any server event arrives
 * — so the row disappears immediately, the count is correct without a refetch,
 * and a fetch that was already in flight cannot put it back.
 */
export function applyLocalAnswer(state, questionID, options = {}) {
  if (!state || typeof state !== 'object')
    return state;

  let id = questionIDOrNull(questionID);
  if (!id)
    return state;

  rememberClosedQuestionID(state, id);
  // Kept, not deleted: the row stays on screen as a receipt and its close
  // control runs a countdown. `openQuestionCount` ignores terminal rows, so the
  // badge and header count drop immediately either way.
  //
  // `closedAt` is caller-supplied when it needs to be: the deadline doubles as
  // the token a rollback uses to prove it is reverting the settlement it created
  // and not one written by a server event since.
  state.questions = settleQuestion(state.questions || [], id, {
    status: 'answered',
    answer: options.answer,
    // This row was settled by a person typing into the answer box, so the
    // provenance is 'user' and the receipt can say so. Leaving it unset let the
    // row inherit the open question's `null` and the answer showed unlabelled.
    answerSource: USER_ANSWER_SOURCE,
    closedAt: numberOr(options.closedAt, 0) || Date.now(),
    settleAfter: numberOr(options.settleAfter, 0),
  });
  state.counts = { ...(state.counts || {}), open: openQuestionCount(state.questions) };

  let answeredAt = numberOr(options.answeredAt, 0);
  if (answeredAt > 0)
    state.lastAnsweredAt = answeredAt;

  return state;
}

/** Drop a question this tab just dismissed and remember it as closed. */
export function applyLocalDismiss(state, questionID, options = {}) {
  if (!state || typeof state !== 'object')
    return state;

  let id = questionIDOrNull(questionID);
  if (!id)
    return state;

  rememberClosedQuestionID(state, id);
  state.questions = settleQuestion(state.questions || [], id, {
    status: 'dismissed',
    closedAt: numberOr(options.closedAt, 0) || Date.now(),
    settleAfter: numberOr(options.settleAfter, 0),
  });
  state.counts = { ...(state.counts || {}), open: openQuestionCount(state.questions) };

  return state;
}

/**
 * Record what a question looked like before this tab closed it.
 *
 * The close is applied to the model *before* the POST is sent, so the receipt
 * appears on the click rather than one round trip later. That is only safe if
 * the change is reversible, and this is what makes it so: everything needed to
 * put the row back is captured here, at the moment of the change, while it is
 * still true.
 *
 * Returns null when there is nothing to restore (no state, no id, or a row this
 * tab did not have) rather than a half-filled token.
 */
export function captureSettlementTarget(state, questionID, options = {}) {
  if (!state || typeof state !== 'object')
    return null;

  let id = questionIDOrNull(questionID);
  if (!id)
    return null;

  let current = normalizeQuestionList(state.questions || [])
    .find((question) => question.id === id);
  if (!current)
    return null;

  return {
    questionID: id,
    // The row may only be reopened if it is still in the state this close put it
    // in, so the token has to say what that state is.
    settlementStatus: options.status,
    // A row that was already terminal when the user acted is not ours to reopen.
    wasOpen: current.status === 'open',
  };
}

/**
 * Undo an optimistic close whose POST failed.
 *
 * `expectedClosedAt` is the deadline the optimistic settle wrote, and it is
 * REQUIRED: a rollback has to name the specific settlement it is undoing. With
 * no token there is nothing to prove, so this refuses rather than reopening
 * whatever terminal row happens to be there — an earlier version did the latter
 * and would happily resurrect a question that had been closed for hours.
 *
 * If the row's deadline or status has moved on, a newer fact about this question
 * arrived while the request was in flight and this rollback must not overwrite
 * it: a server `question.answered` event is more authoritative than a failed
 * write.
 *
 * Idempotent: reverting an already-forgotten id is a no-op, so a retry after a
 * rollback is safe.
 */
export function revertLocalSettlement(state, questionID, options = {}) {
  if (!state || typeof state !== 'object')
    return state;

  let id = questionIDOrNull(questionID);
  if (!id)
    return state;

  let expectedClosedAt = numberOr(options.expectedClosedAt, 0);
  if (expectedClosedAt <= 0)
    return state;

  let restored = restoreQuestion(state.questions || [], id, {
    expectedClosedAt,
    expectedStatus: options.expectedStatus,
  });

  // Nothing changed: the row was not there, was already open, or had been
  // re-settled since. Leave the model — and the closed-id record — alone.
  let before = normalizeQuestionList(state.questions || [])
    .find((question) => question.id === id);
  let after = restored.find((question) => question.id === id);
  let didRestore = after?.status === 'open' && before?.status !== 'open';

  if (!didRestore)
    return state;

  state.questions = restored;
  state.counts = { ...(state.counts || {}), open: openQuestionCount(restored) };
  if (options.keepClosed !== true)
    forgetClosedQuestionID(state, id);

  return state;
}

/**
 * Stamp `readAt` on a locally-known row after a successful `/read` POST.
 *
 * The sidebar badge counts *unread* rows, so without this the count only drops
 * after a refetch — which is why the badge used to sit at its old value even
 * after the question had been looked at. The stored server doc remains the
 * source of truth; this mirrors it locally, and the store now rewrites the open
 * index so a refetch agrees.
 */
export function applyLocalRead(state, questionID, options = {}) {
  if (!state || typeof state !== 'object')
    return state;

  let id = questionIDOrNull(questionID);
  if (!id)
    return state;

  let readAt = numberOr(options.readAt, Date.now());
  state.questions = normalizeQuestionList(state.questions || []).map((question) => (
    question.id === id ? { ...question, readAt } : question
  ));

  return state;
}
