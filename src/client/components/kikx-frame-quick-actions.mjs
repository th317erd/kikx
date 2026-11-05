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

// Buttons are declared by frame classes, never assumed. A frame gets ONLY the
// buttons whose backing exists: every frame quotes (it always has visible
// text), but expand/collapse is offered only when the frame actually carries
// disclosures to toggle. `canExpand` is the frame class's own claim about the
// tree it renders — the toolbar is built while the subtree is detached, so the
// builder cannot probe the DOM itself.
//
// This is the fix for dead affordances: the unconditional expand button used
// to ship on every frame, and on a frame with zero <details> its click handler
// iterated an empty list and changed nothing — a control that could be clicked
// forever without effect.
export function quickActionSpecForFrame(frame, canExpand = false) {
  let spec = typeof frame?.getQuickActionButtons === 'function'
    ? frame.getQuickActionButtons()
    : null;
  if (!spec || typeof spec !== 'object')
    spec = {};
  return {
    quote: spec.quote !== false,
    // Copy ships only when there is message markdown to copy (owner,
    // 2026-11-06: "the important bits, not command output, and all that
    // nonsense"). A control that would copy nothing is a dead affordance.
    copy: spec.copy !== false && copyTextForFrame(frame) !== '',
    expand: spec.expand === true || (spec.expand !== false && canExpand),
  };
}

// What Copy puts on the clipboard: the frame's VISIBLE text — quote-parity
// (owner follow-up, 2026-11-05: "add this button pretty much everywhere
// (except for cases where it really does make no sense at all)"). The earlier
// type allowlist missed real messages (mood/progress/turn-report frames and
// friends); one definition with the Quote action fixes the coverage and keeps
// the two affordances from ever disagreeing about what a frame says.
//
// Priority does the filtering the owner asked for first: a MESSAGE copies its
// authored raw markdown (text/delta/summary keys) and only reaches command or
// output keys when those ARE the frame's visible content (tool rows). Frames
// with nothing to say resolve to '' and get no button at all — the only
// "makes no sense" case.
export function copyTextForFrame(frame) {
  return quoteTextForFrame(frame);
}

// Clipboard with a legacy fallback (older/embedded webviews, denied
// permission). Resolves true only when the text actually landed on the
// clipboard — the caller paints feedback from this.
export async function copyTextToClipboard(text) {
  if (typeof text !== 'string' || text === '')
    return false;

  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_error) {
    // fall through to the legacy path
  }

  try {
    let doc = globalThis.document;
    let area = doc?.createElement?.('textarea');
    if (!area)
      return false;
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    let ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
    area.remove();
    return ok === true;
  } catch (_error) {
    return false;
  }
}

// A frame's quick actions live just outside the frame surface. The frame item
// keeps one bar alive across in-place updates and swaps its `_frame` reference,
// so quoting always uses the current content rather than a stale render.
// `spec` carries only the buttons to build; frames that can expand opt in via
// getQuickActionButtons(), and the frame item passes canExpand when it has
// measured disclosures in the frame's own (detached) subtree.
export function buildFrameQuickActions(frame, ownerDocument = document, spec = quickActionSpecForFrame(frame)) {
  let toolbar = ownerDocument.createElement('div');
  toolbar.className = 'kikx-frame__quick-actions';
  toolbar._frame = frame;

  if (spec.quote !== false) {
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
  }

  // Copy (owner, 2026-11-06): "the standard double-paper copy icon... copy the
  // entire frame message... the raw markdown." Placed beside Quote, reading
  // toolbar._frame at CLICK time so an in-place stream update copies the
  // current text rather than the render-time snapshot. Feedback: the glyph
  // flips to a check for a beat, then returns.
  if (spec.copy) {
    let copy = ownerDocument.createElement('button');
    copy.type = 'button';
    copy.className = 'kikx-frame__quick-action kikx-frame__quick-action--copy';
    copy.title = 'Copy message';
    copy.setAttribute('aria-label', 'Copy message');
    copy.appendChild(createIcon('copy', { ownerDocument }));
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      let current = toolbar._frame;
      let text = copyTextForFrame(current);
      if (!text)
        return;

      copyTextToClipboard(text).then((ok) => {
        if (!ok) {
          copy.title = 'Copy failed';
          return;
        }
        setIcon(copy, 'check');
        // Owner, 2026-11-05: success green on the WHOLE button while the
        // check shows (styles: .kikx-frame__quick-action.is-copied).
        copy.classList.add('is-copied');
        copy.title = 'Copied!';
        clearTimeout(copy._copyResetTimer);
        copy._copyResetTimer = setTimeout(() => {
          if (!copy.isConnected)
            return;
          setIcon(copy, 'copy');
          copy.classList.remove('is-copied');
          copy.title = 'Copy message';
        }, 1400);
      });
    });

    toolbar.appendChild(copy);
  }

  // Built only when the frame declares it can toggle disclosures. A button
  // with nothing to expand must not be offered — see quickActionSpecForFrame.
  if (spec.expand === true) {
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
  }

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
