'use strict';

import { createIcon, setIcon } from '../lib/icons.mjs';

export const QUOTE_FRAME_EVENT = 'kikx-quote-frame';

function depth(node) {
  let count = 0;
  let parent = node.parentNode;
  while (parent) {
    count += 1;
    parent = parent.parentNode;
  }
  return count;
}

function allDetails(root) {
  if (!root)
    return [];
  return [ ...root.querySelectorAll('details') ];
}

export function isFrameExpandedState(root) {
  return allDetails(root).some((details) => details.open === true);
}

function syncExpandCollapseIcon(button, root) {
  if (!button)
    return;
  setIcon(button, isFrameExpandedState(root) ? 'unfold-less' : 'unfold-more');
}

export function syncExpandCollapseButton(toolbar) {
  if (!toolbar)
    return;
  let button = toolbar.querySelector('.kikx-frame__quick-action--expand-collapse');
  syncExpandCollapseIcon(button, toolbar.parentNode);
}

function toggleAll(root, button) {
  let details = allDetails(root).sort((a, b) => depth(a) - depth(b));
  let expanded = details.some((node) => node.open === true);

  if (expanded) {
    [ ...details ].reverse().forEach((node) => {
      if (node.open !== true)
        return;
      node.open = false;
      node.dispatchEvent(new Event('toggle', { bubbles: true }));
    });
  } else {
    details.forEach((node) => {
      if (node.open === true)
        return;
      node.open = true;
      node.dispatchEvent(new Event('toggle', { bubbles: true }));
    });
  }

  syncExpandCollapseIcon(button, root);
}

// A frame's quick actions live just outside the frame surface. The frame item
// keeps one bar alive across in-place updates and swaps its `_frame` reference,
// so quoting always uses the current content rather than a stale render.
export function buildFrameQuickActions(frame, ownerDocument = document) {
  let toolbar = ownerDocument.createElement('div');
  toolbar.className = 'kikx-frame__quick-actions';
  toolbar._frame = frame;

  let quote = ownerDocument.createElement('button');
  quote.type = 'button';
  quote.className = 'kikx-frame__quick-action kikx-frame__quick-action--quote';
  quote.title = 'Quote frame';
  quote.setAttribute('aria-label', 'Quote frame');
  quote.appendChild(createIcon('reply', { ownerDocument }));
  quote.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    let current = toolbar._frame;
    if (!current?.id)
      return;

    toolbar.dispatchEvent(new CustomEvent(QUOTE_FRAME_EVENT, {
      bubbles: true,
      composed: true,
      detail: {
        frameID: current.id,
        text: quoteTextForFrame(current),
      },
    }));
  });

  toolbar.appendChild(quote);

  let expandCollapse = ownerDocument.createElement('button');
  expandCollapse.type = 'button';
  expandCollapse.className = 'kikx-frame__quick-action kikx-frame__quick-action--expand-collapse';
  expandCollapse.title = 'Expand/collapse';
  expandCollapse.setAttribute('aria-label', 'Expand/collapse');
  expandCollapse.appendChild(createIcon('unfold-more', { ownerDocument }));
  expandCollapse.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleAll(toolbar.parentNode, expandCollapse);
  });

  toolbar.appendChild(expandCollapse);

  return toolbar;
}

export function quoteTextForFrame(frame) {
  let content = frame?.content;
  if (!content)
    return '';

  // Collapsed turn reports show their short summary, so quote what the user
  // can actually see rather than the hidden long report.
  if (content.turnReport === true && typeof content.summary === 'string' && content.summary.trim() !== '')
    return content.summary.trim();

  for (let key of [ 'text', 'delta', 'summary', 'output', 'message', 'thinkingText' ]) {
    let value = content[key];
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim();
  }

  let input = content.input;
  if (typeof input === 'string' && input.trim() !== '')
    return input.trim();
  if (typeof input?.command === 'string' && input.command.trim() !== '')
    return input.command.trim();
  if (typeof input?.path === 'string' && input.path.trim() !== '')
    return input.path.trim();

  if (typeof frame.contentText === 'string' && frame.contentText.trim() !== '')
    return frame.contentText.trim();

  return typeof content.toolName === 'string' ? content.toolName : '';
}
