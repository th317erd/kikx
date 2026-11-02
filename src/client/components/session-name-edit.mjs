'use strict';

// Inline session rename contract and its focus/cancel guards. Kept separate
// from navigation so the navigation module stays under the source cap.

import { getSessions, upsertSession } from '../state/kikx-state.mjs';

export const SESSION_NAME_INPUT_NAME = 'session-name';
// Exactly the identity all three builders agree on. NOT a comma list of classes
// as well: the three homes use different classes (`kikx-breadcrumb__title-input`
// in the bar and buildBreadcrumbTitle, `kikx-window__title-input` in
// buildEditableTitle) but now share ONE name, so the name alone is complete --
// and a single-selector contract is one a jsdom-free spec can assert against.
export const SESSION_NAME_INPUT_SELECTOR = `input[name="${SESSION_NAME_INPUT_NAME}"]`;

export function beginSessionNameEdit(app, sessionID, currentTitle) {
  app._state.editingSessionNameID = sessionID;
  app._state.editingSessionNameValue = currentTitle || '';
  // Remember WHERE the owner was standing when the edit began. Any stack change
  // afterwards is a navigation, and a navigation ends the edit.
  app.__sessionNameEditContext = navigationContextKey(app);
  installSessionNameEditGuards(app);
  app._render();
  focusSessionNameField(app);
}

// Identity of the navigation context: one string per stack entry, view entries
// included. Every navigate* helper in kikx-state.mjs REPLACES `navigationStack`
// with a new array, so a push, a pop and a view switch all change this string.
//
// Why a snapshot instead of a subscription: ReactiveState.on() is
// microtask-batched (`vendor/aeor-web-components/reactive-state.js:20-70`), so a
// listener fires AFTER the navigation's own `_render()` -- the first paint would
// show a rename box the owner has already navigated away from. This is compared
// synchronously at the top of every render instead, which is the same instant the
// nav state is known.
export function navigationContextKey(app) {
  let stack = app?._state?.navigationStack || [];
  return stack.map((entry) => `${entry?.sessionID || ''}|${entry?.view || ''}`).join('>');
}

// Focus + select the live rename field. Must run AFTER `_render()`, because the
// render replaces the input node; and in a microtask, because focusing a node
// that is not in the document yet is silently dropped.
export function focusSessionNameField(app) {
  queueMicrotask(() => {
    let field = app.querySelector?.(SESSION_NAME_INPUT_SELECTOR);
    if (!field || typeof field.focus !== 'function')
      return;

    let doc = app.ownerDocument || globalThis.document;
    if (doc && doc.activeElement === field)
      return;

    field.focus();
    field.select?.();
  });
}

// Cancel an open rename when the session it belongs to is no longer anywhere on
// the navigation stack. Called from the shell on every render: belt and braces
// for the subscription below, and the only net that catches a stack written
// directly by a view builder.
//
// Deliberately does NOT repaint: the caller is already inside a render, and the
// navigation paths repaint themselves. Clearing the state is what makes the
// next paint show the static crumb again.
export function syncSessionNameEdit(app) {
  let editing = app?._state?.editingSessionNameID;
  if (!editing)
    return;

  let moved = app.__sessionNameEditContext !== navigationContextKey(app);
  let stack = app._state.navigationStack || [];
  let gone = !stack.some((entry) => entry?.sessionID === editing);

  if (!moved && !gone)
    return;

  app._state.editingSessionNameID = '';
  app._state.editingSessionNameValue = '';
  delete app.__sessionNameEditContext;
}

// Same, without the stack test: used by navigation, where ANY context change
// ends the edit. Does not render -- the navigation path renders once, right
// after, and a second repaint inside a view transition would fight the hero
// morph. Idempotent.
export function clearSessionNameEditState(app) {
  if (!app?._state?.editingSessionNameID)
    return;

  app._state.editingSessionNameID = '';
  app._state.editingSessionNameValue = '';
}

