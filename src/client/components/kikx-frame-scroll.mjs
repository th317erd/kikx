'use strict';

import { getDeletedSessions, getGridParentSessionID, getSelectedFrames, getSessionPaging, getSessionPreviews, getVisibleSessions } from '../state/kikx-state.mjs';
import { thinkingAgents, threadRenderFrames } from '../state/thinking-state.mjs';
import { guardClientOperation, reportClientError } from '../lib/error-boundary.mjs';
import { currentViewName } from '../state/navigation-stack.mjs';
import { scheduleAnimationFrame } from './kikx-app-helpers.mjs';
import { buildFrameThread } from './kikx-shell-builders.mjs';
import { countRebuild } from './render-stats.mjs';
import { getScrollLockModeForSession, isScrollLockedForSession } from './kikx-scroll-lock.mjs';
import { ANCHOR_THRESHOLD } from './frame-scroll-constants.mjs';
import { captureFrameListAnchor, restoreFrameListAnchor } from './frame-scroll-anchor.mjs';
import {
  alignBottomFocus,
  alignLastFrameFocus,
  cancelFocusAlignment,
  captureScrollFocus,
  lastFrameID,
  restoreScrollFocus,
  stepFocusAlignment,
} from './scroll-focus.mjs';
import {
  breakScrollLockFromUser,
  cancelFrameListScrollAnimation,
  clearBottomHashMarker,
  lockScrollAtBottom,
  lastFrameItemID,
  maybeRestoreMessageHash,
  messageHashID,
  updateMessageHash,
  updateMessageHashFromScroll,
} from './kikx-frame-scroll-lock.mjs';
import { createKikxPageContext } from './kikx-chat-scrollview.mjs';

export { ANCHOR_THRESHOLD };
export { lockScrollToLatest, scrollToLatestMessageTop, toggleScrollLock } from './kikx-frame-scroll-lock.mjs';

export const LOAD_OLDER_THRESHOLD = 150;

export function captureRenderSnapshot(app) {
  let frameList = app.querySelector('.kikx-frame-list');
  let view = app.querySelector('.kikx-thread__body kikx-chat-view');
  let sessionID = app._state.selectedSessionID;
  let preserveWindowStartFrameID = null;
  if (view?.windowStartFrameID
    && !isScrollLockedForSession(app, sessionID)
    && !isFrameListNearBottom(app, frameList))
    preserveWindowStartFrameID = view.windowStartFrameID;

  let composer = app.querySelector('textarea[name="message"]');
  let composerFocused = app.contains(document.activeElement) && document.activeElement === composer;
  let locked = isScrollLockedForSession(app, sessionID);
  let bottomMode = locked && getScrollLockModeForSession(app, sessionID) === 'bottom';
  let scrollFocus = captureScrollFocus(app, frameList, { bottom: bottomMode });

  return {
    composerFocused,
    composerPresent: Boolean(composer),
    selectedSessionID: sessionID,
    frameListPresent: Boolean(frameList),
    frameListAnchor: captureFrameListAnchor(frameList),
    preserveWindowStartFrameID,
    frameListScrollTop: frameList?.scrollTop ?? 0,
    frameListScrollHeight: frameList?.scrollHeight ?? 0,
    composerSelectionStart: composerFocused ? composer.selectionStart : null,
    composerSelectionEnd: composerFocused ? composer.selectionEnd : null,
    composerSelectionDirection: composerFocused ? composer.selectionDirection : 'none',
    frameListNearBottom: app._frameListAnchoredToBottom,
    scrollFocus,
    viewFrameCount: Array.isArray(view?.frames) ? view.frames.length : 0,
    viewLastFrameID: Array.isArray(view?.frames) ? (view.frames.at(-1)?.id || '') : '',
    forceScrollToBottom: app._forceScrollToBottomAfterRender,
    focusComposer: app._focusComposerAfterRender,
  };
}

