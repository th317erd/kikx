'use strict';

import {
  getCurrentEntry,
  getCurrentSessionID,
  getGridParentSessionID,
  getSessions,
  getStackDepth,
  getVisibleSessions,
  isCollapsed,
  navigateBack,
  navigateThread,
  setNavigationStack,
  upsertSession,
} from '../state/kikx-state.mjs';
import { isViewEntry, stackFromSearchParams, stackToURL } from '../state/navigation-stack.mjs';
import {
  DELETED_ROW,
  allFilters,
  stateHasFilters,
  frameFiltersSignature,
  normalizeFrameFilters,
  toggleFilter,
} from '../lib/frame-filters.mjs';
import {
  HERO_VIEW_TRANSITION_NAME,
  runViewTransition,
  setViewTransitionName,
} from './view-transition.mjs';
import { messageHashAtBottom, messageHashID } from './kikx-frame-scroll-lock.mjs';
import { isScrollLockedForSession } from './kikx-scroll-lock.mjs';

// ---------------------------------------------------------------------------
// Inline session rename: shared field contract + the exits the owner could not
// find (owner item 2, 2026-10-27). Measured at HEAD 4b4f902.
//
// THE TRAP THIS CLOSES. Three builders render the rename field in three homes:
// kikx-topbar.mjs:122-136 (the crumb in the merged bar, the one the pencil
// opens), kikx-shell-builders.mjs:216-226 and kikx-shell-builders.mjs:420-430.
// Two of them named the input `session-name`; the crumb's named it
// `crumb-name` (kikx-topbar.mjs:128). The old lookup asked for `session-name`,
// which never matched on the bar that actually renders, so:
//   * the field was never focused  -> focusout never fired -> blur-exit dead;
//   * the field's own Escape handler never got a keydown  -> Esc dead;
//   * nothing else ever cleared `editingSessionNameID`, so every re-render
//     re-entered edit mode -> the owner's "there is NO WAY to leave edit mode".
//
// Four independent exits now exist, and none depends on the field keeping
// focus:
//   1. ONE shared input name/selector (below) that all three builders use, so
//      focus() really lands on the field;
//   2. a document-level Escape handler, armed while an edit is open;
//   3. cancel-on-navigation: a `navigationStack` subscription (every navigate*
//      helper REPLACES the array, so a top-level assignment notifies) plus a
//      structural sweep on each shell render, which also covers builders that
//      write the stack directly and never call back into this module;
//   4. a visible Cancel (x) control beside the field (kikx-topbar.mjs), so the
//      owner never has to know a key to escape.
// ---------------------------------------------------------------------------
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
export function toggleShowDeleted(app) {
  setFrameFilters(app, toggleFilter(normalizeFrameFilters(app._state.frameFilters), DELETED_ROW.key));
}

// Replace the frame filter set and repaint the shell.
//
// Filtering is a server-side operation, so a filter change has to REFETCH the
// window: the frames the new selection admits are not in the client's loaded
// page, and no amount of local re-rendering can produce them. `_render()` alone
// would only repaint the frames the previous selection fetched, which is the
// bug this rewiring exists to avoid.
//
// The signature guard keeps an off/on round trip from doing nothing twice, and
// stops a redundant refetch when a click cannot have changed anything (for
// example Ctrl+Click on an already-isolated row).
export function setFrameFilters(app, filters) {
  let next = normalizeFrameFilters(filters);
  // The signature must include the query, and must be compared against the
  // last *applied* signature rather than against itself. Comparing
  // `(next, query)` with `(current, query)` used the same query on both sides,
  // so a query change alone was invisible here and the thread never refetched.
  cancelPendingWindowQuery(app);

  let query = app._state.sessionSearch || '';
  let signature = frameFiltersSignature(next, query);
  if (app._frameLoadSignature === signature)
    return;

  app._frameLoadSignature = signature;
  app._state.frameFilters = next;
  // Apply the new selection to the mounted page source immediately. The
  // server window scan can take seconds on a large session; leaving the old
  // unfiltered page on screen until it returns is what made a filter click look
  // like a no-op. The server result replaces this provisional page view.
  app._syncFrameThread?.(app._state.selectedSessionID, { force: true });

  // The Deleted row also governs the session grid's soft-deleted bucket. These
  // two used to be separate controls (a frame filter here, an eye in the search
  // box there), which let the thread and the grid disagree about what "deleted"
  // meant. They are one flag now. Turning it on fetches the bucket
  // (includeDeleted=1) so previously-deleted sessions actually exist to show.
  let showDeleted = next[DELETED_ROW.key] === true;
  let wasShowingDeleted = app._state.showDeletedSessions === true;
  app._state.showDeletedSessions = showDeleted;
  if (showDeleted && !wasShowingDeleted)
    app._loadDeletedSessions?.();

  reloadVisibleWindow(app);
}