// Global guards, installed once per app and armed by state rather than by
// focus. Each handler returns immediately when no edit is open, so they are
// inert for the rest of the app's life.
export function installSessionNameEditGuards(app) {
  if (app.__sessionNameEditGuards)
    return;

  let state = app?._state;
  if (!state)
    return;

  app.__sessionNameEditGuards = true;

  // Every listener goes through one helper with a matching remover, so cleanup
  // cannot drift out of step with installation. A host without a real document
  // (the jsdom-free spec DOM has no addEventListener) must not throw here: the
  // state hook below still installs, which is what a spec can observe.
  let removers = [];
  const listen = (target, type, handler, options) => {
    if (typeof target?.addEventListener !== 'function')
      return;

    target.addEventListener(type, handler, options);
    removers.push(() => target?.removeEventListener?.(type, handler, options));
  };

  let doc = globalThis.document;

  // 1. Escape, document level, CAPTURE phase: the field's own onKeydown is only
  //    reachable while the field holds focus -- the exact assumption that
  //    failed. Capture also beats any inner handler that stops propagation.
  let onKeydown = (event) => {
    if (!state.editingSessionNameID || event.key !== 'Escape')
      return;

    event.preventDefault();
    event.stopPropagation();
    cancelSessionNameEdit(app);
  };

  listen(doc, 'keydown', onKeydown, true);

  // 2. REMOVED (owner 2026-10-27): "Blur, or Esc leaves edit mode."
  //
  //    There used to be a `focusin` guard here that re-focused the rename field
  //    whenever focus landed anywhere outside the editor. It was written to
  //    repair an earlier defect -- the field never received focus, so `focusout`
  //    never fired and blur-exit was dead -- and it did repair that. But it also
  //    made blur-exit IMPOSSIBLE by construction: clicking anywhere else moved
  //    focus out and this guard immediately put it back, so `focusout` could not
  //    complete and the editor could not be left by clicking away. That is the
  //    owner's original complaint ("Blurring the field won't do it") surviving
  //    underneath a fix that only ever addressed Esc.
  //
  //    With the field now genuinely focused by focusSessionNameField(), blur does
  //    not need re-focusing to work: a real click away produces a real focusout,
  //    which reaches commitSessionNameOnFocusout and exits. A repaint that
  //    replaces the node mid-edit is still covered, by focusSessionNameField()
  //    being called again from beginSessionNameEdit() and by the Escape guard
  //    below, which is armed by STATE and needs no focus at all.

  // 3. Backstop for a navigation that does not repaint on its own: the
  //    synchronous sweep at the top of renderAppShell is the primary path, but
  //    it only runs when a render happens. ReactiveState.on() is batched to a
  //    microtask, so this cannot fight the synchronous sweep -- by the time it
  //    runs, an ordinary navigation has already cleared the state and this is a
  //    no-op. It fires only when the state SURVIVED a stack change.
  let onStackChange = () => {
    if (!state.editingSessionNameID)
      return;

    clearSessionNameEditState(app);
    app._requestRender?.();
  };

  if (typeof state.on === 'function') {
    state.on('navigationStack', onStackChange);
    removers.push(() => state.off?.('navigationStack', onStackChange));
  }

  app.__sessionNameEditCleanup = () => {
    for (let remove of removers)
      remove();
    delete app.__sessionNameEditCleanup;
    delete app.__sessionNameEditGuards;
  };
}

export function onSessionNameKeydown(app, event, sessionID) {
  if (event.key === 'Enter') {
    event.preventDefault();
    app._commitSessionName(sessionID);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    app._cancelSessionNameEdit();
  }
}

export function cancelSessionNameEdit(app) {
  app._state.editingSessionNameID = '';
  app._state.editingSessionNameValue = '';
  app._render();
}

// The box that holds the field AND its Save/Cancel buttons. Focus moving
// anywhere inside it is a move to a sibling control, never a "clicked away".
export const SESSION_NAME_EDITOR_CLASS = 'kikx-breadcrumb__editor';
export const SESSION_NAME_EDITOR_SELECTOR = `.${SESSION_NAME_EDITOR_CLASS}`;

