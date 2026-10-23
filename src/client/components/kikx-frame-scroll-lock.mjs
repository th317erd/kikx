'use strict';

import { getSessionPaging } from '../state/kikx-state.mjs';
import { scheduleAnimationFrame } from './kikx-app-helpers.mjs';
import {
  ANCHOR_THRESHOLD,
  SCROLL_ANIMATION_MS,
  SCROLL_LOCK_REARM_MS,
} from './frame-scroll-constants.mjs';
import {
  getScrollLockModeForSession,
  isScrollLockedForSession,
  paintScrollLockButton,
  setScrollLockedForSession,
  setScrollLockModeForSession,
} from './kikx-scroll-lock.mjs';

export function scrollToLatestMessageTop(app, options = {}) {
  let frameList = app.querySelector('.kikx-frame-list');
  let item = lastFrameItem(app, frameList);
  if (!frameList || !item)
    return false;

  scrollItemTop(app, frameList, item, options);
  app._frameListAnchoredToBottom = false;
  updateMessageHash(app, item.dataset.frameId || '');
  return true;
}

export function scheduleLatestMessageTop(app, options = {}) {
  scheduleAnimationFrame(() => {
    scrollToLatestMessageTop(app, options);
  });
}

export function lockScrollToLatest(app) {
  let sessionID = app._state.selectedSessionID;
  if (!sessionID)
    return false;

  app._ignoreFrameScrollUntil = 0;
  cancelFrameListScrollAnimation(app);
  setScrollLockedForSession(app, true, sessionID);
  setScrollLockModeForSession(app, 'top', sessionID);
  paintScrollLockButton(app, sessionID, true);
  cancelScrollLockRearm(app);
  return scrollToLatestMessageTop(app, { animate: false });
}

export function toggleScrollLock(app) {
  let sessionID = app._state.selectedSessionID;
  if (!sessionID)
    return false;

  let next = !isScrollLockedForSession(app, sessionID);
  setScrollLockedForSession(app, next, sessionID);
  paintScrollLockButton(app, sessionID, next);
  if (next) {
    setScrollLockModeForSession(app, 'top', sessionID);
    cancelScrollLockRearm(app);
    scrollToLatestMessageTop(app, { animate: true });
  } else {
    app._ignoreFrameScrollUntil = 0;
    cancelFrameListScrollAnimation(app);
  }
  return next;
}

export function lastFrameItemID(app) {
  return lastFrameItem(app)?.dataset.frameId || '';
}

export function topVisibleFrameID(app, frameList) {
  if (!frameList)
    return '';
  let listRect = frameList.getBoundingClientRect();
  let items = [ ...frameList.querySelectorAll('kikx-frame-item') ];
  for (let item of items) {
    let rect = item.getBoundingClientRect();
    if (rect.bottom > listRect.top + 1)
      return item.dataset.frameId || '';
  }
  return items.at(-1)?.dataset.frameId || '';
}

export function updateMessageHash(app, frameID, { atBottom = false } = {}) {
  if (!frameID || !globalThis.location || !globalThis.history?.replaceState)
    return;

  let sessionID = app._state?.selectedSessionID;
  // bottom=1 is written for every bottom position. bottom=0 is only needed
  // on the newest message, where it distinguishes "reading its top" from a
  // legacy anchor that means "was at the bottom".
  let marker = atBottom ? '1' : (frameID === lastFrameItemID(app) ? '0' : '');
  app._hashRestoredSessionID = sessionID ? `${sessionID}:${frameID}:${marker}` : '';
  let key = `${frameID}:${marker}`;
  if (app._lastMessageHashKey === key)
    return;

  app._lastMessageHashKey = key;
  let location = globalThis.location;
  let hash = `#message=${encodeURIComponent(frameID)}${marker ? `&bottom=${marker}` : ''}`;
  let next = `${location.pathname}${location.search}${hash}`;
  if (location.hash !== hash)
    globalThis.history?.replaceState?.(null, '', next);
}

