'use strict';

import {
  getCurrentEntry,
  getCurrentSessionID,
  getGridParentSessionID,
  getSelectedFrames,
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
  applySessionViewScope,
  captureSessionViewScope,
  persistAppViewScope,
  persistAppViewScopeSoon,
} from '../state/session-view-filters.mjs';
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
export {
  SESSION_NAME_EDITOR_CLASS,
  SESSION_NAME_EDITOR_SELECTOR,
  SESSION_NAME_INPUT_NAME,
  SESSION_NAME_INPUT_SELECTOR,
  beginSessionNameEdit,
  cancelSessionNameEdit,
  clearSessionNameEditState,
  commitSessionName,
  commitSessionNameOnFocusout,
  focusSessionNameField,
  holdSessionNameFieldFocus,
  installSessionNameEditGuards,
  isInsideSessionNameEditor,
  navigationContextKey,
  onSessionNameKeydown,
  syncSessionNameEdit,
} from './session-name-edit.mjs';

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
export function setFrameFilters(app, filters, options = {}) {
  let next = normalizeFrameFilters(filters);
  // The signature must include the query, and must be compared against the
  // last *applied* signature rather than against itself. Comparing
  // `(next, query)` with `(current, query)` used the same query on both sides,
  // so a query change alone was invisible here and the thread never refetched.
  cancelPendingWindowQuery(app);

  let query = app._state.sessionSearch || '';
  let signature = frameFiltersSignature(next, query);
  if (app._frameLoadSignature === signature) {
    paintSearchClear(app);
    return;
  }

  app._frameLoadSignature = signature;
  app._state.frameFilters = next;
  // A view filter belongs to the session it was set on, so record it there
  // immediately. Clicks are deliberate and rare, so this does not need the
  // coalescing the query path uses.
  persistAppViewScope(app);
  paintSearchClear(app);
  // A filter change can originate outside the popup (the header clear button).
  // Repaint its checkboxes without rebuilding the shell or moving focus.
  app.querySelector?.('kikx-frame-filter-popup')?.refresh?.();
  // A paged thread re-scopes synchronously in reloadVisibleWindow(); doing it
  // here too would mount the same source twice. Non-paged threads keep the
  // provisional repaint while the server window is fetched.
  let paged = app.querySelector?.('kikx-chat-view')?.usesPagedScrollview === true;
  if (!paged)
    app._syncFrameThread?.(app._state.selectedSessionID, { force: true, preserveScroll: true });

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

  // Collapse rapid filter clicks just like a typing burst. The popup paints
  // immediately; the potentially expensive paged re-scope waits for the user
  // to settle on a filter set.
  if (paged)
    scheduleWindowQuery(app, () => reloadVisibleWindow(app, { pinBottom: options.pinBottom === true }));
  else
    reloadVisibleWindow(app, { pinBottom: options.pinBottom === true });
}