// Is `node` inside the editor? Walks `parentNode` + `classList` rather than
// calling `node.closest(selector)`.
//
// That is deliberate, and the reason is a measured one: the jsdom-free spec DOM
// (spec/client/support/mini-dom.mjs) implements `parentNode`, `classList` and
// `matches` but NOT `closest`. A `relatedTarget?.closest?.(...)` guard therefore
// evaluates to `undefined` there, silently takes the "not inside" branch, and
// commits -- the probe run against the real builder caught exactly that
// (`.gate/node-eng-item2-cancel-focusout.log`: commits=1, patches=1). A guard
// whose failure mode is "silently does the dangerous thing" is the wrong shape,
// and the parent walk is the same containment test the browser's `closest`
// performs anyway.
export function isInsideSessionNameEditor(node) {
  for (let current = node; current; current = current.parentNode || null) {
    if (current?.classList?.contains?.(SESSION_NAME_EDITOR_CLASS))
      return true;
  }
  return false;
}

// THE BUG THIS EXISTS TO CLOSE (owner-reported, 2026-10-27): the Cancel (x)
// control RENAMED the session instead of cancelling it.
//
// `focusout` fires on an input whenever focus leaves it -- including when focus
// moves to a sibling button that the user is about to click. The real pointer
// sequence is `mousedown` -> input blur -> `focusout` -> `click`, so the
// unconditional blur-commit ran BEFORE Cancel's own handler, cleared
// `editingSessionNameID` and PATCHed the half-typed name. Cancel's guard then
// saw no edit open and returned: a no-op, after the damage. Save suffered the
// same ordering (two PATCHes, the second a no-op, so it looked correct).
//
// Two independent halves, because one is not enough across browsers:
//
//   1. THIS GUARD. If the focus that just left the field landed on one of the
//      editor's own buttons, do not commit -- the button's click handler is the
//      commit/cancel decision. Covers Chrome/Edge/Firefox, which focus a button
//      on mousedown, and covers Tab moving between the field and the buttons.
//
//   2. `holdSessionNameFieldFocus` (mousedown preventDefault). Safari does NOT
//      focus a button on click, so `relatedTarget` is null there and half 1
//      cannot fire. Cancelling the default mousedown action means focus never
//      leaves the input at all, so no `focusout` is generated in any browser.
//
// Blur-to-commit for genuine click-away is preserved: a click anywhere else
// has a relatedTarget outside the editor (or the mousedown cancels nothing),
// so the commit runs exactly as before.
export function commitSessionNameOnFocusout(app, event, sessionID) {
  if (isInsideSessionNameEditor(event?.relatedTarget))
    return;

  app._commitSessionName(sessionID);
}

// Attach as `.onMousedown(...)` to the editor's own buttons. Keeping focus on
// the field is what makes the Cancel click an unambiguous "cancel" rather than
// a commit-then-cancel race.
export function holdSessionNameFieldFocus(event) {
  event?.preventDefault?.();
}

export async function commitSessionName(app, sessionID) {
  if (app._state.editingSessionNameID !== sessionID)
    return;

  let title = (app._state.editingSessionNameValue || '').trim();
  let session = getSessions(app._state).find((candidate) => candidate.id === sessionID);
  app._state.editingSessionNameID = '';
  app._state.editingSessionNameValue = '';

  if (!title || title === (session?.title || '')) {
    app._render();
    return;
  }

  try {
    let result = await app._patchJSON(`/api/v1/sessions/${encodeURIComponent(sessionID)}`, { title });
    upsertSession(result.data.session, app._state);
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
  }

  app._render();
}

// The popup's "Deleted" row is the single control for soft-deleted content of
// every kind, so this is now only a thin delegate onto it: it flips the filter
// row and lets setFrameFilters do the state write, the bucket fetch and the
// repaint. Keeping one path means the eye can never disagree with the row.