// Typing produces one input event per keystroke, and each one that survives the
// signature guard costs a full server scan of the session -- the live one is
// 18k frames and takes ~5 s. A person typing "deploy" fired six scans, queued
// six requests, and the answers could land out of order. Collapse a burst into
// a single scan once the typist pauses. Popup row clicks stay immediate: a
// click is one deliberate action and should not wait on a timer.
const QUERY_DEBOUNCE_MS = 250;

function cancelPendingWindowQuery(app) {
  if (!app._queryDebounceTimer)
    return;
  clearTimeout(app._queryDebounceTimer);
  app._queryDebounceTimer = 0;
}

function scheduleWindowQuery(app, run) {
  cancelPendingWindowQuery(app);
  // A zero delay runs inline so the behaviour is exercisable without timers.
  let delay = typeof app._queryDebounceMs === 'number' ? app._queryDebounceMs : QUERY_DEBOUNCE_MS;
  if (delay <= 0) {
    run();
    return;
  }

  app._queryDebounceTimer = setTimeout(() => {
    app._queryDebounceTimer = 0;
    run();
  }, delay);
}

// Reload the selected session's window under the current selection, then
// repaint. The frame cache must be dropped first: it holds frames chosen by the
// old filter, and merging a filtered window into them would mix two selections.
//
// Shared by the popup's rows and the header search box, because both are the
// same concern: the server does the filtering, so any change to what is visible
// has to come back over the wire.
function reloadVisibleWindow(app) {
  let sessionID = app._state.selectedSessionID;
  if (sessionID && typeof app._loadFrames === 'function') {
    // Keep the existing thread mounted while the filtered window is fetched.
    // A full _render() rebuilds the header search input and destroys its
    // selection, which is what stole the caret on every debounced query.
    app._loadFrames(sessionID, { render: false }).then(
      () => {
        if (app._state.selectedSessionID === sessionID)
          app._syncFrameThread?.(sessionID, { force: true });
      },
      () => {
        if (app._state.selectedSessionID === sessionID)
          app._syncFrameThread?.(sessionID, { force: true });
      },
    );
    return;
  }

  app._render();
}

// The clear button is built into the header, but the grid-only repaint path
// below never rebuilds the header, so its visibility has to be nudged by hand
// or it would keep advertising a stale state while the user types.
function paintSearchClear(app) {
  let clear = app.querySelector?.('.kikx-session-search__clear');
  if (clear)
    clear.hidden = !stateHasFilters(app._state);
}

// Clear every filter at once: the header search text and every popup row,
// including the Deleted reveal. This is the single "show me everything"
// gesture, so it is deliberately blunt — it takes no arguments and leaves
// nothing switched off.
export function clearFrameFilters(app) {
  let next = allFilters(normalizeFrameFilters(app._state.frameFilters), true);
  next[DELETED_ROW.key] = false;
  app._state.sessionSearch = '';
  setFrameFilters(app, next);
}

// The header search is one box with two meanings, decided by where the user is:
//
//   * On the grid there is no thread window, so it stays the cheap live title
//     filter and repaints only the grid -- typing must not rebuild the shell or
//     the field loses its caret.
//   * Inside a session there is no grid to filter, so it becomes a frame query.
//     That has to go to the server: the client holds one bounded page, so a
//     local predicate would report "no matches" while matches sat unread.
//     Before this, typing inside a session did nothing at all.
export function applyWindowQuery(app, value) {
  let query = typeof value === 'string' ? value : '';
  app._state.sessionSearch = query;

  if (!app._state.selectedSessionID) {
    cancelPendingWindowQuery(app);
    if (!app._syncSessionShell())
      app._requestRender();
    paintSearchClear(app);
    return;
  }

  let signature = frameFiltersSignature(normalizeFrameFilters(app._state.frameFilters), query);
  if (app._frameLoadSignature === signature) {
    cancelPendingWindowQuery(app);
    return;
  }

  scheduleWindowQuery(app, () => {
    // Recompute at fire time: later keystrokes may have moved the target, and
    // the signature is only committed when a fetch actually starts so the
    // in-flight dedupe above stays truthful.
    let pending = frameFiltersSignature(
      normalizeFrameFilters(app._state.frameFilters),
      app._state.sessionSearch || '',
    );
    if (app._frameLoadSignature === pending)
      return;

    app._frameLoadSignature = pending;
    reloadVisibleWindow(app);
  });
}

