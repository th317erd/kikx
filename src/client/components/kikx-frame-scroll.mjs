'use strict';

import { getGridParentSessionID, getSelectedFrames, getSessionPaging, getSessions, getSessionPreviews } from '../state/kikx-state.mjs';
import { scheduleAnimationFrame } from './kikx-app-helpers.mjs';
import { buildFrameThread } from './kikx-shell-builders.mjs';

export const ANCHOR_THRESHOLD = 50;
export const FRAME_ENTER_ANIMATION_MS = 260;
export const LOAD_OLDER_THRESHOLD = 150;

export function captureRenderSnapshot(app) {
  let frameList = app.querySelector('.kikx-frame-list');

  let composer = app.querySelector('textarea[name="message"]');
  let composerFocused = app.contains(document.activeElement) && document.activeElement === composer;

  return {
    composerFocused,
    composerPresent: Boolean(composer),
    selectedSessionID: app._state.selectedSessionID,
    frameListPresent: Boolean(frameList),
    frameListScrollTop: frameList?.scrollTop ?? 0,
    frameListScrollHeight: frameList?.scrollHeight ?? 0,
    composerSelectionStart: composerFocused ? composer.selectionStart : null,
    composerSelectionEnd: composerFocused ? composer.selectionEnd : null,
    composerSelectionDirection: composerFocused ? composer.selectionDirection : 'none',
    frameListNearBottom: app._frameListAnchoredToBottom,
    forceScrollToBottom: app._forceScrollToBottomAfterRender,
    focusComposer: app._focusComposerAfterRender,
  };
}

export function afterRender(app, snapshot = {}) {
  let shouldScrollToBottom = snapshot.forceScrollToBottom || snapshot.frameListNearBottom;
  let shouldFocusComposer = snapshot.focusComposer || snapshot.composerFocused;
  let shouldRestoreFrameScroll = (
    !shouldScrollToBottom
    && snapshot.frameListPresent
    && snapshot.selectedSessionID === app._state.selectedSessionID
  );
  let composer = app.querySelector('textarea[name="message"]');
  if (composer && composer.value !== (app._state.draft || ''))
    composer.value = app._state.draft || '';

  app._forceScrollToBottomAfterRender = false;
  app._focusComposerAfterRender = false;

  if (shouldScrollToBottom) {
    app._frameListAnchoredToBottom = true;
    scrollFramesToBottom(app);
  } else if (shouldRestoreFrameScroll) {
    restoreFrameListScroll(app, snapshot);
  }

  if (shouldFocusComposer) {
    queueMicrotask(() => {
      let nextComposer = app.querySelector('textarea[name="message"]:not([disabled])');
      if (!nextComposer)
        return;

      nextComposer.focus();
      if (Number.isInteger(snapshot.composerSelectionStart) && Number.isInteger(snapshot.composerSelectionEnd)) {
        let max = nextComposer.value.length;
        nextComposer.setSelectionRange(
          Math.min(snapshot.composerSelectionStart, max),
          Math.min(snapshot.composerSelectionEnd, max),
          snapshot.composerSelectionDirection || 'none',
        );
      }
    });
  }

  connectFrameListObserver(app);
}

export function requestRender(app) {
  if (app._renderScheduled)
    return;

  app._renderScheduled = true;
  scheduleAnimationFrame(() => {
    app._renderScheduled = false;
    if (app.isConnected)
      app._render();
  });
}

export function syncSessionShell(app) {
  // The title can be an h2 (root) or an editable button (session window); in
  // edit mode it is an input, which we leave alone.
  let threadTitle = app.querySelector('.kikx-window__header .kikx-window__title, .kikx-window__header h2');
  let selectedSession = app._selectedSession();
  if (threadTitle)
    threadTitle.textContent = selectedSession?.title || 'No session';

  let grid = app.querySelector('kikx-session-grid');
  if (grid) {
    // Respect the current level's parent filter; the grid shows direct
    // children of the active session, never the unfiltered list.
    grid.update({
      allSessions: getSessions(app._state),
      parentSessionID: getGridParentSessionID(app._state),
      previews: getSessionPreviews(app._state),
      appState: app._state,
      selectedSessionID: app._state.selectedSessionID,
      loading: app._state.previewsLoading,
    });
    return true;
  }

  return Boolean(threadTitle);
}

