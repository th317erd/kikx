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
  app?.classList?.toggle?.('kikx-raw-mode', next);
  app?._render?.();
  return next;
}

export function toggleRawMarkdown(app) {
  return setRawMarkdown(app, app?._state?.rawMarkdown !== true);
}
