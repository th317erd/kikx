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
  openQuestionCount,
  removeQuestion,
  normalizeQuestionList,
  rememberClosedQuestionID,
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
  state.questions = removeQuestion(state.questions || [], id);
  state.counts = { ...(state.counts || {}), open: openQuestionCount(state.questions) };

  let answeredAt = numberOr(options.answeredAt, 0);
  if (answeredAt > 0)
    state.lastAnsweredAt = answeredAt;

  return state;
}

/** Drop a question this tab just dismissed and remember it as closed. */
export function applyLocalDismiss(state, questionID) {
  if (!state || typeof state !== 'object')
    return state;

  let id = questionIDOrNull(questionID);
  if (!id)
    return state;

  rememberClosedQuestionID(state, id);
  state.questions = removeQuestion(state.questions || [], id);
  state.counts = { ...(state.counts || {}), open: openQuestionCount(state.questions) };

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
