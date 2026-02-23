'use strict';

// ============================================================================
// HTML to Markdown Converter
// ============================================================================
// Converts HTML to clean, readable Markdown using Turndown.
// Removes noise (scripts, styles, nav, ads) and preserves structure.

import TurndownService from 'turndown';

// Singleton instance
let turndown = null;

/**
 * Get or create the Turndown instance.
 */
function getTurndown() {
  if (turndown) return turndown;

  turndown = new TurndownService({
    headingStyle:     'atx',        // # style headings
    hr:               '---',
    bulletListMarker: '-',
    codeBlockStyle:   'fenced',
    emDelimiter:      '*',
    strongDelimiter:  '**',
    linkStyle:        'inlined',
  });

  // Remove script, style, nav, and other noise elements
  turndown.remove([
    'script',
    'style',
    'noscript',
    'iframe',
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'button',
    'input',
    'select',
    'textarea',
    'svg',
    'canvas',
    'video',
    'audio',
    'object',
    'embed',
  ]);

  // Custom rule for images - just show alt text
  turndown.addRule('images', {
    filter: 'img',
    replacement: (content, node) => {
      let alt = node.getAttribute('alt') || '';
      return alt ? `[Image: ${alt}]` : '';
    },
  });

  // Custom rule for links - keep text and URL
  turndown.addRule('links', {
    filter: 'a',
    replacement: (content, node) => {
      let href = node.getAttribute('href') || '';
      let text = content.trim();

      // Skip empty links or javascript: links
      if (!text || !href || href.startsWith('javascript:')) {
        return text;
      }

      // Skip anchor links
      if (href.startsWith('#')) {
        return text;
      }

      return `[${text}](${href})`;
    },
  });

  return turndown;
}

/**
 * Elements to remove before conversion (noise reduction).
 */
const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  '.nav',
  '.navigation',
  '.menu',
  '.sidebar',
  '.advertisement',
  '.ad',
  '.ads',
  '.cookie-banner',
  '.popup',
  '.modal',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
];

/**
 * Convert HTML to clean Markdown.
 *
 * @param {string} html - HTML string to convert
 * @param {Object} options - Options
 * @param {boolean} options.removeNoise - Remove nav, ads, etc. (default: true)
 * @param {number} options.maxLength - Maximum output length (default: 8000)
 * @returns {string} Markdown string
 */
export function htmlToMarkdown(html, options = {}) {
  let { removeNoise = true, maxLength = 8000 } = options;

  if (!html || typeof html !== 'string') {
    return '';
  }

  // Pre-clean the HTML if needed
  let cleanHtml = html;

  if (removeNoise) {
    // Use regex to remove common noise elements before parsing
    // This is faster than DOM manipulation for simple cases
    cleanHtml = cleanHtml
      // Remove script tags and content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Remove style tags and content
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, '')
      // Remove noscript
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
  }

  // Convert to markdown
  let td = getTurndown();
  let markdown;

  try {
    markdown = td.turndown(cleanHtml);
  } catch (e) {
    // Fallback: strip all HTML tags
    markdown = cleanHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Clean up the markdown
  markdown = markdown
    // Remove excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    // Remove lines that are just whitespace
    .replace(/^\s+$/gm, '')
    // Trim
    .trim();

  // Truncate if too long
  if (markdown.length > maxLength) {
    markdown = markdown.slice(0, maxLength) + '\n\n[Content truncated...]';
  }

  return markdown;
}

/**
 * Extract and convert main content from a page.
 * Tries to find the main content area first.
 *
 * @param {string} html - Full page HTML
 * @param {string} selector - CSS selector for content (default: auto-detect)
 * @param {Object} options - Options passed to htmlToMarkdown
 * @returns {string} Markdown string
 */
export function extractContent(html, selector = null, options = {}) {
  // If a specific selector is provided, we need DOM parsing
  // For now, just use the full HTML with noise removal
  return htmlToMarkdown(html, { removeNoise: true, ...options });
}

/**
 * Get noise selectors for use in page.evaluate().
 */
export function getNoiseSelectors() {
  return NOISE_SELECTORS;
}

export default {
  htmlToMarkdown,
  extractContent,
  getNoiseSelectors,
};
