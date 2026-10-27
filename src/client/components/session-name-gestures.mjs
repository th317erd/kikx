'use strict';

// Entry gestures for the inline session rename (owner change of mind,
// 2026-10-27). Supersedes the hover pencil from item 2a:
//
//   "let's please instead have a double-click or long-press enter edit mode.
//    Blur, or Esc leaves edit mode."
//
// This module owns ONLY the entry half -- how an edit begins. The exits (Esc,
// blur, navigation, Cancel, Save) live in kikx-navigation.mjs, which is already
// 742 lines and AGENTS.md's hard cap is 800; a gesture that grew that file toward
// the cap would be the wrong trade. Keeping entry separate also means the exits
// keep working unchanged, which is what the existing rename specs pin.
//
// WHY A GESTURE NEEDS MORE CODE THAN THE BUTTON IT REPLACED. A button is a node:
// it can be found, focused, tabbed to and clicked, and a test proves it exists.
// A gesture has none of that. Three things have to be rebuilt by hand, and each
// one is a real defect if omitted:
//
//   1. DISCOVERABILITY. Nothing advertises that the title is now editable, so
//      the crumb carries a `title` (tooltip) and a rename hint on hover. Without
//      this the control is invisible to anyone who was not told.
//   2. KEYBOARD ACCESS. A span is not focusable and has no key events. The
//      gesture therefore adds `tabindex="0"` plus F2 (the platform rename key)
//      so deleting the pencil does not delete keyboard access with it.
//   3. DRAG AND SCROLL SAFETY. A long-press timer that fired on any
//      pointerdown-hold would rename the session every time the owner scrolled
//      with a finger resting on the title, or dragged a selection. So the timer
//      is cancelled by movement beyond a slop radius, by pointerup, by
//      pointercancel, and by the pointer leaving the element.

export const SESSION_NAME_LONG_PRESS_MS = 450;
export const SESSION_NAME_LONG_PRESS_SLOP_PX = 8;

// How long after a long-press opens the editor the following click is treated as
// part of the hold rather than as a separate intent. See the guard below.
export const SESSION_NAME_CLICK_SUPPRESS_MS = 400;

// One key on the node, holding the teardown for whatever was attached last.
// `buildTopbarCrumb` runs on EVERY render, and the framework is not a virtual
// DOM: a rebuild can hand us either a fresh node (nothing to clean) or, on a
// keyed update path, the SAME node again. Appending a second set of listeners to
// a retained node makes one double-click fire two renames, which then races and
// leaves an editor focused on a stale value. So attach is idempotent: it removes
// the previous set first.
const GESTURE_TEARDOWN = '__sessionNameGestureTeardown';

// The session the crumb currently names. Read at gesture time rather than
// captured, because a poll repaint can move the stack while a press is held.
function sessionStillOnStack(app, sessionID) {
  let stack = app?._state?.navigationStack || [];
  return stack.some((entry) => entry?.sessionID === sessionID);
}

// Begin the rename, but only for a session the owner is still looking at, and
// only once. Both guards are load-bearing:
//
//   * a 450ms hold outlives a frame-poll repaint, so the session may have been
//     navigated away from between press and threshold;
//   * `dblclick` can arrive after a long-press already started the edit on a
//     touch screen (some platforms synthesise it), and beginning an edit twice
//     re-seeds `editingSessionNameValue` from `crumb.label`, discarding anything
//     typed in between.
//
// Returns whether an edit actually began, which is what arms the click guard --
// arming it on a hold that did nothing would swallow a genuine navigation.
function requestRename(app, crumb) {
  let sessionID = crumb?.sessionID;
  if (!sessionID)
    return false;
  if (app?._state?.editingSessionNameID === sessionID)
    return false;
  if (!sessionStillOnStack(app, sessionID))
    return false;

  app._beginSessionNameEdit(sessionID, crumb.label);
  return true;
}

// THE CLICK A LONG-PRESS PRODUCES MUST NOT ALSO NAVIGATE.
//
// On the ACTIVE crumb the label is a span, so a trailing click does nothing. On
// an ANCESTOR crumb the label is a button whose click calls `navigateToDepth`,
// and the sequence is `pointerdown -> (450ms: rename begins) -> pointerup ->
// click`. That click would navigate away and tear down the editor the hold just
// opened, so the gesture would appear broken exactly where a user is most likely
// to try it.
//
// Two properties of the browser make the obvious fixes wrong:
//
//   * `event.stopPropagation()` on the crumb cannot work: the navigation handler
//     is attached by the element DSL at build time, BEFORE this module runs, and
//     same-node listeners fire in registration order.
//   * a capture-phase listener on `document` would win in a real browser but is
//     untestable here -- spec/client/support/mini-dom.mjs walks the node path
//     target-first and ignores the capture flag -- so the one behaviour that
//     matters would be unverifiable, which is worse than not shipping it.
//
// So the guard is explicit and the navigation path consults it:
// `consumeNavigationClickGuard(sessionID)` is called at the top of an ancestor
// crumb's click handler. It is KEYED BY SESSION on purpose: a hold on one crumb
// must never swallow a click on a different one, or pressing the active title
// could eat the next attempt to navigate up. And it is time-bounded rather than
// a sticky flag, because the click is not guaranteed to arrive at all (the
// pressed node may already be detached); a flag that never expired would eat the
// next genuine navigation instead.
const swallowNavigationClickUntil = new Map();

