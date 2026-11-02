'use strict';

// Search-highlight lifecycle for a frame item. The custom element calls these
// functions through tiny wrappers; the DOM/search bookkeeping lives here so the
// controller stays under the hard source cap.

import { highlightSearchMatches } from '../lib/search-highlight.mjs';
import { frameMatchesQuery } from '../../shared/frame-window-filters.mjs';
import { visibleSearchHighlightCount } from './kikx-frame-item-helpers.mjs';

export function frameSearchQuery(item) {
  return String(item._appState?.sessionSearch || '');
}

export function frameSearchRoot(item) {
  return item._compact ? item._compactView?.element : item._contentElement;
}

export function highlightFrameSearch(item, root = frameSearchRoot(item)) {
  if (!root)
    return 0;

  let query = frameSearchQuery(item);
  if (query === '') {
    item._searchObserver?.disconnect();
    item._searchObserver = null;
    item._searchObserverRoot = null;
  }
  item._searchHighlighting = true;
  let count = 0;
  try {
    count = highlightSearchMatches(root, query);
    syncFrameSearchHint(item, visibleSearchHighlightCount(root));
  } finally {
    item._searchHighlighting = false;
  }
  return count;
}

export function syncFrameSearchHint(item, visibleCount = 0) {
  let summary = item._compactView?.summary;
  if (!summary)
    return;

  let query = frameSearchQuery(item);
  let hint = summary.querySelector?.('.kikx-search-match-hint') || null;
  let hiddenMatch = query !== '' && visibleCount === 0 && frameMatchesQuery(item._frame, query);
  if (!hiddenMatch) {
    hint?.remove();
    summary.classList.remove('has-search-match-hint');
    return;
  }

  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'kikx-search-match-hint';
    hint.title = 'The search match is inside this frame';
    summary.appendChild(hint);
  }
  summary.classList.add('has-search-match-hint');
  hint.textContent = item._compactView.element.open ? 'Match' : 'Match inside';
}

export function bindFrameSearchObserver(item) {
  let root = frameSearchRoot(item);
  if (!root)
    return;
  if (item._searchObserver && item._searchObserverRoot === root)
    return;

  item._searchObserver?.disconnect();
  item._searchObserver = null;
  item._searchObserverRoot = null;
  if (!frameSearchQuery(item) || typeof MutationObserver === 'undefined')
    return;

  item._searchObserverRoot = root;
  item._searchObserver = new MutationObserver(() => item._onSearchMutation());
  item._searchObserver.observe(root, { childList: true, subtree: true, characterData: true });
}

export function onFrameSearchMutation(item) {
  if (item._searchHighlighting || item._searchHighlightScheduled || !frameSearchQuery(item))
    return;

  item._searchHighlightScheduled = true;
  queueMicrotask(() => {
    item._searchHighlightScheduled = false;
    if (!item.isConnected || !frameSearchQuery(item))
      return;
    let root = frameSearchRoot(item);
    if (!root)
      return;
    item._searchObserver?.disconnect();
    highlightFrameSearch(item, root);
    if (item._searchObserver && item._searchObserverRoot === root)
      item._searchObserver.observe(root, { childList: true, subtree: true, characterData: true });
  });
}

export function onFrameContentToggle(item, event) {
  if (!event.target?.open || !frameSearchQuery(item))
    return;
  queueMicrotask(() => {
    if (!item.isConnected)
      return;
    highlightFrameSearch(item);
    bindFrameSearchObserver(item);
  });
}
