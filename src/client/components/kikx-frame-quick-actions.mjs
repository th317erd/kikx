'use strict';

import { createIcon } from '../lib/icons.mjs';

export const QUOTE_FRAME_EVENT = 'kikx-quote-frame';

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
