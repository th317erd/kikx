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
import { stackFromSearchParams, stackToURL } from '../state/navigation-stack.mjs';
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

export function beginSessionNameEdit(app, sessionID, currentTitle) {
  app._state.editingSessionNameID = sessionID;
  app._state.editingSessionNameValue = currentTitle || '';
  app._render();
  queueMicrotask(() => {
    let field = app.querySelector('input[name="session-name"]');
    field?.focus?.();
    field?.select?.();
  });
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
    app._state.framesBySessionID = { ...app._state.framesBySessionID, [sessionID]: [] };
    app._loadFrames(sessionID).then(
      () => app._render(),
      () => app._render(),
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
    if (!known.has(entry.sessionID))
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
