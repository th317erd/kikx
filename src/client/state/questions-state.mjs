'use strict';

// Client-side model for ask-user questions (plan §6).
//
// Pure helpers only: no DOM, no fetch, no ReactiveState. The Inbox view, the
// inline question frame, and the sidebar badge all read question state through
// these functions, so the reconciliation rules live in exactly one place.
//
// Two facts drive the design:
//  1. `GET /api/v1/questions` returns *summaries* from the store's open index.
//     A summary is a subset of the question doc (id, groupID, index, status,
//     mode, sessionID, agentID, text, priority, askedAt, askedClock, readAt,
//     contextRefs). Anything else must not be assumed present.
//  2. Runtime events (`question.asked` / `question.answered` / `question.updated`)
//     are NOT replayed on reconnect (plan §6.6), so the Inbox must fetch on
//     load/connect and reconcile. Reconcile means: the fetched set is
//     authoritative for *existence*, while locally-known rows that the fetch has
//     not seen yet are dropped only if the fetch is complete (not paginated).

export const QUESTION_STATUSES = [ 'open', 'answered', 'dismissed', 'undeliverable' ];
export const QUESTION_TERMINAL_STATUSES = [ 'answered', 'dismissed', 'undeliverable' ];

export function isOpenQuestion(question) {
  return question?.status === 'open' && question?.deleted !== true;
}

export function isTerminalQuestion(question) {
  return QUESTION_TERMINAL_STATUSES.includes(question?.status);
}

// Answer provenance. Mirrors the server's `question-fields.mjs` constants; the
// client bundle does not import from `src/core`, so the literals are repeated.
export const DEFAULT_ANSWER_SOURCE = 'default';
export const USER_ANSWER_SOURCE = 'user';

/**
 * Is this question sitting on an answer that only a default supplied?
 *
 * The single gate for the "replace the default" affordance, mirroring the
 * server's identical check. Duplicating the rule is deliberate: the server
 * enforces it on write and the client honours it on render, and a client that
 * guessed more generously would paint a box that the server then refuses with
 * a 409 — the exact failure this UI exists to remove.
 *
 * Null provenance is NOT revisable. An answer whose origin was never recorded
 * cannot be shown to have come from a default, so it is treated as somebody
 * else's answer rather than being offered up for editing.
 */
export function isRevisableDefaultAnswer(question) {
  return question?.deleted !== true
    && question?.status === 'answered'
    && question?.answerSource === DEFAULT_ANSWER_SOURCE;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// A summary from the server, or a question document from a `Question` frame.
// Both shapes are normalized into the same model so a renderer never has to
// ask which source produced the row.
export function normalizeQuestionSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  // Two shapes reach this function. The open index and the list route carry
  // `id`; the `Question` frames written by ask-user-tool carry `questionID`.
  // Accepting only `id` made every inline frame resolve to null, so a question
  // that existed and was answerable rendered the "Question unavailable."
  // fallback — no text, no box, no Submit — inside the session that asked it.
  let id = stringOrNull(value.id) || stringOrNull(value.questionID);
  if (!id)
    return null;

  let text = typeof value.text === 'string' ? value.text : '';
  if (text.trim() === '')
    return null;

  let status = QUESTION_STATUSES.includes(value.status) ? value.status : 'open';

  return {
    id,
    groupID: stringOrNull(value.groupID),
    index: Number.isInteger(value.index) ? value.index : 1,
    status,
    mode: value.mode === 'continue' ? 'continue' : 'wait',
    sessionID: stringOrNull(value.sessionID),
    agentID: stringOrNull(value.agentID),
    text: text.trim(),
    // The answer was dropped entirely, so an answered row could not show what
    // was said and the inline frame fell back to the status word.
    answer: stringOrNull(value.answer),
    // Where the answer came from. 'default' means the agent's own fallback
    // fired because nobody replied; 'user' means a person did. Null is the
    // honest third state — an answer written before provenance existed — and is
    // deliberately NOT coerced to either, because guessing 'user' would offer
    // an editable box on someone else's answer.
    answerSource: stringOrNull(value.answerSource),
    // The default that a person later overrode. Kept beside the live answer so
    // the transcript can still show what the agent was originally told.
    supersededDefaultAnswer: stringOrNull(value.supersededDefaultAnswer),
    revisedAt: numberOr(value.revisedAt, 0),
    priority: value.priority === 'low' || value.priority === 'high' ? value.priority : 'normal',
    askedAt: numberOr(value.askedAt, 0),
    askedClock: stringOrNull(value.askedClock),
    readAt: value.readAt || null,
    contextRefs: normalizeContextRefs(value.contextRefs),
    deleted: value.deleted === true,
    // When this tab settled the row (answered or dismissed). Absent for a
    // terminal question learned about from the server, which never gets a
    // retention window — only an action the user JUST took deserves a receipt.
    closedAt: numberOr(value.closedAt, 0),
    // How long this row lingers after closing. 0 means "no receipt".
    settleAfter: numberOr(value.settleAfter, 0),
  };
}

