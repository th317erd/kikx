'use strict';

import { scheduleAnimationFrame } from './kikx-app-helpers.mjs';
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

// A new bottom focus must survive its frame-entry animation. At the moment the
// frame is inserted it may be only a few pixels tall, so a one-shot alignment
// clamps to the old bottom and then the frame grows off-screen. Keep the new
// focus pending and re-aim it while its layout settles. Once stable, stop.
export function startFocusAlignment(app, frameList, frameID, { bottom = false } = {}) {
  cancelFocusAlignment(app);
  app._pendingScrollFocus = {
    frameID,
    bottom,
    startedAt: Date.now(),
    stableFrames: 0,
    lastHeight: -1,
    frameScheduled: false,
  };
  stepFocusAlignment(app, frameList);
}

export function stepFocusAlignment(app, frameList = app.querySelector?.('.kikx-frame-list')) {
  let pending = app._pendingScrollFocus;
  if (!pending || !frameList)
    return false;

  let item = findFrameItem(frameList, pending.frameID);
  if (!item) {
    if (Date.now() - pending.startedAt > 1500) {
      cancelFocusAlignment(app);
      return false;
    }
    scheduleFocusAlignmentStep(app, frameList, pending);
    return true;
  }

  let itemTop = frameItemTopWithinList(frameList, item);
  let itemHeight = Number(item.offsetHeight) || Number(item.getBoundingClientRect?.().height) || 0;
  let max = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  // If the whole frame fits, clamp to the bottom so it is fully visible. If it
  // cannot fit, min() picks the frame top and aligns that with the viewport top.
  let target = Math.min(Math.max(0, itemTop), max);
  app._ignoreFrameScrollUntil = Date.now() + 150;
  frameList.scrollTop = target;

  if (Math.abs(itemHeight - pending.lastHeight) < 0.5)
    pending.stableFrames += 1;
  else
    pending.stableFrames = 0;
  pending.lastHeight = itemHeight;

  // The frame entry animation is a height transition. Until it clears, the
  // frame's final height is unknown, so keep re-aiming instead of declaring a
  // few-pixel insertion height "stable" and then letting the frame grow off
  // screen.
  let animating = item.classList?.contains('kikx-frame--animating') === true
    || item.classList?.contains('kikx-frame--entering') === true;
  if ((!animating && pending.stableFrames >= 2) || Date.now() - pending.startedAt > 1500) {
    app._pendingScrollFocus = null;
    app._scrollFocusFrameID = pending.frameID;
    let focus = captureFrameListFocus(frameList, pending.frameID);
    if (focus) {
      focus.bottom = pending.bottom === true;
      app._lastScrollFocus = focus;
    }
    updateMessageHash(app, pending.frameID, { atBottom: pending.bottom === true });
    return true;
  }

  scheduleFocusAlignmentStep(app, frameList, pending);
  return true;
}

export function cancelFocusAlignment(app) {
  app._pendingScrollFocus = null;
}

function scheduleFocusAlignmentStep(app, frameList, pending) {
  if (pending.frameScheduled)
    return;
  pending.frameScheduled = true;
  scheduleAnimationFrame(() => {
    if (app._pendingScrollFocus !== pending)
      return;
    pending.frameScheduled = false;
    stepFocusAlignment(app, frameList);
  });
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
  if (app._pendingScrollFocus?.frameID === frameID) {
    stepFocusAlignment(app, frameList);
    return true;
  }

  app._scrollFocusFrameID = frameID;
  if (!initial && !changed) {
    updateMessageHash(app, frameID, { atBottom: options.bottom === true });
    return false;
  }

  if (options.bottom === true) {
    startFocusAlignment(app, frameList, frameID, { bottom: true });
    return true;
  }

  return scrollFocusToTop(app, frameList, frameID, {
    animate: initial ? false : options.animate !== false,
    bottom: false,
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