export function onSessionSearchInput(app, value) {
  applyWindowQuery(app, value);
}

// Minimize the current session (pop the stack). Only valid past the root.
export function minimizeCurrent(app) {
  if (getStackDepth(app._state) <= 1)
    return;

  // The session we are leaving; its card in the destination grid is the hero.
  let leavingSessionID = getGridParentSessionID(app._state);
  setHeroName(app, threadChatViewElement(app));

  runViewTransition(() => {
    navigateBack(app._state);
    syncSelectedSessionToStack(app);
    syncURLFromStack(app, { push: true });
    app._render();
    let grid = app.querySelector('kikx-session-grid');
    setHeroName(app, grid?.cardViewElement(leavingSessionID));
  }).finally(() => {
    clearHeroNames(app);
    app._loadSessionPreviews?.().catch?.(() => null);
    app._loadQuestions?.({ complete: true });
  });
}

// Keep state.selectedSessionID aligned with the current stack entry so frames
// and titles reflect the active window.
export function syncSelectedSessionToStack(app) {
  let sessionID = getCurrentSessionID(app._state);
  app._state.selectedSessionID = sessionID || '';
}

// Drop sessions that no longer exist (soft delete) from the window stack and
// re-sync the address bar, truncating at the first missing link the way
// stackFromCurrentURL does on load. Keeps the thread from pointing at a deleted
// session after the grid removes it.
export function pruneMissingSessionsFromStack(app, { push = false } = {}) {
  let stack = app._state.navigationStack || [];
  // Visible = live, plus soft-deleted while the eye is on; a card the user can
  // still see must not be pruned from the stack.
  let known = new Set(getVisibleSessions(app._state).map((session) => session.id));
  let pruned = [ stack[0] || { sessionID: null, collapsed: true } ];
  for (let entry of stack.slice(1)) {
    if (!known.has(entry.sessionID))
      break;

    pruned.push(entry);
  }

  setNavigationStack(pruned, app._state);
  syncSelectedSessionToStack(app);
  syncURLFromStack(app, { push });
}

export function navigateToDepth(app, depth) {
  if (!Number.isInteger(depth) || depth < 1)
    return;

  let stack = app._state.navigationStack || [];
  if (depth >= stack.length)
    return;

  app._state.navigationStack = stack.slice(0, depth);
  syncSelectedSessionToStack(app);
  syncURLFromStack(app, { push: true });
  app._render();
}

export async function openSessionFromCard(app, sessionID) {
  if (!sessionID)
    return;

  // "Before" snapshot: only the source card's chat view carries the hero name.
  let grid = app.querySelector('kikx-session-grid');
  setHeroName(app, grid?.cardViewElement(sessionID));

  // Enter the session (push a thread window) and start the morph immediately;
  // load frames after, so the transition never waits on the network.
  await runViewTransition(() => {
    app._state.selectedSessionID = sessionID;
    app._state.status = 'Loading session...';
    app._state.statusKind = 'pending';
    app._forceScrollToBottomAfterRender = true;
    navigateThread(sessionID, app._state);
    syncURLFromStack(app, { push: true });
    app._render();
    setHeroName(app, threadChatViewElement(app));
  });

  clearHeroNames(app);

  try {
    await app._loadFrames(sessionID);
    app._state.status = 'Session loaded';
    app._state.statusKind = 'ready';
    app._render();
  } catch (error) {
    app._state.status = error.message;
    app._state.statusKind = 'error';
    app._render();
  }

  await app._loadSessionPreviews();
  await app._loadQuestions?.({ complete: true });
}

export function threadChatViewElement(app) {
  return app.querySelector('.kikx-thread__body kikx-chat-view');
}

export function setHeroName(app, element) {
  for (let view of app.querySelectorAll('kikx-chat-view'))
    setViewTransitionName(view, view === element ? HERO_VIEW_TRANSITION_NAME : '');
}

export function clearHeroNames(app) {
  for (let view of app.querySelectorAll('kikx-chat-view'))
    setViewTransitionName(view, '');
}

