'use strict';

// =============================================================================
// MarkdownConverter — converts markdown text to sanitized HTML
// =============================================================================
// Wraps `marked` with the project's ContentSanitizer to produce safe HTML
// from user-supplied markdown. Registered on CascadingContext as
// `markdownConverter` so plugins and internal services can use it.
// =============================================================================

import { Marked } from 'marked';

export class MarkdownConverter {
  constructor(sanitizer) {
    this._sanitizer = sanitizer || null;

    // Configure marked for safe, predictable output
    this._marked = new Marked({
      gfm:    true,
      breaks: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Convert markdown text to sanitized HTML.
   *
   * @param  {string} text  Raw markdown text
   * @return {string}       Sanitized HTML string
   */
  convert(text) {
    if (!text || typeof text !== 'string')
      return '';

    let html = this._marked.parse(text);

    // Sanitize through the project's ContentSanitizer if available
    if (this._sanitizer)
      html = this._sanitizer.sanitize(html);

    return html;
  }
}

// Convenience factory
export function createMarkdownConverter(sanitizer) {
  return new MarkdownConverter(sanitizer);
}