export function updateMessageHashFromScroll(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList)
    return;
  updateMessageHash(app, topVisibleFrameID(app, frameList), { atBottom: isNearBottom(frameList) });
}

export function messageHashID() {
  let hash = globalThis.location?.hash || '';
  let match = /(?:^#|&)message=([^&]+)/.exec(hash);
  if (!match)
    return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_error) {
    return '';
  }
}

export function messageHashAtBottom() {
  let hash = globalThis.location?.hash || '';
  let match = /(?:^#|&)bottom=(1|0)(?:&|$)/.exec(hash);
  return match ? match[1] === '1' : null;
}

export async function maybeRestoreMessageHash(app) {
  let frameID = messageHashID();
  let sessionID = app._state.selectedSessionID;
  let bottomState = messageHashAtBottom();
  if (!frameID || !sessionID || isScrollLockedForSession(app, sessionID))
    return false;
  // Any marker for this frame id means the viewport was already placed there.
  // Comparing the exact marker caused a legacy id to look "unrestored" after a
  // scroll rewrote the hash without a bottom marker, which re-anchored the view
  // repeatedly while the user was reading.
  if (app._hashRestoreInFlight
    || String(app._hashRestoredSessionID || '').startsWith(`${sessionID}:${frameID}:`))
    return false;

  app._hashRestoreInFlight = true;
  try {
    let frameList = app.querySelector('.kikx-frame-list');
    let items = [ ...(frameList?.querySelectorAll('kikx-frame-item') || []) ];
    let item = items.find((candidate) => candidate.dataset.frameId === frameID);

    // A detached anchor used to walk backward through every newer page. Load
    // the one window that starts at the anchor instead.
    if (!item && bottomState !== true && app._loadFramesAtMessage) {
      try {
        await app._loadFramesAtMessage(sessionID, frameID);
      } catch (_error) {}
      frameList = app.querySelector('.kikx-frame-list');
      items = [ ...(frameList?.querySelectorAll('kikx-frame-item') || []) ];
      item = items.find((candidate) => candidate.dataset.frameId === frameID);
    }

    if (item) {
      // Legacy anchors only carried a message id. If that id is the newest
      // message, the user was almost certainly at the bottom; aligning its
      // top would leave them a page short. New anchors carry an explicit
      // bottom=0/1 marker so the top of the newest message is still exact.
      let restoreBottom = bottomState === true || (bottomState == null && item === items.at(-1));
      if (restoreBottom) {
        cancelFrameListScrollAnimation(app);
        setFrameListScrollTop(app, frameList, frameList.scrollHeight - frameList.clientHeight, { programmatic: true });
      } else {
        scrollItemTop(app, frameList, item, { animate: false });
      }
      // Restoring an anchor is a one-shot placement, not a decision to keep
      // following the bottom. The user is still unlocked; only the 3s
      // bottom-rest re-arms pinning.
      app._frameListAnchoredToBottom = false;
      let restoredMarker = restoreBottom ? '1' : '0';
      app._hashRestoredSessionID = `${sessionID}:${frameID}:${restoredMarker}`;
      app._hashAnchorPending = false;
      app._sentinelSuppressed = true;
      app._anchorRestoredScrollTop = frameList.scrollTop;
      app._anchorRestoreAt = Date.now();
      updateMessageHash(app, frameID, { atBottom: restoreBottom });
      if (frameList.scrollHeight <= frameList.clientHeight + 1 && pagingHasOlder(app, sessionID))
        await app._fillOlderFrames?.(frameList);
      return true;
    }

    if (bottomState === true) {
      if (!frameList || items.length === 0)
        return false;
      cancelFrameListScrollAnimation(app);
      setFrameListScrollTop(app, frameList, frameList.scrollHeight - frameList.clientHeight, { programmatic: true });
      app._frameListAnchoredToBottom = false;
      let lastID = lastFrameItemID(app);
      app._hashRestoredSessionID = `${sessionID}:${lastID}:1`;
      app._hashAnchorPending = false;
      app._sentinelSuppressed = true;
      app._anchorRestoredScrollTop = frameList.scrollTop;
      app._anchorRestoreAt = Date.now();
      updateMessageHash(app, lastID, { atBottom: true });
      if (frameList.scrollHeight <= frameList.clientHeight + 1 && pagingHasOlder(app, sessionID))
        await app._fillOlderFrames?.(frameList);
      return true;
    }

    // Fallback for an old server/build that does not understand start=<id>.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (app._state.selectedSessionID !== sessionID || isScrollLockedForSession(app, sessionID))
        return false;

      let paging = getSessionPaging(app._state, sessionID);
      if (paging.hasMoreOlder !== true || paging.loading === true)
        break;
      let load = app._loadOlderFrames?.(sessionID);
      if (!load)
        break;
      await load;
      await new Promise((resolve) => setTimeout(resolve, 0));

      frameList = app.querySelector('.kikx-frame-list');
      items = [ ...(frameList?.querySelectorAll('kikx-frame-item') || []) ];
      item = items.find((candidate) => candidate.dataset.frameId === frameID);
      if (!item)
        continue;

      scrollItemTop(app, frameList, item, { animate: false });
      app._frameListAnchoredToBottom = false;
      app._hashRestoredSessionID = `${sessionID}:${frameID}:0`;
      app._hashAnchorPending = false;
      app._sentinelSuppressed = true;
      updateMessageHash(app, frameID, { atBottom: false });
      return true;
    }
    return false;
  } finally {
    app._hashRestoreInFlight = false;
    if (app._hashAnchorPending === true)
      app._hashAnchorPending = false;
  }
}

