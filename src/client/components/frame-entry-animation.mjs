'use strict';

// Entry animation for NEWLY MOUNTED frame items — shared by both insertion
// paths: chat-view's cursor inserter (stream sync) and the paged scrollview's
// live-append flush (appendItem → source.renderItem). The classes must exist
// AT INSERTION (prepare before the node reaches the DOM, start on the next
// frame), which is exactly the contract the color/entry stagehand observer
// samples and the transition needs. Extracted from kikx-chat-view because the
// paged path cannot import its module-private helpers (chat-view already
// imports chat-scrollview — a back-import would be circular).

import { scheduleAnimationFrame } from './kikx-app-helpers.mjs';

const FRAME_ENTER_ANIMATION_MS = 220;

export function prepareFrameEntryAnimation(item) {
  if (!item || prefersReducedMotion())
    return;

  item.classList.add('kikx-frame--animating', 'kikx-frame--entering');
}

export function startFrameEntryAnimation(item) {
  if (!item || prefersReducedMotion())
    return;

  scheduleAnimationFrame(() => {
    item.classList.remove('kikx-frame--entering');
    let finish = () => item.classList.remove('kikx-frame--animating');
    item.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, FRAME_ENTER_ANIMATION_MS + 80);
  });
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
