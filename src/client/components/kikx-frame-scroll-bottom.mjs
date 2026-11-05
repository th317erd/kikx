'use strict';

// Bottom-follow primitives and near-bottom geometry. Split from the render
// controller so the scroll module stays under the source cap.

import { scheduleAnimationFrame } from './kikx-app-helpers.mjs';
import { ANCHOR_THRESHOLD } from './frame-scroll-constants.mjs';
import { restoreFrameListAnchor } from './frame-scroll-anchor.mjs';
import { markFrameListProgrammaticWrite } from './frame-scroll-programmatic.mjs';
import { captureScrollFocus, lastFrameID } from './scroll-focus.mjs';
import { cancelFrameListScrollAnimation, updateMessageHash } from './kikx-frame-scroll-lock.mjs';

export function isFrameListScrollable(frameList) {
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
      markFrameListProgrammaticWrite(frameList, 220);
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
    markFrameListProgrammaticWrite(frameList, 220);
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
  markFrameListProgrammaticWrite(frameList, 220);
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
  markFrameListProgrammaticWrite(frameList, 220);
  frameList.scrollTop = Math.min(Math.max(0, snapshot.frameListScrollTop || 0), maxScrollTop);
}
