'use strict';

// Default allowed tags and their allowed attributes
const DEFAULT_ALLOWED_TAGS = {
  // Text formatting
  'b':          [],
  'i':          [],
  'em':         [],
  'strong':     [],
  'code':       ['class'],
  'pre':        ['class'],

  // Headings
  'h1':         ['id', 'class'],
  'h2':         ['id', 'class'],
  'h3':         ['id', 'class'],
  'h4':         ['id', 'class'],
  'h5':         ['id', 'class'],
  'h6':         ['id', 'class'],

  // Block elements
  'p':          ['class'],
  'div':        ['class', 'id'],
  'span':       ['class', 'id'],
  'blockquote': ['class'],
  'br':         [],
  'hr':         [],

  // Links and images
  'a':          ['href', 'title', 'target', 'rel', 'class'],
  'img':        ['src', 'alt', 'title', 'width', 'height', 'class'],

  // Lists
  'ul':         ['class'],
  'ol':         ['class', 'start', 'type'],
  'li':         ['class'],

  // Tables
  'table':      ['class'],
  'thead':      [],
  'tbody':      [],
  'tr':         [],
  'th':         ['class', 'colspan', 'rowspan'],
  'td':         ['class', 'colspan', 'rowspan'],

  // Custom elements (base set)
  'kikx-hml-prompt':  ['type', 'name', 'label', 'placeholder', 'value', 'required', 'min', 'max', 'step', 'options', 'default', 'class', 'id'],
  'kikx-hml-option':  ['value', 'label', 'selected', 'class'],
};

// Tags that get completely removed (tag + content)
const DANGEROUS_TAGS = new Set(['script', 'iframe', 'style', 'object', 'embed', 'applet', 'form', 'input', 'textarea', 'select', 'button']);

// Event handler attribute pattern
const EVENT_HANDLER_PATTERN = /^on[a-z]/i;

// JavaScript URI pattern
const JAVASCRIPT_URI_PATTERN = /^\s*javascript\s*:/i;

// URI attributes that need javascript: checking
const URI_ATTRIBUTES = new Set(['href', 'src', 'action']);

export class ContentSanitizer {
  constructor(options = {}) {
    this._allowedTags = { ...DEFAULT_ALLOWED_TAGS };
    this._dangerousTags = new Set(DANGEROUS_TAGS);

    // Apply any custom allowed tags from options
    if (options.allowedTags) {
      for (let [tag, attributes] of Object.entries(options.allowedTags))
        this._allowedTags[tag] = attributes;
    }
  }

  // Register a custom element (e.g., from a plugin)
  registerCustomElement(tagName, allowedAttributes = []) {
    this._allowedTags[tagName.toLowerCase()] = allowedAttributes;
  }

  // Remove a custom element from the allowlist
  unregisterCustomElement(tagName) {
    let lowerTag = tagName.toLowerCase();

    // Don't allow removing standard tags
    if (DEFAULT_ALLOWED_TAGS[lowerTag])
      return false;

    delete this._allowedTags[lowerTag];

    return true;
  }

  // Get all currently allowed tags
  getAllowedTags() {
    return { ...this._allowedTags };
  }

  // Main sanitize method
  sanitize(html) {
    if (!html || typeof html !== 'string')
      return '';

    // Step 1: Remove dangerous tags and their content entirely
    let result = this._removeDangerousTags(html);

    // Step 2: Process remaining tags
    result = this._processAllTags(result);

    return result;
  }

  // Remove dangerous tags and ALL their content
  _removeDangerousTags(html) {
    let result = html;

    for (let tag of this._dangerousTags) {
      // Match opening tag, content, and closing tag (non-greedy, case-insensitive)
      let pattern = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
      result = result.replace(pattern, '');

      // Also remove self-closing dangerous tags
      let selfClosing = new RegExp(`<${tag}[^>]*/?>`, 'gi');
      result = result.replace(selfClosing, '');
    }

    return result;
  }

  // Process all remaining tags: allow, strip, or sanitize
  _processAllTags(html) {
    // Match HTML tags (opening, closing, self-closing)
    return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*)?)\s*\/?>/g, (match, tagName, attributesString) => {
      let lowerTag = tagName.toLowerCase();
      let isClosing = match.startsWith('</');

      // If tag is not allowed, strip the tag but keep inner content
      if (!this._allowedTags.hasOwnProperty(lowerTag))
        return '';

      // Closing tags don't have attributes
      if (isClosing)
        return `</${lowerTag}>`;

      // Sanitize attributes
      let sanitizedAttributes = this._sanitizeAttributes(lowerTag, attributesString || '');
      let isSelfClosing = match.endsWith('/>') || this._isVoidElement(lowerTag);

      if (sanitizedAttributes)
        return (isSelfClosing) ? `<${lowerTag} ${sanitizedAttributes} />` : `<${lowerTag} ${sanitizedAttributes}>`;

      return (isSelfClosing) ? `<${lowerTag} />` : `<${lowerTag}>`;
    });
  }

  // Sanitize attributes for a given tag
  _sanitizeAttributes(tagName, attributesString) {
    let allowedAttributes = this._allowedTags[tagName] || [];

    if (!attributesString.trim())
      return '';

    let sanitized = [];

    // Parse attributes: name="value" or name='value' or name=value or name
    let attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let attributeMatch;

    while ((attributeMatch = attributePattern.exec(attributesString)) !== null) {
      let attributeName = attributeMatch[1].toLowerCase();
      let attributeValue = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? '';

      // Skip event handlers
      if (EVENT_HANDLER_PATTERN.test(attributeName))
        continue;

      // Skip non-allowed attributes
      if (!allowedAttributes.includes(attributeName))
        continue;

      // Check for javascript: URIs
      if (URI_ATTRIBUTES.has(attributeName) && JAVASCRIPT_URI_PATTERN.test(attributeValue))
        continue;

      // Escape the attribute value
      let escapedValue = attributeValue
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      sanitized.push(`${attributeName}="${escapedValue}"`);
    }

    return sanitized.join(' ');
  }

  _isVoidElement(tagName) {
    return ['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'].includes(tagName);
  }
}

// Convenience function
export function createSanitizer(options) {
  return new ContentSanitizer(options);
}

// Export defaults for testing
export { DEFAULT_ALLOWED_TAGS, DANGEROUS_TAGS };
