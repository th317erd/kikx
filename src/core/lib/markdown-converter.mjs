'use strict';

// =============================================================================
// MarkdownConverter — converts markdown text to sanitized HTML
// =============================================================================

import { Marked } from 'marked';

export class MarkdownConverter {
  /**
   * @param {import('./content-sanitizer.mjs').ContentSanitizer|null} [sanitizer]
   */
  constructor(sanitizer) {
    /** @type {import('./content-sanitizer.mjs').ContentSanitizer|null} */
    this._sanitizer = sanitizer || null;

    /** @type {Marked} */
    this._marked = new Marked({
      gfm:    true,
      breaks: true,
    });
  }

  /**
   * Convert markdown text to sanitized HTML.
   * @param {string} text - Raw markdown text
   * @returns {string} Sanitized HTML string
   */
  convert(text) {
    if (!text || typeof text !== 'string')
      return '';

    let html = this._marked.parse(text);

    if (this._sanitizer)
      html = this._sanitizer.sanitize(html);

    return html;
  }
}

/**
 * Convenience factory.
 * @param {import('./content-sanitizer.mjs').ContentSanitizer|null} [sanitizer]
 * @returns {MarkdownConverter}
 */
export function createMarkdownConverter(sanitizer) {
  return new MarkdownConverter(sanitizer);
}
