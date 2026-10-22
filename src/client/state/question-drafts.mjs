'use strict';

// Typed-but-unsent answers, kept outside the DOM so a repaint cannot erase them.
//
// Why this is not just "the textarea's value": every question mutation used to
// call `_requestRender()`, and even after that was replaced with in-place
// reconciliation, an *unrelated* full rebuild (switching sessions, another
// runtime event, empty <-> non-empty shape change) re-creates every card. The
// DOM value dies with the node, so the text the user had queued vanished even
// though nothing had happened to that question.
//
// The invariant: a draft belongs to a question id, survives any number of
// repaints, and is dropped only when the question itself reaches a terminal
// status or arrives back from the server as no longer open. Answering question
// A must never touch question B's draft.
//
// The store is deliberately per-app (created lazily by whoever needs it) rather
// than module-global: two apps in one page, or two tests in one process, must
// not share drafts.

// A user can only have so many boxes on screen. The bound stops a long-lived
// tab from accumulating text for questions that were answered in another tab;
// eviction is oldest-first, so the box the user is typing in survives.
export const MAX_ANSWER_DRAFTS = 50;

export function createDraftStore() {
  return new Map();
}

/**
 * The app's draft store, created on first use.
 *
 * Lives here rather than in a component because *two* answer surfaces now read
 * it: the Inbox card and the inline `Question` frame. It was previously buried
 * in `kikx-inbox-view.mjs`, so the frame — the surface a user actually answers
 * in, in the transcript — could not reach it and silently lost every keystroke
 * on any re-render, which is what a socket reconnect triggers.
 *
 * Lazy rather than constructed in the app class so the store exists for any
 * `app`-shaped object the tests pass in, without those tests having to know the
 * field name.
 */
export function answerDraftStore(app) {
  if (!app || typeof app !== 'object')
    return createDraftStore();

  if (!(app._answerDrafts instanceof Map))
    app._answerDrafts = createDraftStore();

  return app._answerDrafts;
}

/**
 * Record what is currently typed in one box.
 *
 * Empty text is treated as "no draft" rather than a stored empty string: the
 * user clearing a box means they want it gone, and keeping an empty entry would
 * burn a slot of the bounded store forever.
 */
export function setAnswerDraft(store, questionID, text) {
  if (!(store instanceof Map))
    return;

  let id = typeof questionID === 'string' ? questionID.trim() : '';
  if (!id)
    return;

  if (typeof text !== 'string' || text === '') {
    store.delete(id);
    return;
  }

  // Re-inserting moves the id to the end, so eviction order follows "least
  // recently typed" instead of "first ever typed".
  store.delete(id);
  store.set(id, text);

  while (store.size > MAX_ANSWER_DRAFTS) {
    let oldest = store.keys().next();
    if (oldest.done)
      break;

    store.delete(oldest.value);
  }
}

export function getAnswerDraft(store, questionID) {
  if (!(store instanceof Map))
    return '';

  let id = typeof questionID === 'string' ? questionID.trim() : '';
  if (!id)
    return '';

  return store.get(id) || '';
}

/** Drop one draft — the question closed, so there is nothing left to send. */
export function clearAnswerDraft(store, questionID) {
  if (!(store instanceof Map))
    return;

  let id = typeof questionID === 'string' ? questionID.trim() : '';
  if (id)
    store.delete(id);
}

/**
 * Drop drafts for ids the model no longer lists as open.
 *
 * Called after a fetch reconciles the open set, so a question answered in
 * another tab does not leave dead text behind. Drafts for still-open questions
 * are untouched — that is the whole point of the store.
 *
 * `complete` is load-bearing and not a hint. When the response is truncated by
 * the page limit, the ids the client did not receive are not "gone" — they are
 * unobserved, and an open question page 2 would list one of them. Pruning on a
 * truncated page deleted the text a user was in the middle of typing, on a
 * reconnect, for a question that had simply fallen off the page. Only prune
 * against a set the server has actually enumerated in full.
 */
export function pruneAnswerDrafts(store, openQuestionIDs, options = {}) {
  if (!(store instanceof Map) || !openQuestionIDs)
    return;

  if (options.complete === false)
    return;

  let open = openQuestionIDs instanceof Set ? openQuestionIDs : new Set(openQuestionIDs);
  for (let id of [ ...store.keys() ]) {
    if (!open.has(id))
      store.delete(id);
  }
}