function armNavigationClickGuard(sessionID, now = Date.now()) {
  swallowNavigationClickUntil.set(sessionID, now + SESSION_NAME_CLICK_SUPPRESS_MS);
}

export function consumeNavigationClickGuard(sessionID, now = Date.now()) {
  let until = swallowNavigationClickUntil.get(sessionID);
  if (until === undefined)
    return false;

  // Reap on observation. An expired entry can never fire again (`Date.now()` is
  // monotonic), so keeping it would only leak one key per session the owner
  // happened to hold -- but leaving it also means a later reader cannot tell
  // "armed and expired" from "never armed", which is exactly the distinction
  // this guard exists to make.
  swallowNavigationClickUntil.delete(sessionID);
  return now <= until;
}

// Attach double-click + long-press + F2 to one crumb label. `crumb` is the model
// from buildCrumbModel (label, sessionID, depth, active); the handlers are
// closures over it, so the node never has to be re-queried to find out what it
// renames.
//
// Returns a teardown function. Callers do not need it -- re-attaching disposes
// the previous set -- but returning it keeps the resource balanced for a caller
// that does outlive the node.
export function attachSessionNameEntryGestures(app, node, crumb) {
  if (!node || typeof node.addEventListener !== 'function')
    return () => {};

  // Idempotent attach: dispose whatever a previous render put here.
  if (typeof node[GESTURE_TEARDOWN] === 'function')
    node[GESTURE_TEARDOWN]();

  let teardown = [];
  const on = (type, handler, options) => {
    node.addEventListener(type, handler, options);
    teardown.push(() => node.removeEventListener?.(type, handler, options));
  };

  // --- double-click ---------------------------------------------------------
  // `preventDefault` because a double-click on text also selects a word, and a
  // selection highlight under the freshly opened field looks like a glitch.
  //
  // ACTIVE CRUMB ONLY. A single click on an ancestor crumb already navigates and
  // the bar rebuilds, so there is no second click on a stable target to pair
  // with -- a "double-click" there has always just been two navigations.
  // Renaming an ancestor is still reachable by hold and by F2, both attached to
  // every session crumb, and the tooltip says so, so the restriction is not
  // silent.
  on('dblclick', (event) => {
    event.preventDefault?.();
    if (!crumb.active)
      return;
    requestRename(app, crumb);
  });

  // --- keyboard -------------------------------------------------------------
  // F2 is the desktop convention for "rename this". It is also the only entry
  // that a keyboard user can reach once the pencil is gone, so it ships with
  // tabindex="0" on the node (set by the builder, not here: this module does not
  // mutate the node's markup).
  on('keydown', (event) => {
    if (event.key !== 'F2')
      return;
    event.preventDefault?.();
    event.stopPropagation?.();
    requestRename(app, crumb);
  });

  // --- long-press -----------------------------------------------------------
  // Only the primary button, and only for a press that stays put. `button !== 0`
  // is the right-click/long-tap menu case, which must not rename.
  let timer = null;
  let lastX = 0;
  let lastY = 0;

  let cancel = () => {
    if (timer === null)
      return;
    clearTimeout(timer);
    timer = null;
  };

  on('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0)
      return;
    cancel();
    lastX = event.clientX ?? 0;
    lastY = event.clientY ?? 0;
    timer = setTimeout(() => {
      timer = null;
      if (requestRename(app, crumb))
        armNavigationClickGuard(crumb.sessionID);
    }, SESSION_NAME_LONG_PRESS_MS);
  });

  on('pointermove', (event) => {
    if (timer === null)
      return;
    let dx = (event.clientX ?? 0) - lastX;
    let dy = (event.clientY ?? 0) - lastY;
    if (Math.hypot(dx, dy) > SESSION_NAME_LONG_PRESS_SLOP_PX)
      cancel();
  });

  on('pointerup', cancel);
  on('pointercancel', cancel);
  on('pointerleave', cancel);

  let dispose = () => {
    cancel();
    for (let remove of teardown)
      remove();
    teardown = [];
    if (node[GESTURE_TEARDOWN] === dispose)
      delete node[GESTURE_TEARDOWN];
  };

  node[GESTURE_TEARDOWN] = dispose;
  return dispose;
}