export function afterRender(app, snapshot = {}) {
  let sessionID = app._state.selectedSessionID;
  let locked = isScrollLockedForSession(app, sessionID);
  let sessionChanged = Boolean(sessionID && snapshot.selectedSessionID !== sessionID);
  let renderedView = app.querySelector('.kikx-thread__body kikx-chat-view');
  let renderedFrames = Array.isArray(renderedView?.frames) ? renderedView.frames : [];
  if (snapshot.viewLastFrameID
    && renderedFrames.length > (snapshot.viewFrameCount || 0)
    && (renderedFrames.at(-1)?.id || '') !== snapshot.viewLastFrameID)
    clearBottomHashMarker(app);
  let hashID = messageHashID();
  let hashRestored = Boolean(hashID && String(app._hashRestoredSessionID || '').startsWith(`${sessionID}:${hashID}:`));
  if (sessionChanged) {
    app._sentinelSuppressed = false;
    cancelFocusAlignment(app);
    app._lastScrollFocus = null;
    app._scrollFocusFrameID = '';
  }
  app._hashAnchorPending = !locked && Boolean(hashID) && !hashRestored;
  // An explicit #message= anchor wins over the old bottom-follow default. On a
  // reload after the user broke the lock, restoring the top of that message is
  // the whole point; snapping to the bottom first would rewrite the hash.
  let shouldScrollToBottom = !locked
    && !hashID
    && (snapshot.forceScrollToBottom || snapshot.frameListNearBottom);
  let shouldFocusComposer = snapshot.focusComposer || snapshot.composerFocused;
  let shouldRestoreFrameScroll = (
    !locked
    && !shouldScrollToBottom
    && snapshot.frameListPresent
    && !sessionChanged
  );
  let composer = app.querySelector('textarea[name="message"]');
  if (composer && composer.value !== (app._state.draft || ''))
    composer.value = app._state.draft || '';

  // Reconnect before scheduling any placement. connectFrameListObserver tears
  // down the previous observer, and that teardown cancels the active scroll
  // animation. Doing it afterwards canceled the bottom-follow animation that
  // this function had just started, leaving a full render pinned at scrollTop 0.
  connectFrameListObserver(app);

  app._forceScrollToBottomAfterRender = false;
  app._focusComposerAfterRender = false;

  let renderedFrameList = app.querySelector('.kikx-frame-list');
  let focusRestored = snapshot.scrollFocus && !sessionChanged && !app._pendingScrollFocus
    ? restoreScrollFocus(app, renderedFrameList, snapshot.scrollFocus)
    : false;

  if (locked) {
    let initialPlacement = app._lockedPlacementSessionID !== sessionID;
    if (initialPlacement) {
      // The browser may restore its previous scroll position after a reload and
      // emit a scroll event before the first render has settled. Treat that as
      // part of the initial placement, not as the user breaking the pin.
      app._ignoreFrameScrollUntil = Math.max(app._ignoreFrameScrollUntil || 0, Date.now() + 1000);
      if (lastFrameItemID(app))
        app._lockedPlacementSessionID = sessionID;
    }
    if (getScrollLockModeForSession(app, sessionID) === 'bottom') {
      app._frameListAnchoredToBottom = true;
      // The focus restore above already kept the frame the user was looking at
      // exactly still. Only a new focus frame (or first placement/send) is
      // allowed to move. A reconnect resync snaps; ordinary new messages ease.
      if (lastFrameID(renderedFrameList)) {
        alignBottomFocus(app, renderedFrameList, {
          initial: initialPlacement || snapshot.forceScrollToBottom === true || !focusRestored,
          animate: app._runtimeEventsResyncInFlight !== true,
        });
      } else {
        scrollFramesToBottomImmediate(app);
      }
    } else {
      app._frameListAnchoredToBottom = false;
      alignLastFrameFocus(app, renderedFrameList, {
        initial: initialPlacement || !focusRestored,
        animate: !initialPlacement,
      });
    }
  } else if (shouldScrollToBottom) {
    app._frameListAnchoredToBottom = true;
    scrollFramesToBottomImmediate(app);
  } else if (shouldRestoreFrameScroll && !focusRestored) {
    restoreFrameListScroll(app, snapshot);
  } else if (sessionChanged || !snapshot.frameListPresent) {
    maybeRestoreMessageHash(app, (frameList, { bottom }) => captureScrollFocus(app, frameList, { bottom }));
  }

  if (shouldFocusComposer) {
    queueMicrotask(() => {
      let nextComposer = app.querySelector('textarea[name="message"]:not([disabled])');
      if (!nextComposer)
        return;

      nextComposer.focus({ preventScroll: true });
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

  syncThinkingRack(app);
}

// Repaint the pinned thinking rack from the session's live frames. Cheap: it
// only updates the per-agent panels, never the thread or the whole shell.
export function syncThinkingRack(app) {
  let rack = app.querySelector('kikx-thinking-rack');
  if (!rack)
    return;

  guardClientOperation('kikx-frame-scroll.syncThinkingRack', () => {
    rack.update(thinkingAgents(app._thinking, app._state.selectedSessionID));
  });
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
  // The title can be an h2 (root), the relocated breadcrumb title (session
  // window), or an inline input while editing (left alone).
  // The unified topbar renders the active crumb as
  // `.kikx-breadcrumb__crumb--active.kikx-window__title`, not as
  // `.kikx-breadcrumb__title`. Missing that class made this function report
  // `false` on every session event in a drilled-in thread, which forced a full
  // shell rebuild (and replaced the composer under the user's caret).
  let threadTitle = app.querySelector('.kikx-breadcrumb__title, .kikx-breadcrumb__crumb--active, .kikx-window__header h2');
  let editingTitle = app.querySelector('.kikx-breadcrumb__title-input, .kikx-breadcrumb__crumb--editing, .kikx-window__header .kikx-window__title-input');
  if (threadTitle && !editingTitle) {
    let selectedSession = app._selectedSession();
    threadTitle.textContent = selectedSession?.title || 'No session';
  }

  let grid = app.querySelector('kikx-session-grid');
  if (grid) {
    // Respect the current level's parent filter; the grid shows direct
    // children of the active session, never the unfiltered list.
    //
    // S3: use the coalesced grid sync. A burst of `session.saved` events used to
    // call grid.update() (a full grid + card rebuild) once per event; sync()
    // reconciles cards by id and repaints at most once per animation frame.
    grid.sync({
      allSessions: getVisibleSessions(app._state),
      parentSessionID: getGridParentSessionID(app._state),
      previews: getSessionPreviews(app._state),
      appState: app._state,
      selectedSessionID: app._state.selectedSessionID,
      loading: app._state.previewsLoading,
      deletedSessionIDs: new Set(getDeletedSessions(app._state).map((session) => session.id)),
    });
    return true;
  }

  // A view (Inbox, Activities) displaces `buildWindow` entirely -- see
  // `buildRunnerShell` -- so while one is on top there is deliberately no thread
  // title, no session grid and no frame list to repaint.
  //
  // That is not "I could not handle it". The only surface an event could still
  // affect here is the sidebar Inbox badge, and that is owned by
  // `syncQuestionShell` -- called by the `question.*` branch of the event
  // dispatcher, and again by `fetchQuestions`. It deliberately does NOT run
  // here: a badge repaint on every `session.saved` would be work with nothing to
  // do, and this function is on the hot path for every frame event.
  //
  // Reporting `false` here made every `session.saved` -- a title edit, a new
  // session, a soft delete in another tab -- trigger a full shell rebuild, which
  // tore down and re-created the Inbox underneath the user. That is why an
  // entirely unrelated page jumped on any runtime event, and why typing in an
  // answer box lost its caret: the textarea was replaced by a new node, not
  // edited in place.
  if (currentViewName(app._state.navigationStack) !== null)
    return true;

  // While the inline title editor is open there is no title button/h2, but the
  // window shell is still present. Returning false here would force a full app
  // rebuild on every `session.saved`, destroying the editor and its focus.
  return Boolean(threadTitle || editingTitle);
}

export function syncFrameThread(app, sessionID = app._state.selectedSessionID, options = {}) {
  if (!sessionID || sessionID !== app._state.selectedSessionID)
    return;

  guardClientOperation('kikx-frame-scroll.syncFrameThread', () => {
    syncFrameThreadBody(app, sessionID, options);
  }, { sessionID });
}

function syncFrameThreadBody(app, sessionID, options) {
  syncThinkingRack(app);

  let body = app.querySelector('.kikx-thread__body');
  if (!body)
    return;

  let frames = threadRenderFrames(getSelectedFrames(app._state), app._state.frameFilters);
  let view = body.querySelector('kikx-chat-view');
  if (frames.length === 0 || !view) {
    let previousFrameList = app.querySelector('.kikx-frame-list');
    let locked = isScrollLockedForSession(app, sessionID);
    let previousFocus = app._pendingScrollFocus
      ? null
      : captureScrollFocus(app, previousFrameList, {
        bottom: locked && getScrollLockModeForSession(app, sessionID) === 'bottom',
      });
    disconnectFrameListObserver(app);
    // buildFrameThread() always returns a built element, so swap it in directly.
    // (The old `.build(document)` call assumed it was always a builder; the
    // chat-view branch returns an element, so it threw
    // "...build is not a function" and left the thread body unreplaced whenever
    // a session gained its first visible frame.)
    body.replaceChildren(buildFrameThread(app));
    countRebuild('thread');
    connectFrameListObserver(app);
    let nextFrameList = app.querySelector('.kikx-frame-list');
    let focusRestored = previousFocus && restoreScrollFocus(app, nextFrameList, previousFocus);
    if (locked) {
      let initialPlacement = app._lockedPlacementSessionID !== sessionID;
      if (initialPlacement)
        app._lockedPlacementSessionID = sessionID;
      if (getScrollLockModeForSession(app, sessionID) === 'bottom') {
        app._frameListAnchoredToBottom = true;
        alignBottomFocus(app, nextFrameList, {
          initial: initialPlacement || !focusRestored,
          animate: !initialPlacement,
        });
      } else {
        app._frameListAnchoredToBottom = false;
        alignLastFrameFocus(app, nextFrameList, {
          initial: initialPlacement || !focusRestored,
          animate: !initialPlacement,
        });
      }
    } else if (app._frameListAnchoredToBottom) {
      scrollFramesToBottomImmediate(app);
    }
    return;
  }

  if (options.prepend === true) {
    let frameList = view.frameList;
    let locked = isScrollLockedForSession(app, sessionID);
    let lockMode = getScrollLockModeForSession(app, sessionID);
    let focus = captureScrollFocus(app, frameList, { bottom: locked && lockMode === 'bottom' });
    let beforeScrollTop = frameList?.scrollTop ?? 0;
    let beforeScrollHeight = frameList?.scrollHeight ?? 0;
    view.syncFrames(frames, app._state, { ...options, animate: false });
    if (frameList) {
      app._ignoreFrameScrollUntil = Date.now() + 200;
      if (!focus || !restoreScrollFocus(app, frameList, focus)) {
        let growth = frameList.scrollHeight - beforeScrollHeight;
        frameList.scrollTop = Math.max(0, beforeScrollTop + growth);
      }
    }
    if (locked && lockMode !== 'bottom')
      alignLastFrameFocus(app, frameList, { animate: true });
    return;
  }

  let locked = isScrollLockedForSession(app, sessionID);
  let lockMode = getScrollLockModeForSession(app, sessionID);
  let previousFrames = Array.isArray(view.frames) ? view.frames : [];
  let previousFrameCount = previousFrames.length;
  let previousLastFrameID = previousFrames.at(-1)?.id || '';
  view.setPageContext?.(createKikxPageContext(app, sessionID));
  let frameList = view.frameList;
  let shared = view.usesSharedScrollview === true;
  let focus = !shared && !app._pendingScrollFocus
    ? captureScrollFocus(app, frameList, { bottom: locked && lockMode === 'bottom' })
    : null;
  let result = view.syncFrames(frames, app._state, locked ? { ...options, followLatest: true } : options);
  if (frameList && focus)
    restoreScrollFocus(app, frameList, focus);
  if (previousLastFrameID
    && frames.length > previousFrameCount
    && (frames.at(-1)?.id || '') !== previousLastFrameID)
    clearBottomHashMarker(app);

  if (locked && lockMode === 'bottom') {
    let initialPlacement = app._lockedPlacementSessionID !== sessionID;
    if (initialPlacement)
      app._lockedPlacementSessionID = sessionID;
    app._frameListAnchoredToBottom = true;
    alignBottomFocus(app, frameList, {
      initial: initialPlacement,
      animate: app._runtimeEventsResyncInFlight !== true,
    });
  } else if (result.insertedNew && locked) {
    let initialPlacement = app._lockedPlacementSessionID !== sessionID;
    if (initialPlacement)
      app._lockedPlacementSessionID = sessionID;
    app._frameListAnchoredToBottom = false;
    alignLastFrameFocus(app, frameList, { animate: !initialPlacement });
  } else if (result.insertedNew && !locked && view.windowEnd < frames.length) {
    // Unlocked mode must not scroll, but the new frame cannot be left outside
    // the rendered window forever. Grow the window end below the viewport; the
    // current frame stays fixed and the user can scroll down to the new content.
    view.expandNewerFrames();
  }

  if (!locked)
    maybeRestoreMessageHash(app, (frameList, { bottom }) => captureScrollFocus(app, frameList, { bottom }));
}

export function connectFrameListObserver(app) {
  // W8 lifecycle: renderers call this after every thread rebuild. Tear down the
  // previous listener + observer first so a re-render/re-connect can never stack
  // them (and so a detached stream is not left observed).
  disconnectFrameListObserver(app);

  let frameList = app.querySelector('.kikx-frame-list');
  let frameStream = frameList?.querySelector('.kikx-frame-stream');
  if (!frameList || !frameStream)
    return;

  app._observedFrameList = frameList;
  app._lastObservedFrameScrollTop = frameList.scrollTop;
  frameList.addEventListener('scroll', app._onFrameListScroll);
  app._onFrameListUserInterrupt = () => {
    app._frameListUserGestureUntil = Date.now() + 2000;
    app._sentinelSuppressed = false;
    // A real wheel/touch gesture must beat a smooth programmatic scroll that is
    // still inside its grace window; otherwise the user's gesture looks like
    // our own animation and no longer breaks the pin.
    app._ignoreFrameScrollUntil = 0;
    cancelFrameListScrollAnimation(app);
  };
  app._onFrameListPointerDown = (event) => {
    // Only a pointer in the scrollbar gutter is an unambiguous scroll intent.
    // Clicking message text must not make a later layout scroll look user-made.
    let rect = frameList.getBoundingClientRect();
    if (event.clientX < rect.left + frameList.clientWidth - 1)
      return;
    app._frameListUserGestureUntil = Date.now() + 5000;
    app._sentinelSuppressed = false;
    app._ignoreFrameScrollUntil = 0;
    cancelFrameListScrollAnimation(app);
  };
  app._onFrameListKeydown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey)
      return;
    if (![ 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ' ].includes(event.key))
      return;

    app._frameListUserGestureUntil = Date.now() + 2000;
    app._sentinelSuppressed = false;
    app._ignoreFrameScrollUntil = 0;
    cancelFrameListScrollAnimation(app);
  };
  frameList.addEventListener('wheel', app._onFrameListUserInterrupt, { passive: true });
  frameList.addEventListener('touchmove', app._onFrameListUserInterrupt, { passive: true });
  frameList.addEventListener('pointerdown', app._onFrameListPointerDown, { passive: true });
  frameList.addEventListener('keydown', app._onFrameListKeydown);

  // Do not rely on a scroll event to discover older frames. Minimized messages
  // can make the first page shorter than the viewport, so there is no scrollbar
  // and no scroll event to trigger pagination. A viewport sentinel loads the
  // older page (or expands the in-memory window) even in that case.
  let sentinel = document.createElement('div');
  sentinel.className = 'kikx-frame-load-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');
  // A scrollview rebuilds its window element on page changes. Keep the
  // sentinel beside that window (still inside the scrolling viewport) so the
  // page render cannot wipe the pagination trigger.
  let sentinelParent = frameStream.parentElement === frameList ? frameList : frameStream;
  sentinelParent.insertBefore(sentinel, sentinelParent === frameList ? frameStream : frameStream.firstChild);
  app._frameLoadSentinel = sentinel;

  if (typeof IntersectionObserver === 'function') {
    app._frameLoadIntersectionObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting))
        return;

      if (isScrollLockedForSession(app, app._state.selectedSessionID)
        || app._hashAnchorPending === true
        || (app._sentinelSuppressed === true && isFrameListScrollable(frameList)))
        return;

      guardClientOperation('kikx-frame-scroll.loadOlderSentinel', () => {
        fillOlderFramesFromSentinel(app, frameList).catch((error) => {
          reportClientError('kikx-frame-scroll.loadOlderSentinel', error);
        });
      });
    }, {
      root: frameList,
      rootMargin: '0px 0px 200px 0px',
    });
    app._frameLoadIntersectionObserver.observe(sentinel);
  } else {
    // Older browsers: fill the viewport eagerly when there is no scrollbar.
    if (frameList.scrollHeight <= frameList.clientHeight
      && !isScrollLockedForSession(app, app._state.selectedSessionID)
      && app._hashAnchorPending !== true
      && !(app._sentinelSuppressed === true && isFrameListScrollable(frameList)))
      fillOlderFramesFromSentinel(app, frameList).catch((error) => {
        reportClientError('kikx-frame-scroll.loadOlderFallback', error);
      });
  }

  if (typeof ResizeObserver !== 'function')
    return;

  app._frameListResizeObserver = new ResizeObserver(app._onFrameContentResize);
  app._frameListResizeObserver.observe(frameStream);
}