// References use the same `{ type, id }` contract the tool layer enforces
// (`normalizeToolReferences` drops refs without a non-empty type and id), plus
// optional display fields the Inbox may use as a label.
export function normalizeContextRefs(refs) {
  if (!Array.isArray(refs))
    return [];

  let normalized = [];
  for (let ref of refs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref))
      continue;

    let type = stringOrNull(ref.type);
    let id = stringOrNull(ref.id);
    if (!type || !id)
      continue;

    normalized.push({
      type,
      id,
      label: stringOrNull(ref.label),
      sessionID: stringOrNull(ref.sessionID),
      frameID: stringOrNull(ref.frameID),
      path: stringOrNull(ref.path),
    });
  }

  return normalized;
}

export function normalizeQuestionList(values) {
  if (!Array.isArray(values))
    return [];

  let byID = new Map();
  for (let value of values) {
    let question = normalizeQuestionSummary(value);
    // The open index is authoritative and sorted oldest-first by `askedAt`;
    // a later duplicate in the same payload should not resurrect a closed row.
    if (question && !byID.has(question.id))
      byID.set(question.id, question);
  }

  return sortQuestions([ ...byID.values() ]);
}

// Oldest first (plan §6.2), tie-broken by id so ordering is stable across
// re-fetches — the index's own comparator uses the same rule.
export function sortQuestions(questions) {
  return [ ...questions ].sort((left, right) => {
    if (left.askedAt !== right.askedAt)
      return left.askedAt - right.askedAt;

    return left.id.localeCompare(right.id);
  });
}

/**
 * Merge a fresh server fetch into the currently-known rows.
 *
 * `complete` says whether the fetch returned the whole open set. The Inbox asks
 * for the default page, so a paginated fetch must NOT drop rows it did not see
 * — that would make questions vanish when more than one page is open. A
 * complete fetch is authoritative: unseen rows are gone (answered elsewhere).
 */
export function reconcileQuestions(existing = [], incoming = [], options = {}) {
  let { complete = true, exclude = null } = options;
  let fetched = normalizeQuestionList(incoming);

  // A fetch issued before a local answer can land after it and re-list the row
  // as open. `exclude` carries the ids this tab knows are closed, so existence
  // stays authoritative without resurrecting a question the user just answered.
  if (exclude && typeof exclude.has === 'function')
    fetched = fetched.filter((question) => !exclude.has(question.id));

  if (!complete) {
    let byID = new Map();
    for (let question of normalizeQuestionList(existing))
      byID.set(question.id, question);

    for (let question of fetched)
      byID.set(question.id, question);

    return sortQuestions([ ...byID.values() ]
      .filter((question) => !(exclude && typeof exclude.has === 'function' && exclude.has(question.id))));
  }

  return sortQuestions(fetched);
}

// Apply a single incremental update (a `question.*` runtime event).
export function upsertQuestion(questions = [], update) {
  let question = normalizeQuestionSummary(update);
  if (!question)
    return sortQuestions(normalizeQuestionList(questions));

  let byID = new Map();
  for (let existing of normalizeQuestionList(questions))
    byID.set(existing.id, existing);

  // A terminal status removes the row from the open set; the Inbox only lists
  // what is still awaiting an answer.
  if (question.status === 'open' && question.deleted !== true)
    byID.set(question.id, question);
  else
    byID.delete(question.id);

  return sortQuestions([ ...byID.values() ]);
}

/**
 * Keep a question the user just settled, marked terminal, so the Inbox can show
 * a receipt for a moment instead of the row vanishing.
 *
 * This replaces the old "delete the row immediately" behaviour. The row must
 * stay in the model to be rendered at all, so the settlement is expressed as
 * state (a terminal status plus a deadline) rather than absence. `retireQuestion`
 * is what finally removes it.
 */
