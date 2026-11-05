'use strict';

import { setMarkdownRawMode } from './markdown-renderer.mjs';
import { captureFrameListAnchor, restoreFrameListAnchor } from '../components/frame-scroll-anchor.mjs';

// Raw Markdown display mode. This is deliberately a view preference, not a
// document setting: switching it never edits a message, and it is local to the
// person using this browser.
//
// Owner correction (2026-11-05): the mode must yield SELECTABLE/COPYABLE
// markdown source — painted ::before markers are generated content that
// selection ignores. The renderer now emits the source as real text (see
// markdown-renderer.mjs); toggling refreshes the mounted frames IN PLACE
// (updateFrame force — no shell repaint, no network) inside the existing
// frame-anchor capture/restore, so the visible frame keeps its viewport offset
// while raw and rendered heights differ.
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
  setMarkdownRawMode(next);
  if (app?._state)
    app._state.rawMarkdown = next;
  // Still not a SHELL repaint: the class flips for residual styling and the
  // mounted frames re-render their CONTENT in place — bounded by the window,
  // once per explicit click; streaming updates follow the renderer flag from
  // then on. Repainting the shell would detach the thread and make a
  // view-only preference look like a page navigation.
  app?.classList?.toggle?.('kikx-raw-mode', next);
  for (let button of app?.querySelectorAll?.('.kikx-raw-toggle') || []) {
    button.classList.toggle('is-on', next);
    button.setAttribute('aria-pressed', next ? 'true' : 'false');
  }
  refreshMountedMarkdown(app);
  return next;
}

// Re-render the mounted frames' CONTENT against the new flag, preserving the
// visible frame's viewport offset: raw and rendered heights differ, so without
// the anchor restore the toggle would jump the thread.
function refreshMountedMarkdown(app) {
  if (!app?.querySelector)
    return;
  let frameList = app.querySelector('.kikx-frame-list');
  let view = app.querySelector('kikx-chat-view');
  let frames = view?.frames;
  if (!frameList || !Array.isArray(frames) || frames.length === 0)
    return;

  let anchor = captureFrameListAnchor(frameList);
  let byID = new Map(frames.map((frame) => [ frame?.id, frame ]));
  let updated = 0;
  for (let item of frameList.querySelectorAll('kikx-frame-item[data-frame-id]')) {
    let frame = byID.get(item.dataset.frameId);
    if (!frame)
      continue;
    item.updateFrame(frame, app?._state, { force: true });
    updated += 1;
  }
  if (updated > 0)
    restoreFrameListAnchor(frameList, anchor);
}

export function toggleRawMarkdown(app) {
  return setRawMarkdown(app, app?._state?.rawMarkdown !== true);
}
