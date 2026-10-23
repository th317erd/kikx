'use strict';

// A viewport anchor is the message touching the top edge plus its signed
// offset. ScrollTop alone is not an anchor: the same scrollTop names a
// different message after a prepend, a render-window shift, or a collapsed
// frame changes height. The offset can be negative when the message starts
// above the viewport (common at the true bottom of a tall last message).
export function captureFrameListAnchor(frameList) {
  if (!frameList || typeof frameList.getBoundingClientRect !== 'function')
    return null;

  let items = [ ...frameList.querySelectorAll('kikx-frame-item') ];
  if (items.length === 0)
    return null;

  let listRect = frameList.getBoundingClientRect();
  let item = items.find((candidate) => candidate.getBoundingClientRect().bottom > listRect.top + 1) || items.at(-1);
  if (!item)
    return null;

  return {
    frameID: item.dataset.frameId || '',
    offset: item.getBoundingClientRect().top - listRect.top,
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
