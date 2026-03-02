'use strict';

import TurndownService from 'turndown';

// =============================================================================
// HTML to Markdown
// =============================================================================
// Converts HTML content to markdown using Turndown.
// Strips non-content elements (script, style, nav, footer, header, aside)
// before conversion to produce clean, readable markdown.
// =============================================================================

export function htmlToMarkdown(html) {
  if (!html || typeof html !== 'string')
    return '';

  let turndown = new TurndownService({
    headingStyle:   'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  // Remove non-content elements
  turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'aside']);

  return turndown.turndown(html);
}
