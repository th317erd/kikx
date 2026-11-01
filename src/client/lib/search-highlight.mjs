'use strict';

// Search highlighting is a view decoration only. It never changes the query,
// the stored frame, or the filter predicate. Existing marks are removed before
// each pass so a live frame update cannot accumulate nested highlights.
export const SEARCH_HIGHLIGHT_CLASS = 'kikx-search-highlight';
const HIGHLIGHT_SELECTOR = `mark.${SEARCH_HIGHLIGHT_CLASS}`;
const SKIP_TAGS = new Set([ 'script', 'style', 'textarea', 'input', 'select' ]);

function normalizedTerms(query) {
  if (typeof query !== 'string')
    return [];
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/^\*+|\*+$/g, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function clearSearchHighlights(root) {
  if (!root?.querySelectorAll)
    return;
  for (let mark of [ ...root.querySelectorAll(HIGHLIGHT_SELECTOR) ]) {
    let parent = mark.parentNode;
    if (!parent)
      continue;
    while (mark.firstChild)
      parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
}

export function highlightSearchMatches(root, query) {
  if (!root)
    return 0;
  clearSearchHighlights(root);

  let terms = normalizedTerms(query);
  if (terms.length === 0 || typeof root.querySelectorAll !== 'function')
    return 0;

  let pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  let textNodes = [];
  collectTextNodes(root, textNodes);
  let count = 0;

  for (let node of textNodes) {
    let text = node.nodeValue || '';
    if (text === '' || !pattern.test(text))
      continue;
    pattern.lastIndex = 0;

    let fragment = node.ownerDocument.createDocumentFragment();
    let cursor = 0;
    for (let match of text.matchAll(pattern)) {
      let index = match.index ?? 0;
      if (index > cursor)
        fragment.appendChild(node.ownerDocument.createTextNode(text.slice(cursor, index)));
      let mark = node.ownerDocument.createElement('mark');
      mark.className = SEARCH_HIGHLIGHT_CLASS;
      mark.textContent = match[0];
      fragment.appendChild(mark);
      cursor = index + match[0].length;
      count++;
    }
    if (cursor < text.length)
      fragment.appendChild(node.ownerDocument.createTextNode(text.slice(cursor)));

    node.parentNode?.replaceChild(fragment, node);
  }
  return count;
}

function collectTextNodes(root, output) {
  for (let child of [ ...(root.childNodes || []) ]) {
    if (child.nodeType === 3) {
      output.push(child);
      continue;
    }
    if (child.nodeType !== 1)
      continue;
    let tag = child.localName || child.tagName?.toLowerCase?.() || '';
    if (SKIP_TAGS.has(tag) || child.matches?.(HIGHLIGHT_SELECTOR))
      continue;
    collectTextNodes(child, output);
  }
}