export function breakScrollLockFromUser(app) {
  let sessionID = app._state.selectedSessionID;
  if (!sessionID || !isScrollLockedForSession(app, sessionID))
    return;

  app._ignoreFrameScrollUntil = 0;
  cancelFrameListScrollAnimation(app);
  setScrollLockedForSession(app, false, sessionID);
  paintScrollLockButton(app, sessionID, false);
  cancelScrollLockRearm(app);
}

// Re-enable pinning only after the user deliberately rests at the bottom. This
// engages in BOTTOM mode: it must not move the viewport (especially not to the
// top of the newest message) at the moment the lock turns on.
export function armScrollLockRearm(app) {
  cancelScrollLockRearm(app);
  let sessionID = app._state.selectedSessionID;
  if (!sessionID || isScrollLockedForSession(app, sessionID))
    return;

  app._scrollLockRearmTimer = setTimeout(() => {
    app._scrollLockRearmTimer = null;
    let frameList = app.querySelector('.kikx-frame-list');
    if (!frameList || !isNearBottom(frameList) || isScrollLockedForSession(app, sessionID))
      return;

    // Only pin when the rendered window actually reaches the loaded tail and
    // no newer page is waiting. Otherwise the bottom of an older window is not
    // the bottom of the conversation, and switching windows here would jump.
    let paging = getSessionPaging(app._state, sessionID);
    let view = app.querySelector('.kikx-thread__body kikx-chat-view');
    let loadedFrames = app._state.framesBySessionID?.[sessionID]?.length || 0;
    if (paging.hasMoreNewer === true || !view || view.windowEnd < loadedFrames)
      return;

    setScrollLockedForSession(app, true, sessionID);
    setScrollLockModeForSession(app, 'bottom', sessionID);
    paintScrollLockButton(app, sessionID, true);
    app._frameListAnchoredToBottom = true;
  }, SCROLL_LOCK_REARM_MS);
  app._scrollLockRearmTimer.unref?.();
}

export function cancelScrollLockRearm(app) {
  if (app._scrollLockRearmTimer) {
    clearTimeout(app._scrollLockRearmTimer);
    app._scrollLockRearmTimer = null;
  }
}

