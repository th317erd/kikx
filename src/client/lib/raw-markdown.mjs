'use strict';

// Raw Markdown display mode. This is deliberately a view preference, not a
// document setting: switching it never edits a message, and it is local to the
// person using this browser.
export const RAW_MARKDOWN_STORAGE_KEY = 'kikx.rawMarkdown';

export function readRawMarkdown() {
  try {
    return globalThis.localStorage?.getItem(RAW_MARKDOWN_STORAGE_KEY) === '1';
  } catch (_error) {
    return false;
  }
}

export function writeRawMarkdown(enabled) {
  try {
    if (enabled)
      globalThis.localStorage?.setItem(RAW_MARKDOWN_STORAGE_KEY, '1');
    else
      globalThis.localStorage?.removeItem(RAW_MARKDOWN_STORAGE_KEY);
  } catch (_error) {}
}

export function setRawMarkdown(app, enabled) {
  let next = enabled === true;
  if (app?._state?.rawMarkdown === next)
    return next;

  writeRawMarkdown(next);
  if (app?._state)
    app._state.rawMarkdown = next;
  // This is deliberately a class toggle, not a shell repaint. Repainting
  // detaches the thread, loses the scroll position and makes a view-only
  // preference look like a page navigation. CSS supplies the syntax marks.
  app?.classList?.toggle?.('kikx-raw-mode', next);
  for (let button of app?.querySelectorAll?.('.kikx-raw-toggle') || []) {
    button.classList.toggle('is-on', next);
    button.setAttribute('aria-pressed', next ? 'true' : 'false');
  }
  return next;
}

export function toggleRawMarkdown(app) {
  return setRawMarkdown(app, app?._state?.rawMarkdown !== true);
}
