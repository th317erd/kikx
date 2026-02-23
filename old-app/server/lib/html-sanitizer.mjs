'use strict';

import { JSDOM } from 'jsdom';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Tags that are allowed to pass through unchanged.
 */
const ALLOWED_TAGS = new Set([
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Structure
  'p', 'br', 'hr', 'div', 'span',
  // Inline formatting
  'b', 'strong', 'i', 'em', 'u', 's', 'mark', 'code', 'small', 'sub', 'sup',
  // Block elements
  'pre', 'blockquote',
  // Lists
  'ul', 'ol', 'li',
  // Links and media
  'a', 'img',
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  // Custom HML elements
  'hml-prompt', 'hml-thinking', 'response', 'data',
  // Option elements for hml-prompt
  'option',
]);

/**
 * Tags that should be removed completely (tag AND content).
 * These are dangerous or used for system protocol.
 */
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'embed', 'object', 'style', 'base', 'meta',
  'form', 'input', 'button', 'textarea', 'select',
  'math', 'noscript', 'template', 'slot',
  'interaction', // System protocol tag - never display
]);

/**
 * Allowed attributes per tag.
 * '*' key applies to all allowed tags.
 */
const ALLOWED_ATTRS = {
  '*':           ['id', 'class', 'title'],
  'a':           ['href', 'target', 'rel'],
  'img':         ['src', 'alt', 'width', 'height', 'loading'],
  'td':          ['colspan', 'rowspan'],
  'th':          ['colspan', 'rowspan'],
  'code':        ['class'], // For syntax highlighting hints
  'hml-prompt':  ['id', 'type', 'min', 'max', 'step', 'default', 'answered', 'value'],
  'hml-thinking': ['title'],
  'option':       ['value', 'selected'],
};

/**
 * Event handler attributes to always strip.
 */
const EVENT_HANDLERS = new Set([
  'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmouseover',
  'onmousemove', 'onmouseout', 'onmouseenter', 'onmouseleave',
  'onkeydown', 'onkeyup', 'onkeypress',
  'onfocus', 'onblur', 'onchange', 'oninput', 'onsubmit', 'onreset',
  'onselect', 'onload', 'onerror', 'onabort', 'onunload', 'onresize',
  'onscroll', 'oncontextmenu', 'ondrag', 'ondragend', 'ondragenter',
  'ondragleave', 'ondragover', 'ondragstart', 'ondrop',
  'oncopy', 'oncut', 'onpaste', 'onwheel', 'ontouchstart', 'ontouchend',
  'ontouchmove', 'ontouchcancel', 'onanimationstart', 'onanimationend',
  'onanimationiteration', 'ontransitionend', 'onpointerdown', 'onpointerup',
  'onpointermove', 'onpointerenter', 'onpointerleave', 'onpointercancel',
  'onbegin', 'onend', 'onrepeat', // SVG-specific
]);

/**
 * Other dangerous attributes to always strip.
 */
const DANGEROUS_ATTRS = new Set([
  'style',       // Inline CSS can be used for attacks
  'formaction',  // Form hijacking
  'xlink:href',  // SVG links (can be javascript:)
  'srcdoc',      // Iframe content
  'sandbox',     // Can weaken security
]);

// =============================================================================
// Main Sanitizer Function
// =============================================================================

/**
 * Sanitize HTML content.
 *
 * - Allowed tags pass through with allowed attributes
 * - Unknown tags are stripped but content is preserved
 * - Dangerous tags are removed completely (tag and content)
 * - Dangerous attributes are stripped
 * - Dangerous URLs (javascript:, data:text/html) are neutralized
 *
 * @param {string} html - Raw HTML string
 * @returns {string} Sanitized HTML string
 */
export function sanitizeHtml(html) {
  if (html == null || html === '')
    return '';

  // Handle non-string input (e.g., Anthropic API content arrays)
  if (typeof html !== 'string') {
    if (Array.isArray(html)) {
      // Extract text from content block array
      html = html
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text || '')
        .join('');
    } else if (typeof html === 'object') {
      // Single content block
      if (html.type === 'text' && html.text) {
        html = html.text;
      } else {
        console.warn('[sanitizeHtml] Received non-string, non-array content:', typeof html);
        return '';
      }
    } else {
      return '';
    }
  }

  // Parse HTML into DOM
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const document = dom.window.document;
  const body = document.body;

  // Remove comments
  removeComments(body);

  // Process all elements (must iterate in reverse to handle removals)
  sanitizeNode(body, document);

  // Return the sanitized HTML
  return body.innerHTML;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Remove all comment nodes from a container.
 */