export function disconnectFrameListObserver(app) {
  if (app._observedFrameList) {
    app._observedFrameList.removeEventListener('scroll', app._onFrameListScroll);
    if (app._onFrameListUserInterrupt) {
      app._observedFrameList.removeEventListener('wheel', app._onFrameListUserInterrupt);
      app._observedFrameList.removeEventListener('touchmove', app._onFrameListUserInterrupt);
    }
    if (app._onFrameListPointerDown)
      app._observedFrameList.removeEventListener('pointerdown', app._onFrameListPointerDown);
    if (app._onFrameListKeydown)
      app._observedFrameList.removeEventListener('keydown', app._onFrameListKeydown);
    app._observedFrameList = null;
  }
  app._onFrameListUserInterrupt = null;
  app._onFrameListPointerDown = null;
  app._onFrameListKeydown = null;
  cancelFrameListScrollAnimation(app);

  app._frameLoadIntersectionObserver?.disconnect?.();
  app._frameLoadIntersectionObserver = null;
  app._frameLoadSentinel = null;

  if (app._frameListResizeObserver) {
    app._frameListResizeObserver.disconnect();
    app._frameListResizeObserver = null;
  }
}

function isFrameListScrollable(frameList) {
  return Boolean(frameList && frameList.scrollHeight > frameList.clientHeight + 1);
}