export function settleQuestion(questions = [], questionID, options = {}) {
  let id = stringOrNull(questionID);
  if (!id)
    return sortQuestions(normalizeQuestionList(questions));

  let status = QUESTION_TERMINAL_STATUSES.includes(options.status) ? options.status : 'answered';
  let answer = stringOrNull(options.answer);
  let closedAt = numberOr(options.closedAt, Date.now());
  let settleAfter = numberOr(options.settleAfter, 0);

  // No window means no receipt: remove the row, exactly as closing used to.
  // Retention is opt-in by the caller that actually renders a receipt, so a
  // caller with nothing to show never leaves a terminal row in the model.
  if (settleAfter <= 0)
    return removeQuestion(questions, id);

  return sortQuestions(normalizeQuestionList(questions).map((question) => (
    question.id === id
      ? { ...question, status, answer: answer ?? question.answer, closedAt, settleAfter }
      : question
  )));
}

/**
 * Put a question back the way it was before this tab closed it.
 *
 * The reverse of `settleQuestion`, for a close that was shown to the user before
 * the server confirmed it and then rejected it. The row keeps its identity and
 * returns to `open` with no deadline, so the Inbox renders the answer form again
 * and the user can retry — the draft was never cleared, so the text they wrote is
 * still there.
 *
 * `expectedStatus` and `expectedClosedAt` guard against reverting a settlement
 * that is no longer the one being rolled back. If the row has been re-settled
 * since (a `question.answered` event arrived for it while the POST was in
 * flight), one or both will not match and this is a no-op. Two asynchronous
 * paths touching one row is precisely the situation, and the newer fact has to
 * win.
 */
export function restoreQuestion(questions = [], questionID, options = {}) {
  let id = stringOrNull(questionID);
  let rows = normalizeQuestionList(questions);
  if (!id)
    return sortQuestions(rows);

  let expectedClosedAt = numberOr(options.expectedClosedAt, 0);
  let expectedStatus = QUESTION_TERMINAL_STATUSES.includes(options.expectedStatus)
    ? options.expectedStatus
    : null;
  let restored = false;

  let next = rows.map((question) => {
    if (question.id !== id)
      return question;
    if (!isTerminalQuestion(question))
      return question;
    // Only undo the settlement we wrote: if the status has since become
    // something else, a newer authoritative fact (a server event) has arrived
    // and must win.
    if (expectedStatus && question.status !== expectedStatus)
      return question;
    if (expectedClosedAt > 0 && question.closedAt !== expectedClosedAt)
      return question;

    restored = true;
    // `answer`, `readAt` and everything else survive: only the settlement is
    // undone, so nothing the user can still see is lost.
    return { ...question, status: 'open', closedAt: 0, settleAfter: 0 };
  });

  return sortQuestions(restored ? next : rows);
}

/** Remove a settled row outright, once its receipt has run out. */
export function retireQuestion(questions = [], questionID) {
  return removeQuestion(questions, questionID);
}

/**
 * Settled rows whose receipt window has elapsed, oldest deadline first.
 *
 * Pulled out as a pure predicate so the expiry rule is testable without a
 * clock, a DOM or a timer: the caller passes `now`.
 */
export function expiredSettledQuestions(questions = [], now = Date.now()) {
  let expired = [];
  for (let question of normalizeQuestionList(questions)) {
    if (!isTerminalQuestion(question))
      continue;
    if (!question.closedAt || !question.settleAfter)
      continue;
    if (now >= question.closedAt + question.settleAfter)
      expired.push(question.id);
  }

  return expired;
}

/**
 * A row that is settled but still inside its receipt window.
 *
 * Such a row is terminal AND visible — the one state the old model could not
 * express, because closing a question deleted it outright. Retention is decided
 * by the data (a deadline), not by a timer held in the view, so a repaint can
 * never resurrect or lose a receipt.
 */
export function isSettledPendingRetirement(question) {
  return isTerminalQuestion(question)
    && numberOr(question?.closedAt, 0) > 0
    && numberOr(question?.settleAfter, 0) > 0;
}

/** Should this row appear in the Inbox at all? */
export function isVisibleInboxQuestion(question, now = Date.now()) {
  if (isOpenQuestion(question))
    return true;

  if (!isSettledPendingRetirement(question))
    return false;

  return now < question.closedAt + question.settleAfter;
}

export function removeQuestion(questions = [], questionID) {
  let id = stringOrNull(questionID);
  if (!id)
    return sortQuestions(normalizeQuestionList(questions));

  return sortQuestions(normalizeQuestionList(questions).filter((question) => question.id !== id));
}