function removeComments(container) {
  const walker = container.ownerDocument.createTreeWalker(
    container,
    128, // NodeFilter.SHOW_COMMENT
    null,
    false
  );

  const comments = [];
  while (walker.nextNode())
    comments.push(walker.currentNode);

  for (const comment of comments)
    comment.remove();
}

/**
 * Recursively sanitize a node and its children.
 */
function sanitizeNode(node, document) {
  // Process children first (in reverse order to handle removals safely)
  const children = Array.from(node.childNodes);

  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];

    if (child.nodeType === 1) { // Element node
      const tagName = child.tagName.toLowerCase();

      if (DANGEROUS_TAGS.has(tagName)) {
        // Remove dangerous tags completely
        child.remove();
      } else if (ALLOWED_TAGS.has(tagName)) {
        // Allowed tag - sanitize attributes and recurse
        sanitizeAttributes(child, tagName);
        sanitizeNode(child, document);
      } else {
        // Unknown tag - unwrap (keep content, remove tag)
        unwrapElement(child, document);
        // Re-process this position since we replaced the element
        // The unwrapped children are now at this position
      }
    } else if (child.nodeType === 3) {
      // Text node - keep as-is
    } else if (child.nodeType === 8) {
      // Comment node - remove
      child.remove();
    } else if (child.nodeType === 4) {
      // CDATA section - remove
      child.remove();
    }
  }

  // After processing children, re-process to catch unwrapped elements
  // This handles the case where unwrapping exposed new elements
  const newChildren = Array.from(node.childNodes);
  for (let i = newChildren.length - 1; i >= 0; i--) {
    const child = newChildren[i];

    if (child.nodeType === 1) {
      const tagName = child.tagName.toLowerCase();

      if (DANGEROUS_TAGS.has(tagName)) {
        child.remove();
      } else if (!ALLOWED_TAGS.has(tagName)) {
        unwrapElement(child, document);
      }
    }
  }
}

/**
 * Unwrap an element, keeping its children in place.
 */
function unwrapElement(element, document) {
  const parent = element.parentNode;
  if (!parent)
    return;

  // Move all children before this element
  while (element.firstChild)
    parent.insertBefore(element.firstChild, element);

  // Remove the now-empty element
  element.remove();
}

/**
 * Sanitize attributes on an element.
 */
function sanitizeAttributes(element, tagName) {
  const attrs = Array.from(element.attributes);
  const globalAllowed = ALLOWED_ATTRS['*'] || [];
  const tagAllowed = ALLOWED_ATTRS[tagName] || [];
  const allowedSet = new Set([...globalAllowed, ...tagAllowed]);

  for (const attr of attrs) {
    const attrName = attr.name.toLowerCase();

    // Remove event handlers
    if (EVENT_HANDLERS.has(attrName)) {
      element.removeAttribute(attr.name);
      continue;
    }

    // Remove dangerous attributes
    if (DANGEROUS_ATTRS.has(attrName)) {
      element.removeAttribute(attr.name);
      continue;
    }

    // Remove attributes starting with 'on' (catch-all for event handlers)
    if (attrName.startsWith('on')) {
      element.removeAttribute(attr.name);
      continue;
    }

    // Check if attribute is allowed
    if (!allowedSet.has(attrName)) {
      element.removeAttribute(attr.name);
      continue;
    }

    // Sanitize URL attributes
    if (attrName === 'href' || attrName === 'src') {
      const value = attr.value.trim().toLowerCase();

      // Block javascript: protocol
      if (value.startsWith('javascript:')) {
        element.setAttribute(attr.name, '#');
        continue;
      }

      // Block vbscript: protocol
      if (value.startsWith('vbscript:')) {
        element.setAttribute(attr.name, '#');
        continue;
      }

      // Block data:text/html (including base64 variants)
      if (value.startsWith('data:text/html')) {
        element.setAttribute(attr.name, '#');
        continue;
      }

      // Block data:application/javascript
      if (value.startsWith('data:application/javascript')) {
        element.setAttribute(attr.name, '#');
        continue;
      }

      // data:image/* URLs are allowed for images
    }
  }
}

// =============================================================================
// Exports
// =============================================================================

export default {
  sanitizeHtml,
  ALLOWED_TAGS,
  DANGEROUS_TAGS,
};