export function isFrameListNearBottom(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList)
    return true;

  return frameList.scrollHeight - frameList.scrollTop - frameList.clientHeight <= ANCHOR_THRESHOLD;
}

export function scrollFramesToBottom(app) {
  app._frameListAnchoredToBottom = true;
  let frameList = app.querySelector('.kikx-frame-list');
  if (!frameList)
    return;

  followFrameListToBottom(app, frameList);
}

// A bottom-follow loop rather than a fixed-duration animation. Content can keep
// growing (markdown streaming, tool cards expanding), so the target is
// recomputed every frame and the viewport eases toward it instead of jumping.
function followFrameListToBottom(app, frameList) {
  cancelFrameListScrollAnimation(app);
  let token = Symbol('frame-bottom-follow');
  let lastTimestamp = null;
  app._frameListScrollAnimation = token;
  app._ignoreFrameScrollUntil = Date.now() + 220;

  let step = (timestamp) => {
    if (app._frameListScrollAnimation !== token)
      return;

    let now = Number.isFinite(timestamp)
      ? timestamp
      : (globalThis.performance?.now?.() ?? Date.now());
    let elapsed = lastTimestamp == null ? 16 : Math.min(48, Math.max(1, now - lastTimestamp));
    lastTimestamp = now;

    let target = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
    let current = frameList.scrollTop;
    let distance = target - current;
    if (Math.abs(distance) <= 0.5) {
      frameList.scrollTop = target;
      app._frameListScrollAnimation = null;
      updateMessageHash(app, lastFrameID(frameList), { atBottom: true });
      captureScrollFocus(app, frameList, { bottom: true });
      return;
    }

    // Time-based exponential easing: independent of frame rate, and still
    // stable when a ResizeObserver restarts the follow loop mid-flight.
    let factor = 1 - Math.exp(-elapsed / 95);
    let delta = distance * factor;
    if (Math.abs(delta) < 0.5)
      delta = Math.sign(distance) * 0.5;
    frameList.scrollTop = current + delta;
    app._ignoreFrameScrollUntil = Date.now() + 220;
    scheduleAnimationFrame(step);
  };

  scheduleAnimationFrame(step);
}