/**
 * Group rows for display (plan §6.3). Questions asked together share a
 * `groupID` and are presented as one flow: "Waiting on you · N questions from
 * <agent>". Ungrouped questions are their own single-entry group. Group order
 * follows the oldest member so the inbox stays oldest-first.
 */
export function groupQuestions(questions = []) {
  let sorted = sortQuestions(normalizeQuestionList(questions));
  let byKey = new Map();

  for (let question of sorted) {
    let key = question.groupID || question.id;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        groupID: question.groupID,
        agentID: question.agentID,
        sessionID: question.sessionID,
        questions: [],
        oldestAskedAt: question.askedAt,
      };
      byKey.set(key, group);
    }

    group.questions.push(question);
    if (question.askedAt < group.oldestAskedAt)
      group.oldestAskedAt = question.askedAt;
  }

  return [ ...byKey.values() ]
    .sort((left, right) => (
      left.oldestAskedAt !== right.oldestAskedAt
        ? left.oldestAskedAt - right.oldestAskedAt
        : left.key.localeCompare(right.key)
    ))
    .map((group) => ({
      ...group,
      // Within a batch the asker's own ordering wins over timestamps.
      questions: group.questions.sort((left, right) => {
        if (left.index !== right.index)
          return left.index - right.index;

        return left.askedAt - right.askedAt;
      }),
    }));
}

export function groupHeading(group) {
  let count = group?.questions?.length || 0;
  if (count <= 1)
    return null;

  let agent = group.agentID ? ` from ${group.agentID}` : '';
  return `Waiting on you · ${count} questions${agent}`;
}

// Badge count: open questions the user has not read yet. An already-read row
// still lists in the Inbox; it just no longer pulls attention.
export function unreadQuestionCount(questions = []) {
  let count = 0;
  for (let question of normalizeQuestionList(questions)) {
    if (isOpenQuestion(question) && !question.readAt)
      count += 1;
  }

  return count;
}

export function openQuestionCount(questions = []) {
  let count = 0;
  for (let question of normalizeQuestionList(questions)) {
    if (isOpenQuestion(question))
      count += 1;
  }

  return count;
}

const AGE_BUCKETS = [
  { limitSeconds: 60, unit: 'second', divisor: 1 },
  { limitSeconds: 3600, unit: 'minute', divisor: 60 },
  { limitSeconds: 86400, unit: 'hour', divisor: 3600 },
  { limitSeconds: 604800, unit: 'day', divisor: 86400 },
  { limitSeconds: Infinity, unit: 'week', divisor: 604800 },
];

// Compact relative age for a row ("3m", "2h", "4d"). Returns null when the
// timestamp is missing or in the future, so callers can omit the label rather
// than print nonsense.
export function questionAge(askedAt, now = Date.now()) {
  if (typeof askedAt !== 'number' || !Number.isFinite(askedAt) || askedAt <= 0)
    return null;

  let seconds = (now - askedAt) / 1000;
  // Future timestamps are checked FIRST: clock skew between the server and the
  // browser can make askedAt slightly ahead of Date.now(), and reporting "now"
  // for a negative interval would silently paper over a bad clock.
  if (seconds < 0)
    return null;

  if (seconds < 5)
    return 'now';

  for (let bucket of AGE_BUCKETS) {
    if (seconds < bucket.limitSeconds) {
      let value = Math.floor(seconds / bucket.divisor);
      let suffix = bucket.unit === 'second' ? 's'
        : bucket.unit === 'minute' ? 'm'
          : bucket.unit === 'hour' ? 'h'
            : bucket.unit === 'day' ? 'd' : 'w';
      return `${value}${suffix}`;
    }
  }

  return null;
}

// Free-form answers only (plan §6.2 / [D-4]). A yes/no is not easier to click
// than to type, and nuance is the point, so the only validation is "not empty".
export function normalizeAnswerText(value) {
  if (typeof value !== 'string')
    return '';

  return value.trim();
}

export function canSubmitAnswer(value) {
  return normalizeAnswerText(value) !== '';
}

// The dismissal marker, mirrored from the server's `NO_RESPONSE_ANSWER_TEXT`
// (src/core/questions/question-fields.mjs). The server composes this text
// itself and ignores whatever the client sends when `silent` is set, so this
// copy is never what gets stored on a current server — it exists so a dismiss
// request still carries a VALID answer for a server whose route predates the
// `silent` flag. See `dismissQuestionAnswer` for why that matters.
//
// Kept as an identical literal on purpose, with a spec that imports both and
// asserts they match: if the server's wording ever changes, the drift fails a
// test instead of silently producing a stale request body.
export const NO_RESPONSE_ANSWER_TEXT = '<User chose not to respond>';