// Resolve the navigation stack from the current URL, dropping any session IDs
// that no longer exist and truncating at the first missing link so a stale URL
// cannot open a broken stack.
export function stackFromCurrentURL(app) {
  let parsed = stackFromSearchParams(globalThis.location?.search || '');
  let first = getSessions(app._state)[0]?.id;

  if (parsed.viewThread && first)
    return [ { sessionID: null, collapsed: true }, { sessionID: first, collapsed: false } ];

  let known = new Set(getSessions(app._state).map((session) => session.id));
  let stack = [ { sessionID: null, collapsed: true } ];
  for (let entry of parsed.stack.slice(1)) {
    // A view entry has no session by construction (`null`), so a membership test
    // against the session list rejects it and `break` truncates the whole tail.
    // That silently disabled every view deep link -- `?view=inbox` included, not
    // just plugin views -- because the parsed stack was discarded before it could
    // reach `setNavigationStack`. Addressability is the stack layer's job
    // (pushView refuses an unknown name); this loop only validates session links.
    if (!isViewEntry(entry) && !known.has(entry.sessionID))
      break;

    stack.push(entry);
  }

  return stack;
}

// Optional deep link on first load: ?session=<id> (or ?view=thread) opens a
// session thread directly, seeding the navigation stack.
async function loadSessionFramesForURL(app, sessionID) {
  let anchorID = messageHashID();
  let anchorBottom = messageHashAtBottom();
  let pinned = isScrollLockedForSession(app, sessionID);

  if (anchorID && !pinned && anchorBottom !== true) {
    try {
      // The caller owns the render; keep the anchor window flag alive until it runs.
      let anchored = await app._loadFramesAtMessage?.(sessionID, anchorID, { render: false });
      if (anchored?.frames?.length > 0 && anchored.hasMoreNewer !== false)
        return anchored;
    } catch (_error) {}
  }

  return await app._loadFrames(sessionID);
}

export async function applySessionDeepLink(app) {
  if (app._deepLinkApplied)
    return;

  app._deepLinkApplied = true;

  // Wait for the descriptor load before resolving the stack. `?view=<name>` is
  // validated against the live view registry, and a plugin view name only exists
  // there once its descriptor has arrived. Resolving first silently drops the view
  // and, because `_deepLinkApplied` has just latched, it is never retried -- so a
  // reload or a magic-link sign-in onto a plugin view URL showed the grid. Both
  // startup paths launch the descriptor fetch, so this usually costs nothing; when
  // it is genuinely in flight, waiting is the correct thing to do.
  try {
    await app._clientComponentsPromise;
  } catch (_error) {
    // A failed descriptor load must not take the whole deep link down with it:
    // the session part of the URL is still worth honouring.
  }

  let stack = stackFromCurrentURL(app);
  if (stack.length <= 1) {
    app._deepLinkReady = true;
    return;
  }

  setNavigationStack(stack, app._state);
  let top = getCurrentSessionID(app._state);
  app._state.selectedSessionID = top;
  app._forceScrollToBottomAfterRender = true;

  try {
    if (top)
      await loadSessionFramesForURL(app, top);
  } catch (_error) {} finally {
    app._deepLinkReady = true;
    app._loadQuestions?.({ complete: true });
  }
}

// Keep the address bar in sync with the window stack so a reload (or a shared
// link) restores the exact view. Uses replaceState: the stack has its own
// back/forward handled below, so we do not push a history entry per navigation
// unless the owner asked for true browser history.
export function syncURLFromStack(app, { push = false } = {}) {
  if (typeof globalThis.location === 'undefined' || typeof globalThis.history === 'undefined')
    return;

  let url = stackToURL(app._state.navigationStack || [], {
    origin: globalThis.location.origin,
    pathname: globalThis.location.pathname,
    search: globalThis.location.search,
  });

  if (url === globalThis.location.href)
    return;

  if (push)
    globalThis.history.pushState({ kikxStack: true }, '', url);
  else
    globalThis.history.replaceState({ kikxStack: true }, '', url);
}

// Apply the URL's stack (browser back/forward).
export async function syncFromURL(app) {
  let stack = stackFromCurrentURL(app);

  setNavigationStack(stack, app._state);
  let top = getCurrentSessionID(app._state);
  app._state.selectedSessionID = top || '';

  try {
    if (top && !isCollapsed(app._state))
      await loadSessionFramesForURL(app, top);
  } catch (_error) {}

  app._deepLinkReady = true;
  app._render();
  app._loadQuestions?.({ complete: true });
  if (isCollapsed(app._state))
    app._loadSessionPreviews?.().catch?.(() => null);
}
