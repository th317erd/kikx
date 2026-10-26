'use strict';

import {
  captureFrameListFocus,
  frameItemTopWithinList,
  restoreFrameListFocus,
} from './frame-scroll-anchor.mjs';
import {
  animateFrameListScroll,
  cancelFrameListScrollAnimation,
  messageHashID,
  topVisibleFrameID,
  updateMessageHash,
} from './kikx-frame-scroll-lock.mjs';

// The focus frame is the frame the viewport is built around. While unpinned it
// is the frame named by the URL hash (falling back to the top visible frame).
// While pinned to the bottom it is the last rendered frame, so a new focus id
// means the conversation advanced and the driver may deliberately move it.
export function focusFrameID(app, frameList, { bottom = false } = {}) {
  if (bottom)
    return lastFrameID(frameList);
  return messageHashID() || topVisibleFrameID(app, frameList);
}

export function captureScrollFocus(app, frameList, { bottom = false } = {}) {
  let frameID = focusFrameID(app, frameList, { bottom });
  let focus = captureFrameListFocus(frameList, frameID);
  if (!focus)
    return null;

  focus.bottom = bottom;
  app._lastScrollFocus = focus;
  app._scrollFocusFrameID = focus.frameID;
  return focus;
}

// Synchronous snap used around a mutation: restore the exact top offset the
// focus frame had before the mutation. No rAF, no CSS transition, no native
// scroll anchoring.
export function restoreScrollFocus(app, frameList, focus) {
  if (!restoreFrameListFocus(frameList, focus))
    return false;

  app._ignoreFrameScrollUntil = Date.now() + 150;
  app._scrollFocusFrameID = focus.frameID;
  let measured = captureFrameListFocus(frameList, focus.frameID);
  if (measured) {
    // Keep the original target offset. Re-reading it after a partial layout tick
    // would turn transient drift into the new baseline and accumulate movement.
    measured.offset = focus.offset;
    measured.bottom = focus.bottom === true;
    app._lastScrollFocus = measured;
  }
  return true;
}

export function scrollFocusToTop(app, frameList, frameID, options = {}) {
  let item = findFrameItem(frameList, frameID);
  if (!item)
    return false;

  let target = () => clampScrollTop(frameList, frameItemTopWithinList(frameList, item));
  let done = () => {
    app._ignoreFrameScrollUntil = Date.now() + 150;
    app._scrollFocusFrameID = frameID;
    app._lastScrollFocus = captureFrameListFocus(frameList, frameID);
    if (app._lastScrollFocus)
      app._lastScrollFocus.bottom = options.bottom === true;
    updateMessageHash(app, frameID, { atBottom: options.bottom === true });
  };

  if (options.animate === true) {
    animateFrameListScroll(app, frameList, target, {
      duration: options.duration,
      onComplete: done,
    });
  } else {
    cancelFrameListScrollAnimation(app);
    app._ignoreFrameScrollUntil = Date.now() + 150;
    frameList.scrollTop = target();
    done();
  }
  return true;
}

// In bottom mode the last frame is the focus. Move to its top only when that
// focus id changed (a new message) or on the first placement. If the same last
// frame is still streaming and growing, do not move it: the user is looking at
// it and every mutation is restored to the same top offset.
export function alignLastFrameFocus(app, frameList, options = {}) {
  let frameID = lastFrameID(frameList);
  if (!frameID)
    return false;

  let previous = app._scrollFocusFrameID || '';
  let initial = options.initial === true;
  let changed = previous !== frameID;
  app._scrollFocusFrameID = frameID;
  if (!initial && !changed) {
    updateMessageHash(app, frameID, { atBottom: options.bottom === true });
    return false;
  }

  return scrollFocusToTop(app, frameList, frameID, {
    animate: initial ? false : options.animate !== false,
    bottom: options.bottom === true,
  });
}

export function alignBottomFocus(app, frameList, options = {}) {
  return alignLastFrameFocus(app, frameList, { ...options, bottom: true });
}

export function lastFrameID(frameList) {
  let items = frameList?.querySelectorAll?.('kikx-frame-item');
  return items?.[items.length - 1]?.dataset?.frameId || '';
}

export function findFrameItem(frameList, frameID) {
  if (!frameList || !frameID)
    return null;
  return [ ...frameList.querySelectorAll('kikx-frame-item') ]
    .find((candidate) => candidate.dataset.frameId === frameID) || null;
}

function clampScrollTop(frameList, top) {
  let max = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  return Math.min(Math.max(0, top), max);
}
