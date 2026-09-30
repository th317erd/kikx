'use strict';

import {
  getCurrentEntry,
  getCurrentSessionID,
  getGridParentSessionID,
  getSessions,
  getStackDepth,
  isCollapsed,
  navigateBack,
  navigateThread,
  setCollapsedView,
  setNavigationStack,
  upsertSession,
} from '../state/kikx-state.mjs';
import { stackFromSearchParams, stackToURL } from '../state/navigation-stack.mjs';
import {
  HERO_VIEW_TRANSITION_NAME,
  runViewTransition,
  setViewTransitionName,
} from './view-transition.mjs';

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

// A pure toggle: on shows only sub-session cards, off shows all messages.
export function toggleSubSessions(app) {
  if (isCollapsed(app._state))
    return app._expandCurrent();

  return app._showSubSessions();
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
  }).finally(() => clearHeroNames(app));
}

// Keep state.selectedSessionID aligned with the current stack entry so frames
// and titles reflect the active window.
export function syncSelectedSessionToStack(app) {
  let sessionID = getCurrentSessionID(app._state);
  app._state.selectedSessionID = sessionID || '';
}

// Toggle "show sub-sessions" (collapsed) on the current entry. The thread view
// is replaced by a child grid; a crossfade transition plays without a shared
// element (the two views are different element trees).
export async function showSubSessions(app) {
  await runViewTransition(() => {
    setCollapsedView(true, app._state);
    syncURLFromStack(app, { push: true });
    app._render();
  });

  await app._loadSessionPreviews();
}

// Expand a collapsed grid back into the full chat for its session.
export async function expandCurrent(app) {
  let entry = getCurrentEntry(app._state);
  if (!entry.collapsed || !entry.sessionID)
    return;

  await runViewTransition(() => {
    setCollapsedView(false, app._state);
    syncURLFromStack(app, { push: true });
    app._render();
  });
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
export async function applySessionDeepLink(app) {
  if (app._deepLinkApplied)
    return;

  app._deepLinkApplied = true;
  let stack = stackFromCurrentURL(app);
  if (stack.length <= 1)
    return;

  setNavigationStack(stack, app._state);
  let top = getCurrentSessionID(app._state);
  app._state.selectedSessionID = top;
  app._forceScrollToBottomAfterRender = true;

  try {
    if (top)
      await app._loadFrames(top);
  } catch (_error) {}
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
      await app._loadFrames(top);
  } catch (_error) {}

  app._render();
}