/**
 * Create the mutable slice the app keeps in its ReactiveState. Arrays are
 * replaced on every change (ReactiveState observes top-level assignment only,
 * never nested mutation), which is why every helper above returns a new array.
 */
// A question is terminal once answered or dismissed, so an id in this set can
// never legitimately become open again. The set is bounded only to stop a
// long-lived tab from growing without limit; eviction is oldest-first and a
// dropped id can at worst re-list a row that a later fetch will remove again.
export const MAX_CLOSED_QUESTION_IDS = 500;

export function createQuestionsState() {
  return {
    questions: [],
    counts: { open: 0 },
    loaded: false,
    loading: false,
    error: null,
    lastFetchedAt: null,
    // Ids this tab has seen reach a terminal status. Consulted by every merge
    // path so a stale fetch cannot resurrect a question the user just answered.
    closedQuestionIDs: new Set(),
  };
}

function closedIDSet(state) {
  if (!(state.closedQuestionIDs instanceof Set))
    state.closedQuestionIDs = new Set();

  return state.closedQuestionIDs;
}

export function rememberClosedQuestionID(state, questionID) {
  let id = stringOrNull(questionID);
  if (!id)
    return;

  let closed = closedIDSet(state);
  if (!closed.has(id))
    closed.add(id);

  while (closed.size > MAX_CLOSED_QUESTION_IDS) {
    let oldest = closed.values().next();
    if (oldest.done)
      break;

    closed.delete(oldest.value);
  }
}

/**
 * Stop treating a question id as closed.
 *
 * The inverse of `rememberClosedQuestionID`, and it exists for exactly one
 * reason: a close that was applied optimistically, before the server had
 * accepted it, must be undoable. Without this the rollback would be invisible —
 * `reconcileQuestions` filters on the closed-id set, so a row restored into
 * `state.questions` would still be dropped by the next fetch.
 *
 * Only call this when the close did NOT happen. Forgetting an id the server has
 * genuinely closed would let a later fetch resurrect the row as open.
 */
export function forgetClosedQuestionID(state, questionID) {
  let id = stringOrNull(questionID);
  if (!id)
    return;

  let closed = closedIDSet(state);
  closed.delete(id);
}

export function isQuestionClosedLocally(state, questionID) {
  let id = stringOrNull(questionID);
  return id ? closedIDSet(state).has(id) : false;
}

export function applyQuestionsFetch(state, payload, options = {}) {
  if (!state || typeof state !== 'object')
    return state;

  let questions = payload?.questions;
  let complete = options.complete !== false;

  state.questions = reconcileQuestions(state.questions || [], questions, {
    complete,
    exclude: closedIDSet(state),
  });
  state.counts = {
    ...(payload?.counts && typeof payload.counts === 'object' ? payload.counts : {}),
    open: openQuestionCount(state.questions),
  };
  state.loaded = true;
  state.loading = false;
  state.error = null;
  state.lastFetchedAt = options.now ?? Date.now();

  return state;
}

export function applyQuestionEvent(state, event) {
  if (!state || typeof state !== 'object' || !event)
    return state;

  let payload = event.payload && typeof event.payload === 'object' ? event.payload : event;
  let type = event.type || event.eventType || payload.type;

  if (type !== 'question.asked' && type !== 'question.answered' && type !== 'question.updated')
    return state;

  // The producer emits a BATCH under `questions: [...]` (one entry per question
  // — see ask-user-tool.mjs:147), while the answer/update events carry a single
  // `question`. Handling only the single shape meant a live ask populated
  // nothing and the Inbox stayed empty until the next fetch.
  let incoming = [];
  if (Array.isArray(payload.questions))
    incoming = payload.questions;
  else if (payload.question)
    incoming = [ payload.question ];
  else if (payload.id)
    incoming = [ payload ];

  if (incoming.length === 0)
    return state;

  let closed = closedIDSet(state);
  let questions = state.questions || [];
  for (let update of incoming) {
    // A terminal event for a row we already dropped is a no-op; an open event
    // for a row this tab saw close is ignored, because terminal is permanent.
    if (update && typeof update === 'object') {
      let id = stringOrNull(update.id);
      if (id && closed.has(id))
        continue;
    }

    questions = upsertQuestion(questions, update);
  }

  state.questions = questions;
  state.counts = { ...(state.counts || {}), open: openQuestionCount(state.questions) };
  return state;
}