export function scrollFramesToBottomImmediate(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList)
    return;

  cancelFrameListScrollAnimation(app);
  app._ignoreFrameScrollUntil = Date.now() + 200;
  frameList.scrollTop = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  updateMessageHash(app, lastFrameID(frameList), { atBottom: true });
  captureScrollFocus(app, frameList, { bottom: true });
}

export function restoreFrameListScroll(app, snapshot = {}) {
  let frameList = app.querySelector('.kikx-frame-list');
  if (!frameList)
    return;

  app._ignoreFrameScrollUntil = Date.now() + 200;
  if (restoreFrameListAnchor(frameList, snapshot.frameListAnchor))
    return;

  let maxScrollTop = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  frameList.scrollTop = Math.min(Math.max(0, snapshot.frameListScrollTop || 0), maxScrollTop);
}

export function onFrameContentResize(app) {
  let frameList = app.querySelector('.kikx-frame-list');
  if (!frameList)
    return;

  // ResizeObserver runs after layout and before paint. Restoring the focus
  // anchor here is a synchronous snap: the content may change size, but the
  // frame the user is looking at keeps the same viewport offset.
  if (app._pendingScrollFocus) {
    stepFocusAlignment(app, frameList);
    return;
  }

  // The shared scrollview owns geometry and its own focal transaction. Do not
  // replay Kikx's old hash/focus anchor over it: after an older page loads at
  // the top that stale focus is the *old* top frame, so restoring it pushes the
  // just-loaded page above the viewport and undoes the user's upward scroll.
  let view = app.querySelector('.kikx-thread__body kikx-chat-view');
  let shared = view?.usesSharedScrollview === true;
  let focus = app._lastScrollFocus;
  if (!shared && focus)
    restoreScrollFocus(app, frameList, focus);

  let sessionID = app._state.selectedSessionID;
  if (sessionID
    && isScrollLockedForSession(app, sessionID)
    && getScrollLockModeForSession(app, sessionID) === 'bottom') {
    if (lastFrameID(frameList)) {
      alignBottomFocus(app, frameList, {
        animate: app._runtimeEventsResyncInFlight !== true,
      });
    } else {
      scrollFramesToBottom(app);
    }
  }
}