export function animateFrameListScroll(app, frameList, resolveTarget, options = {}) {
  cancelFrameListScrollAnimation(app);
  let duration = Number.isFinite(options.duration) ? Math.max(0, options.duration) : SCROLL_ANIMATION_MS;
  let startTop = frameList.scrollTop;
  let reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  let target = clampedScrollTop(frameList, resolveTarget());
  if (reduced || duration === 0 || Math.abs(target - startTop) < 1) {
    setFrameListScrollTop(app, frameList, target, { programmatic: true });
    options.onComplete?.();
    return;
  }

  let token = Symbol('frame-scroll-animation');
  let startedAt = null;
  app._frameListScrollAnimation = token;
  app._ignoreFrameScrollUntil = Date.now() + duration + 250;

  let step = (timestamp) => {
    if (app._frameListScrollAnimation !== token)
      return;

    let now = Number.isFinite(timestamp)
      ? timestamp
      : (globalThis.performance?.now?.() ?? Date.now());
    if (startedAt == null)
      startedAt = now;

    let progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
    let eased = progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    target = clampedScrollTop(frameList, resolveTarget());
    frameList.scrollTop = startTop + (target - startTop) * eased;

    if (progress < 1) {
      scheduleAnimationFrame(step);
      return;
    }

    app._frameListScrollAnimation = null;
    setFrameListScrollTop(app, frameList, target, { programmatic: true });
    options.onComplete?.();
  };

  scheduleAnimationFrame(step);
}

export function cancelFrameListScrollAnimation(app) {
  app._frameListScrollAnimation = null;
}

function scrollItemTop(app, frameList, item, { animate = false } = {}) {
  // Prefer the layout offset. getBoundingClientRect() includes the enter
  // animation's transform, so recomputing from it mid-animation makes the
  // target chase the current scrollTop instead of converging on the card.
  let resolveTarget = () => itemTopWithinList(frameList, item);

  if (animate) {
    animateFrameListScroll(app, frameList, resolveTarget);
    return;
  }

  cancelFrameListScrollAnimation(app);
  setFrameListScrollTop(app, frameList, clampedScrollTop(frameList, resolveTarget()), { programmatic: true });
}

function itemTopWithinList(frameList, item) {
  if (Number.isFinite(item.offsetTop)) {
    let stream = frameList.querySelector?.('.kikx-frame-stream');
    if (!stream || item.offsetParent === stream || item.offsetParent == null)
      return item.offsetTop + frameListTopInset(frameList);
  }

  let listRect = frameList.getBoundingClientRect();
  let itemRect = item.getBoundingClientRect();
  return frameList.scrollTop + itemRect.top - listRect.top;
}

// offsetTop excludes the first card's top margin, but that margin is part of
// the scrollable content's visual inset (1em on full messages). Add it so
// "top of the message" means the card border, not the invisible margin above it.
function frameListTopInset(frameList) {
  let first = frameList.querySelector?.('kikx-frame-item');
  if (!first)
    return 0;
  let margin = Number.parseFloat(globalThis.getComputedStyle?.(first)?.marginTop || '0');
  return Number.isFinite(margin) ? margin : 0;
}

function setFrameListScrollTop(app, frameList, top, { programmatic = false } = {}) {
  if (programmatic)
    app._ignoreFrameScrollUntil = Date.now() + 150;
  frameList.scrollTop = Math.max(0, top);
}

function clampedScrollTop(frameList, top) {
  let max = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  return Math.min(Math.max(0, top), max);
}

function lastFrameItem(app, frameList = app.querySelector('.kikx-frame-list')) {
  if (!frameList)
    return null;
  let items = frameList.querySelectorAll('kikx-frame-item');
  return items[items.length - 1] || null;
}

function pagingHasOlder(app, sessionID) {
  return getSessionPaging(app._state, sessionID).hasMoreOlder === true;
}

function isNearBottom(frameList) {
  return frameList.scrollHeight - frameList.scrollTop - frameList.clientHeight <= ANCHOR_THRESHOLD;
}
