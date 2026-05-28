'use strict';

/** @type {Record<string, string[]>} Default allowed tags and their allowed attributes */
const DEFAULT_ALLOWED_TAGS = {
  'b':          [],
  'i':          [],
  'em':         [],
  'strong':     [],
  'code':       ['class'],
  'pre':        ['class'],
  'h1':         ['id', 'class'],
  'h2':         ['id', 'class'],
  'h3':         ['id', 'class'],
  'h4':         ['id', 'class'],
  'h5':         ['id', 'class'],
  'h6':         ['id', 'class'],
  'p':          ['class'],
  'div':        ['class', 'id'],
  'span':       ['class', 'id'],
  'blockquote': ['class'],
  'br':         [],
  'hr':         [],
  'a':          ['href', 'title', 'target', 'rel', 'class'],
  'img':        ['src', 'alt', 'title', 'width', 'height', 'class'],
  'ul':         ['class'],
  'ol':         ['class', 'start', 'type'],
  'li':         ['class'],
  'table':      ['class'],
  'thead':      [],
  'tbody':      [],
  'tr':         [],
  'th':         ['class', 'colspan', 'rowspan'],
  'td':         ['class', 'colspan', 'rowspan'],
  'kikx-hml-prompt':  ['type', 'name', 'label', 'placeholder', 'value', 'required', 'readonly', 'min', 'max', 'step', 'options', 'default', 'prompt-id', 'class', 'id'],
  'kikx-hml-option':  ['value', 'label', 'selected', 'class'],
};

/** @type {Set<string>} Tags that get completely removed (tag + content) */
const DANGEROUS_TAGS = new Set(['script', 'iframe', 'style', 'object', 'embed', 'applet', 'form', 'input', 'textarea', 'select', 'button']);

/** @type {RegExp} */
const EVENT_HANDLER_PATTERN = /^on[a-z]/i;

/** @type {RegExp} */
const JAVASCRIPT_URI_PATTERN = /^\s*javascript\s*:/i;

/** @type {Set<string>} URI attributes that need javascript: checking */
const URI_ATTRIBUTES = new Set(['href', 'src', 'action']);

export class ContentSanitizer {
  /**
   * @param {object} [options]
   * @param {Record<string, string[]>} [options.allowedTags]
   */
  constructor(options = {}) {
    /** @type {Record<string, string[]>} */
    this._allowedTags = { ...DEFAULT_ALLOWED_TAGS };
    /** @type {Set<string>} */
    this._dangerousTags = new Set(DANGEROUS_TAGS);

    if (options.allowedTags) {
      for (let [tag, attributes] of Object.entries(options.allowedTags))
        this._allowedTags[tag] = attributes;
    }
  }

  /**
   * Register a custom element (e.g., from a plugin).
   * @param {string} tagName
   * @param {string[]} [allowedAttributes]
   * @returns {void}
   */
  registerCustomElement(tagName, allowedAttributes = []) {
    this._allowedTags[tagName.toLowerCase()] = allowedAttributes;
  }

  /**
   * Remove a custom element from the allowlist.
   * @param {string} tagName
   * @returns {boolean}
   */
  unregisterCustomElement(tagName) {
    let lowerTag = tagName.toLowerCase();

    if (DEFAULT_ALLOWED_TAGS[lowerTag])
      return false;

    delete this._allowedTags[lowerTag];

    return true;
  }

  /**
   * Get all currently allowed tags.
   * @returns {Record<string, string[]>}
   */
  getAllowedTags() {
    return { ...this._allowedTags };
  }

  /**
   * Main sanitize method.
   * @param {string} html
   * @returns {string}
   */
  sanitize(html) {
    if (!html || typeof html !== 'string')
      return '';

    let result = this._removeDangerousTags(html);
    result = this._processAllTags(result);

    return result;
  }

  /**
   * Remove dangerous tags and ALL their content.
   * @param {string} html
   * @returns {string}
   */
  _removeDangerousTags(html) {
    let result = html;

    for (let tag of this._dangerousTags) {
      let pattern = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
      result = result.replace(pattern, '');

      let selfClosing = new RegExp(`<${tag}[^>]*/?>`, 'gi');
      result = result.replace(selfClosing, '');
    }

    return result;
  }

  /**
   * Process all remaining tags: allow, strip, or sanitize.
   * @param {string} html
   * @returns {string}
   */
  _processAllTags(html) {
    return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*)?)\s*\/?>/g, (match, tagName, attributesString) => {
      let lowerTag = tagName.toLowerCase();
      let isClosing = match.startsWith('</');

      if (!this._allowedTags.hasOwnProperty(lowerTag))
        return '';

      if (isClosing)
        return `</${lowerTag}>`;

      let sanitizedAttributes = this._sanitizeAttributes(lowerTag, attributesString || '');
      let isSelfClosing = match.endsWith('/>') || this._isVoidElement(lowerTag);

      if (sanitizedAttributes)
        return (isSelfClosing) ? `<${lowerTag} ${sanitizedAttributes} />` : `<${lowerTag} ${sanitizedAttributes}>`;

      return (isSelfClosing) ? `<${lowerTag} />` : `<${lowerTag}>`;
    });
  }

  /**
   * Sanitize attributes for a given tag.
   * @param {string} tagName
   * @param {string} attributesString
   * @returns {string}
   */
  _sanitizeAttributes(tagName, attributesString) {
    let allowedAttributes = this._allowedTags[tagName] || [];

    if (!attributesString.trim())
      return '';

    let sanitized = [];

    let attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let attributeMatch;

    while ((attributeMatch = attributePattern.exec(attributesString)) !== null) {
      let attributeName = attributeMatch[1].toLowerCase();
      let attributeValue = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? '';

      if (EVENT_HANDLER_PATTERN.test(attributeName))
        continue;

      if (!allowedAttributes.includes(attributeName))
        continue;

      if (URI_ATTRIBUTES.has(attributeName) && JAVASCRIPT_URI_PATTERN.test(attributeValue))
        continue;

      let decoded = attributeValue
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

      let escapedValue = decoded
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      sanitized.push(`${attributeName}="${escapedValue}"`);
    }

    return sanitized.join(' ');
  }

  /**
   * @param {string} tagName
   * @returns {boolean}
   */
  _isVoidElement(tagName) {
    return ['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'].includes(tagName);
  }
}

/**
 * Convenience function.
 * @param {object} [options]
 * @returns {ContentSanitizer}
 */
export function createSanitizer(options) {
  return new ContentSanitizer(options);
}

export { DEFAULT_ALLOWED_TAGS, DANGEROUS_TAGS };