export function onFrameListScroll(app, event) {
  let frameList = event.currentTarget;
  let programmatic = Date.now() < (app._ignoreFrameScrollUntil || 0);
  let sessionID = app._state.selectedSessionID;
  let nearBottom = isFrameListNearBottom(app, frameList);

  let userGesture = Date.now() < (app._frameListUserGestureUntil || 0);
  let brokeLock = false;
  let previousScrollTop = app._lastObservedFrameScrollTop;
  app._lastObservedFrameScrollTop = frameList.scrollTop;
  if (!programmatic) {
    // Layout changes can move scrollTop without any user action. Break the pin
    // only when a real gesture actually moved the viewport away from where the
    // lock had placed it. Wheel momentum at the bottom produces no delta and
    // must not turn the lock straight back off.
    let delta = previousScrollTop == null ? 0 : frameList.scrollTop - previousScrollTop;
    let lockMode = getScrollLockModeForSession(app, sessionID);
    let movedAway = lockMode === 'bottom' ? delta < -2 : Math.abs(delta) > 2;
    if (userGesture && isScrollLockedForSession(app, sessionID) && movedAway) {
      brokeLock = true;
      app._sentinelSuppressed = false;
      cancelFrameListScrollAnimation(app);
      breakScrollLockFromUser(app);
    }
    updateMessageHashFromScroll(app, frameList);
    // A user scroll redefines the focus frame. Layout-only scroll events do not:
    // they are exactly what the focus anchor is supposed to suppress.
    if (userGesture) {
      cancelFocusAlignment(app);
      captureScrollFocus(app, frameList, { bottom: false });
    }
    if (!nearBottom)
      app._bottomLockIntent = false;
  }

  app._frameListAnchoredToBottom = !isScrollLockedForSession(app, sessionID) && nearBottom;
  maybeLoadOlderFrames(app, frameList);

  if (!isScrollLockedForSession(app, sessionID) && nearBottom) {
    if (userGesture && !brokeLock) {
      app._bottomLockIntent = true;
      if (lockScrollAtBottom(app))
        return;
    }

    // If the user has been reading an older render window, extend it forward
    // in small chunks while keeping the current frame under the viewport. The
    // old showLatestFrames() swap replaced the whole window and jumped several
    // pages at once.
    let view = app.querySelector('.kikx-thread__body kikx-chat-view');
    if (view?.expandNewerFrames?.())
      return;

    maybeLoadNewerFrames(app, frameList);
  }
}