export function syncFrameThread(app, sessionID = app._state.selectedSessionID, options = {}) {
  if (!sessionID || sessionID !== app._state.selectedSessionID)
    return;

  let body = app.querySelector('.kikx-thread__body');
  if (!body)
    return;

  let frames = getSelectedFrames(app._state).filter((frame) => frame && !frame.deleted && !frame.hidden);
  let view = body.querySelector('kikx-chat-view');
  if (frames.length === 0 || !view) {
    disconnectFrameListObserver(app);
    // buildFrameThread() always returns a built element, so swap it in directly.
    // (The old `.build(document)` call assumed it was always a builder; the
    // chat-view branch returns an element, so it threw
    // "...build is not a function" and left the thread body unreplaced whenever
    // a session gained its first visible frame.)
    body.replaceChildren(buildFrameThread(app));
    connectFrameListObserver(app);
    if (app._frameListAnchoredToBottom)
      scrollFramesToBottomImmediate(app);
    return;
  }

  if (options.prepend === true) {
    let frameList = view.frameList;
    let beforeScrollTop = frameList?.scrollTop ?? 0;
    let beforeScrollHeight = frameList?.scrollHeight ?? 0;
    view.syncFrames(frames, app._state, { ...options, animate: false });
    if (frameList) {
      let growth = frameList.scrollHeight - beforeScrollHeight;
      frameList.scrollTop = Math.max(0, beforeScrollTop + growth);
    }
    return;
  }

  let wasAnchoredToBottom = app._frameListAnchoredToBottom || isFrameListNearBottom(app, view.frameList);
  let result = view.syncFrames(frames, app._state, options);

  if (result.insertedNew && wasAnchoredToBottom) {
    app._frameListAnchoredToBottom = true;
    scheduleAnchoredFrameScroll(app);
  }
}

export function cleanupReactiveBindings(app, root = app) {
  let nodes = [ root, ...root.querySelectorAll('*') ];
  for (let node of nodes) {
    if (!Array.isArray(node.__bindings))
      continue;

    for (let cleanup of node.__bindings)
      cleanup?.();

    node.__bindings = [];
  }
}

export function connectFrameListObserver(app) {
  let frameList = app.querySelector('.kikx-frame-list');
  let frameStream = frameList?.querySelector('.kikx-frame-stream');
  if (!frameList || !frameStream || typeof ResizeObserver !== 'function')
    return;

  app._observedFrameList = frameList;
  frameList.addEventListener('scroll', app._onFrameListScroll);
  app._frameListResizeObserver = new ResizeObserver(app._onFrameContentResize);
  app._frameListResizeObserver.observe(frameStream);
}

export function disconnectFrameListObserver(app) {
  if (app._observedFrameList) {
    app._observedFrameList.removeEventListener('scroll', app._onFrameListScroll);
    app._observedFrameList = null;
  }

  if (!app._frameListResizeObserver)
    return;

  app._frameListResizeObserver.disconnect();
  app._frameListResizeObserver = null;
}

export function isFrameListNearBottom(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList)
    return true;

  return frameList.scrollHeight - frameList.scrollTop - frameList.clientHeight <= ANCHOR_THRESHOLD;
}

export function scrollFramesToBottom(app) {
  app._frameListAnchoredToBottom = true;
  scrollFramesToBottomImmediate(app);
}

export function scheduleAnchoredFrameScroll(app) {
  scheduleAnimationFrame(() => {
    scrollFramesToBottomImmediate(app);
  });

  setTimeout(() => {
    scrollFramesToBottomImmediate(app);
  }, FRAME_ENTER_ANIMATION_MS + 40);
}

export function scrollFramesToBottomImmediate(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList)
    return;

  frameList.scrollTop = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
}

export function restoreFrameListScroll(app, snapshot = {}) {
  let frameList = app.querySelector('.kikx-frame-list');
  if (!frameList)
    return;

  let maxScrollTop = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  frameList.scrollTop = Math.min(Math.max(0, snapshot.frameListScrollTop || 0), maxScrollTop);
}

export function onFrameContentResize(app) {
  if (app._frameListAnchoredToBottom)
    scrollFramesToBottomImmediate(app);
}

export function onFrameListScroll(app, event) {
  app._frameListAnchoredToBottom = isFrameListNearBottom(app, event.currentTarget);
  maybeLoadOlderFrames(app, event.currentTarget);

  if (app._frameListAnchoredToBottom)
    maybeLoadNewerFrames(app, event.currentTarget);
}

export function maybeLoadOlderFrames(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList || frameList.scrollTop > LOAD_OLDER_THRESHOLD)
    return;

  let sessionID = app._state.selectedSessionID;
  let paging = getSessionPaging(app._state, sessionID);

  if (paging.loading === true || paging.hasMoreOlder !== true)
    return;

  app._loadOlderFrames?.(sessionID);
}

// When the user returns to the bottom after trimming, refetch the newest page.
export function maybeLoadNewerFrames(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList || !isFrameListNearBottom(app, frameList))
    return;

  let sessionID = app._state.selectedSessionID;
  let paging = getSessionPaging(app._state, sessionID);

  if (paging.loading === true || paging.hasMoreNewer !== true)
    return;

  app._loadNewerFrames?.(sessionID);
}
