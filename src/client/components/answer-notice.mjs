'use strict';

// Transient feedback for answering a question.
//
// Submitting an answer used to produce no visible change at all: the POST was
// silent, the row left the Inbox only once the server replied, and a failure
// looked exactly like success. The card's own busy state covers the round-trip,
// but the moment the answer is accepted its row is removed — so the one thing
// that can still tell the user "that worked" is a notice that outlives the row.
//
// Deliberately tiny and app-shaped rather than a component: it owns no state
// beyond a timer handle, and every caller gets the same element reused (two
// answers in quick succession update one notice instead of stacking two).

const NOTICE_CLASS = 'kikx-answer-notice';
const VISIBLE_CLASS = `${NOTICE_CLASS}--visible`;
const TONES = [ 'success', 'error' ];

// Long enough to read after the row has already gone, short enough not to
// linger over the next question.
const DEFAULT_AUTO_HIDE_MS = 4000;

function resolveDocument(app) {
  if (app && app.ownerDocument)
    return app.ownerDocument;

  return typeof document === 'undefined' ? null : document;
}

// The notice floats above the app so it stays visible whichever view is on
// screen and however far the list has been scrolled.
//
// It is deliberately NOT a child of the app element. Every rebuild runs
// `$(app).empty()` before appending the fresh tree (`kikx-shell-builders.mjs`),
// which destroys any notice parented there — the confirmation was removed by
// the very render it was meant to survive, so a successful send showed nothing.
// The notice is mounted next to the app instead, and looked up through the
// document so that a rebuild cannot orphan it.
function noticeFor(app, ownerDocument) {
  // Search the document first (where the notice lives in a real app, out of the
  // rebuild's reach) and fall back to the app itself. A bare app double with no
  // parent still mounts its notice in-app, and without this fallback each call
  // would fail to find the previous one and mount a second notice — two
  // confirmations stacked on top of each other.
  let existing = ownerDocument.querySelector?.(`.${NOTICE_CLASS}`)
    || app.querySelector?.(`.${NOTICE_CLASS}`);
  if (existing)
    return existing;

  let node = ownerDocument.createElement('div');
  node.className = NOTICE_CLASS;
  // Polite rather than assertive: a sent answer must not interrupt whatever a
  // screen reader is currently reading, but it does have to be announced.
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');

  let parent = (app.parentNode && typeof app.parentNode.appendChild === 'function')
    ? app.parentNode
    : (typeof app.appendChild === 'function' ? app : null);

  if (!parent)
    return null;

  parent.appendChild(node);

  return node;
}

/**
 * Show, or update, the answer notice.
 *
 * `tone` is 'success' or anything else treated as 'error'. Returns the notice
 * node, or null when there is nowhere to mount it (a bare app double in a spec,
 * or no document at all) — callers must not assume it exists.
 */
export function announceAnswerStatus(app, message, options = {}) {
  let ownerDocument = resolveDocument(app);
  if (!ownerDocument || !app)
    return null;

  let node = noticeFor(app, ownerDocument);
  if (!node)
    return null;

  let tone = options.tone === 'success' ? 'success' : 'error';
  for (let name of TONES)
    node.classList.remove(`${NOTICE_CLASS}--${name}`);

  node.classList.add(`${NOTICE_CLASS}--${tone}`);
  node.classList.add(VISIBLE_CLASS);
  node.textContent = message;

  clearTimeout(app._answerNoticeTimer);
  app._answerNoticeTimer = null;

  let autoHideMs = Number.isFinite(options.autoHideMs) ? options.autoHideMs : DEFAULT_AUTO_HIDE_MS;
  if (autoHideMs > 0) {
    app._answerNoticeTimer = setTimeout(() => dismissAnswerStatus(app), autoHideMs);
    // A pending timer must not keep a short-lived process (or a spec) alive.
    app._answerNoticeTimer?.unref?.();
  }

  return node;
}

/**
 * Hide the notice and forget any pending auto-hide.
 *
 * The element stays in the DOM so the next announcement reuses it; only its
 * text and visibility change.
 */
export function dismissAnswerStatus(app) {
  clearTimeout(app?._answerNoticeTimer);
  if (app)
    app._answerNoticeTimer = null;

  let node = app?.ownerDocument?.querySelector?.(`.${NOTICE_CLASS}`)
    || app?.querySelector?.(`.${NOTICE_CLASS}`);
  if (!node)
    return;

  node.classList.remove(VISIBLE_CLASS);
  node.textContent = '';
}

/**
 * Put a visible notice back after the app shell was rebuilt.
 *
 * `renderAppShell` empties the app element on every rebuild. The notice is
 * mounted beside the app rather than inside it, so a normal rebuild leaves it
 * alone — but a rebuild that also replaces the app's parent (a view swap) would
 * drop it. Re-attaching from the live node keeps the confirmation on screen for
 * the remainder of its auto-hide window instead of blinking out.
 */
export function reattachAnswerNotice(app) {
  let ownerDocument = resolveDocument(app);
  let node = ownerDocument?.querySelector?.(`.${NOTICE_CLASS}`);
  if (!node || !app?.parentNode)
    return null;

  if (node.parentNode === app.parentNode)
    return node;

  app.parentNode.appendChild(node);
  return node;
}

export const ANSWER_NOTICE_CLASS = NOTICE_CLASS;