// Typing produces one input event per keystroke, and each one that survives the
// signature guard costs a full server scan of the session -- the live one is
// 18k frames and takes ~5 s. A person typing "deploy" fired six scans, queued
// six requests, and the answers could land out of order. Collapse a burst into
// a single scan once the typist pauses. Popup row clicks stay immediate: a
// click is one deliberate action and should not wait on a timer.
const QUERY_DEBOUNCE_MS = 1000;

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
function reloadVisibleWindow(app, options = {}) {
  let sessionID = app._state.selectedSessionID;
  // A whole-session page source already holds the raw pages and runs the same
  // predicate as the server. Re-scoping it is synchronous and local; asking
  // the server for a filtered window here hydrates every body in the session
  // (tens of thousands on a live thread) and freezes the browser while the
  // old, unfiltered page stays on screen. The page source is authoritative for
  // paged threads, so update its context and stop.
  let view = app.querySelector?.('kikx-chat-view');
  if (sessionID && view?.usesPagedScrollview === true) {
    let search = app.querySelector?.('.kikx-session-search input');
    let restoreSearch = search && document.activeElement === search
      ? { start: search.selectionStart, end: search.selectionEnd, direction: search.selectionDirection }
      : null;
    if (options.pinBottom === true)
      view.pinToLatestAfterContext?.();
    app._syncFrameThread?.(sessionID, { force: true, preserveScroll: true });
    // Re-scoping a page source normally leaves the header untouched, but a
    // mounted shell may repaint around the thread. Do not let a query change
    // cost the user the caret that is producing it.
    let nextSearch = app.querySelector?.('.kikx-session-search input');
    if (restoreSearch && nextSearch) {
      nextSearch.focus({ preventScroll: true });
      let max = nextSearch.value.length;
      nextSearch.setSelectionRange(
        Math.min(restoreSearch.start, max),
        Math.min(restoreSearch.end, max),
        restoreSearch.direction || 'none',
      );
    }
    return;
  }

  if (sessionID && typeof app._loadFrames === 'function') {
    // Keep the existing thread mounted while the filtered window is fetched.
    // A full _render() rebuilds the header search input and destroys its
    // selection, which is what stole the caret on every debounced query.
    let finish = () => {
      if (app._state.selectedSessionID !== sessionID)
        return;
      app._syncFrameThread?.(sessionID, { force: true, preserveScroll: true });
      if (options.pinBottom === true)
        app._scrollFramesToBottom?.();
    };
    app._loadFrames(sessionID, { render: false }).then(finish, finish);
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
  syncSessionSearchField(app, '');
  paintSearchClear(app);
  setFrameFilters(app, next, { pinBottom: true });
}

// Per-session view-filter scoping. See state/session-view-filters.mjs for why
// this is keyed by session at all: a filter describes how ONE session is being
// looked at, and a global one made a child session open empty whenever the
// parent had been isolated to "Child Sessions".
// Switch the live filter state to the session being entered.
//
// THIS MUST RUN SYNCHRONOUSLY AT THE TRANSITION, before anything fetches.
// Filtering happens on the server, and `loadFrames` reads `state.frameFilters`
// when it builds its request. A ReactiveState subscription would flush on a
// microtask -- after the caller has already awaited the load -- so the request
// would go out carrying the PREVIOUS session's filter. That is not a subtle
// risk; it is exactly the empty-thread bug this exists to fix.
//
export function syncViewScopeForSelection(app, previousSessionID) {
  if (!app?._state)
    return;

  // Save the session we are leaving under its own id, while its state is still
  // the live state. After the assignment below it is unrecoverable.
  let previous = typeof previousSessionID === 'string' ? previousSessionID : '';
  if (app._viewScopePersistTimer) {
    clearTimeout(app._viewScopePersistTimer);
    app._viewScopePersistTimer = 0;
  }
  captureSessionViewScope(app._state, previous);

  applySessionViewScope(app._state, app._state.selectedSessionID);

  // The Deleted gate is per-session now, so the grid's soft-deleted bucket has
  // to follow it. `showDeletedSessions` used to be driven only by setFrameFilters,
  // which meant a session saved with the gate on would render its hidden frames
  // while the grid still believed they were off -- and the eye would show the
  // wrong state on return. The bucket is fetched below by the caller that needs
  // it; this only keeps the two flags telling the same story.
  app._state.showDeletedSessions = app._state.frameFilters?.[DELETED_ROW.key] === true;

  // The signature guard caches "which filter+query produced the frames currently
  // on screen". A different session is a different request entirely, so a
  // signature retained from the session we left could suppress the first load
  // of the one we entered -- the same failure by another route.
  app._frameLoadSignature = null;

  syncSessionSearchField(app, app._state.sessionSearch || '');
  paintSearchClear(app);
  // The popup paints its checkboxes from state, so it must be told. Its refresh
  // is cheap and does not rebuild the shell, so focus is unaffected.
  app.querySelector?.('kikx-frame-filter-popup')?.refresh?.();
}

function syncSessionSearchField(app, value) {
  for (let input of app.querySelectorAll?.('.kikx-session-search input') || []) {
    if (input.value !== value)
      input.value = value;
  }
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
  paintSearchClear(app);
  persistAppViewScopeSoon(app);

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
  }).finally(async () => {
    clearHeroNames(app);
    app._loadSessionPreviews?.().catch?.(() => null);
    app._loadQuestions?.({ complete: true });
    // Owner (2026-11-12): reload lands ON the mode, so boot never loaded any
    // frames (the stack top was the view entry → getCurrentSessionID null →
    // loadSessionFramesForURL skipped) — popping back showed "No messages
    // yet" forever. Pre-reload flows only worked because the frames were
    // ALREADY in memory. The pop path hydrates the session it just revealed
    // whenever its frame list is empty — same loader as boot/deep-link.
    const backTo = getCurrentSessionID(app._state);
    if (backTo && getSelectedFrames(app._state).length === 0) {
      try {
        await loadSessionFramesForURL(app, backTo);
      } catch (_error) {
        // A failed frame fetch leaves the empty state readable; the next
        // navigation or event retries through its own path.
      }
    }
  });
}

// Keep state.selectedSessionID aligned with the current stack entry so frames
// and titles reflect the active window.
export function syncSelectedSessionToStack(app) {
  let previousSessionID = app._state.selectedSessionID || '';
  let sessionID = getCurrentSessionID(app._state);
  app._state.selectedSessionID = sessionID || '';
  syncViewScopeForSelection(app, previousSessionID);
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
    let previousSessionID = app._state.selectedSessionID || '';
    app._state.selectedSessionID = sessionID;
    // Before the transition paints and long before _loadFrames runs below, so
    // the request carries THIS session's filter and not the card grid's.
    syncViewScopeForSelection(app, previousSessionID);
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
  let previousSessionID = app._state.selectedSessionID || '';
  let top = getCurrentSessionID(app._state);
  app._state.selectedSessionID = top;
  syncViewScopeForSelection(app, previousSessionID);
  app._forceScrollToBottomAfterRender = true;

  try {
    if (top)
      await loadSessionFramesForURL(app, top);
  } catch (_error) {} finally {
    app._deepLinkReady = true;
    app._loadQuestions?.({ complete: true });
    // The flip above is invisible until a paint shows it: without this the
    // startup loading screen can persist FOREVER unless an unrelated event
    // happens to repaint (measured 2026-11-14: lean fixtures stranded on
    // "Loading page…" with the frame store already full — the event-rich
    // fixtures only got lucky). Ready and repaint are one step.
    if (typeof app._requestRender === 'function')
      app._requestRender('deeplink-ready');
    else if (typeof app._render === 'function')
      app._render();
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
    // Owner (2026-11-12): "the URL doesn't capture any navigation on System
    // Settings" — the live tab travels with the mode, written on EVERY sync
    // (gear, tab switch, back), so reload lands on the tab in view.
    section: app._state?.settingsSection,
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
  let previousSessionID = app._state.selectedSessionID || '';
  let top = getCurrentSessionID(app._state);
  app._state.selectedSessionID = top || '';
  syncViewScopeForSelection(app, previousSessionID);

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