export async function fillOlderFramesFromSentinel(app, frameList) {
  if (app._frameLoadFillInFlight)
    return;

  app._frameLoadFillInFlight = true;
  try {
    // A single expansion can still leave a short page below the viewport. Keep
    // expanding/fetching until the first page fills the viewport or the source
    // is exhausted. The cap prevents a pathological tiny-window loop.
    for (let step = 0; step < 12; step++) {
      let result = maybeLoadOlderFrames(app, frameList);
      if (!result)
        break;
      if (typeof result.then === 'function')
        await result;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (frameList.scrollHeight > frameList.clientHeight + 1)
        break;
    }
  } finally {
    app._frameLoadFillInFlight = false;
  }
}

export function maybeLoadOlderFrames(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList || frameList.scrollTop > LOAD_OLDER_THRESHOLD)
    return false;
  // Pinned mode is at the newest message. Pulling older pages there causes a
  // multi-page prepend shift (and is not what the user asked for). The same
  // applies while the reload anchor is being placed: the list is at scrollTop 0
  // for a moment and the sentinel would otherwise fetch pages the user will
  // never see.
  if (isScrollLockedForSession(app, app._state.selectedSessionID)
    || app._hashAnchorPending === true
    || (app._sentinelSuppressed === true && isFrameListScrollable(frameList)))
    return false;

  // Reveal frames already in state first; only fetch an older page once the
  // render window has reached the oldest loaded frame.
  let view = app.querySelector('.kikx-thread__body kikx-chat-view');
  if (view?.usesPagedScrollview === true) {
    view.expandOlderFrames?.();
    return false;
  }
  if (view?.expandOlderFrames?.())
    return true;

  let sessionID = app._state.selectedSessionID;
  let paging = getSessionPaging(app._state, sessionID);

  if (paging.loading === true || paging.hasMoreOlder !== true)
    return false;

  let load = app._loadOlderFrames?.(sessionID);
  return load || true;
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
