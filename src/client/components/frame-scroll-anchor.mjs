'use strict';

// A viewport anchor is one frame plus the signed distance from the scroll
// viewport's top edge to that frame's top edge. ScrollTop alone is not an
// anchor: the same scrollTop names a different message after a prepend, a
// render-window shift, or a collapsed frame changes height. The offset can be
// negative when the frame starts above the viewport (common at the true bottom
// of a tall last message).
export function captureFrameListAnchor(frameList) {
  let focus = captureFrameListFocus(frameList);
  return focus ? { frameID: focus.frameID, offset: focus.offset } : null;
}

export function captureFrameListFocus(frameList, preferredFrameID = '') {
  if (!frameList || typeof frameList.getBoundingClientRect !== 'function')
    return null;

  let items = [ ...frameList.querySelectorAll('kikx-frame-item') ];
  if (items.length === 0)
    return null;

  let listRect = frameList.getBoundingClientRect();
  let item = preferredFrameID
    ? items.find((candidate) => candidate.dataset.frameId === preferredFrameID)
    : null;
  item ||= items.find((candidate) => candidate.getBoundingClientRect().bottom > listRect.top + 1) || items.at(-1);
  if (!item)
    return null;

  let itemRect = item.getBoundingClientRect();
  return {
    frameID: item.dataset.frameId || '',
    item,
    offset: itemRect.top - listRect.top,
    scrollTop: Number(frameList.scrollTop) || 0,
    scrollHeight: Number(frameList.scrollHeight) || 0,
    clientHeight: Number(frameList.clientHeight) || 0,
  };
}

export function restoreFrameListAnchor(frameList, anchor) {
  if (!frameList || !anchor?.frameID || typeof frameList.getBoundingClientRect !== 'function')
    return false;

  let item = [ ...frameList.querySelectorAll('kikx-frame-item') ]
    .find((candidate) => candidate.dataset.frameId === anchor.frameID);
  if (!item)
    return false;

  let listRect = frameList.getBoundingClientRect();
  let itemRect = item.getBoundingClientRect();
  let target = frameList.scrollTop + itemRect.top - listRect.top - anchor.offset;
  let max = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  frameList.scrollTop = Math.min(Math.max(0, target), max);
  return true;
}

// Re-apply a focus captured before a DOM/layout mutation. This is the
// synchronous "snap": no animation, no browser scroll anchoring, no visible
// movement of the focused frame.
export function restoreFrameListFocus(frameList, focus) {
  if (!frameList || !focus?.frameID || typeof frameList.getBoundingClientRect !== 'function')
    return false;

  let item = focus.item?.isConnected === true && focus.item.dataset?.frameId === focus.frameID
    ? focus.item
    : [ ...frameList.querySelectorAll('kikx-frame-item') ]
      .find((candidate) => candidate.dataset.frameId === focus.frameID);
  if (!item)
    return false;

  let target = frameItemTopWithinList(frameList, item) - focus.offset;
  let max = Math.max(0, frameList.scrollHeight - frameList.clientHeight);
  frameList.scrollTop = Math.min(Math.max(0, target), max);
  return true;
}

// Top of a frame in scrollTop coordinates. offsetTop is preferred because it
// excludes the entry animation's transform; getBoundingClientRect() would chase
// the current scroll position while a card is still animating in.
export function frameItemTopWithinList(frameList, item) {
  if (!frameList || !item)
    return 0;
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
