'use strict';

import { setIcon } from '../lib/icons.mjs';

const STORAGE_PREFIX = 'kikx.scrollLock.';
const MODE_PREFIX = 'kikx.scrollLockMode.';
const DEFAULT_LOCKED = true;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch (_error) {
    return null;
  }
}

function key(sessionID) {
  return `${STORAGE_PREFIX}${sessionID}`;
}

function modeKey(sessionID) {
  return `${MODE_PREFIX}${sessionID}`;
}

export function isScrollLockedForSession(app, sessionID = app?._state?.selectedSessionID) {
  if (!sessionID)
    return false;

  let value;
  try {
    value = storage()?.getItem?.(key(sessionID));
  } catch (_error) {
    value = null;
  }
  return value == null ? DEFAULT_LOCKED : value !== '0';
}

export function getScrollLockModeForSession(app, sessionID = app?._state?.selectedSessionID) {
  if (!sessionID)
    return 'top';
  let value;
  try {
    value = storage()?.getItem?.(modeKey(sessionID));
  } catch (_error) {
    value = null;
  }
  return value === 'bottom' ? 'bottom' : 'top';
}

export function setScrollLockModeForSession(app, mode, sessionID = app?._state?.selectedSessionID) {
  if (!sessionID)
    return 'top';
  let next = mode === 'bottom' ? 'bottom' : 'top';
  if (next !== 'bottom')
    app._pendingScrollFocus = null;
  try {
    storage()?.setItem?.(modeKey(sessionID), next);
  } catch (_error) {}
  paintScrollLockButton(app, sessionID, isScrollLockedForSession(app, sessionID));
  return next;
}

export function setScrollLockedForSession(app, locked, sessionID = app?._state?.selectedSessionID) {
  if (!sessionID)
    return false;

  let next = locked === true;
  if (!next)
    app._pendingScrollFocus = null;
  try {
    storage()?.setItem?.(key(sessionID), next ? '1' : '0');
  } catch (_error) {}
  paintScrollLockButton(app, sessionID, next);
  return next;
}

export function toggleScrollLockForSession(app, sessionID = app?._state?.selectedSessionID) {
  return setScrollLockedForSession(app, !isScrollLockedForSession(app, sessionID), sessionID);
}

// Reserved session toolbar in the window header. The scroll-lock control now
// floats over the thread viewport, but the header slot stays in place for the
// next session-level tools.
export function buildScrollLockToolbar(_app, _sessionID) {
  let toolbar = document.createElement('div');
  toolbar.className = 'kikx-session-toolbar';
  return toolbar;
}

export function buildScrollLockFloatingButton(app, sessionID) {
  let locked = isScrollLockedForSession(app, sessionID);
  let mode = getScrollLockModeForSession(app, sessionID);
  let button = document.createElement('button');
  button.type = 'button';
  button.className = 'kikx-session-toolbar__button kikx-session-toolbar__button--lock kikx-scroll-lock-floating';
  button.setAttribute('aria-pressed', locked ? 'true' : 'false');
  button.title = scrollLockTitle(locked, mode);
  button.setAttribute('aria-label', button.title);
  setIcon(button, locked ? 'lock-locked' : 'lock-unlocked');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    app._toggleScrollLock?.();
  });
  return button;
}

export function paintScrollLockButton(app, sessionID = app?._state?.selectedSessionID, locked = null) {
  let button = app?.querySelector?.('.kikx-session-toolbar__button--lock');
  if (!button)
    return;

  let next = locked == null ? isScrollLockedForSession(app, sessionID) : locked === true;
  let mode = getScrollLockModeForSession(app, sessionID);
  let title = scrollLockTitle(next, mode);
  let icon = next ? 'lock-locked' : 'lock-unlocked';
  let pressed = next ? 'true' : 'false';
  // Frame/lock updates can arrive several times in one batch. Replacing the
  // SVG and rewriting four attributes each time is pure DOM churn; leave an
  // already-correct button alone.
  if (button.getAttribute('aria-pressed') === pressed
    && button.title === title
    && button.getAttribute('aria-label') === title
    && button.dataset.icon === icon)
    return;
  button.setAttribute('aria-pressed', pressed);
  button.title = title;
  button.setAttribute('aria-label', title);
  setIcon(button, icon);
}

function scrollLockTitle(locked, mode) {
  if (!locked)
    return 'Scroll unlocked';
  return mode === 'bottom' ? 'Scroll locked to the bottom' : 'Scroll locked to the latest message';
}
