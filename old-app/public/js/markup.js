'use strict';

// ============================================================================
// Hero Markup Language (HML) - Frontend Parser & Renderer
// ============================================================================
// Processes HTML content from the agent, sanitizes it, and renders custom
// HML elements like <hml-prompt> and <hml-thinking>.

// =============================================================================
// Configuration
// =============================================================================

/**
 * Allowed HTML tags (whitelist).
 * Unknown tags are stripped but content is preserved.
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
  'hml-prompt', 'hml-thinking', 'response', 'data', 'option',
]);

/**
 * Dangerous tags to completely remove (content AND tag).
 */
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'embed', 'object', 'style', 'base', 'meta',
  'form', 'input', 'button', 'textarea', 'select',
  'math', 'noscript', 'template', 'slot',
  'interaction', // System protocol tag - never display
]);

/**
 * Event handler attributes to strip.
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
  'onbegin', 'onend', 'onrepeat',
]);

/**
 * Allowed attributes per tag.
 */
const ALLOWED_ATTRS = {
  '*':            ['id', 'class', 'title'],
  'a':            ['href', 'target', 'rel'],
  'img':          ['src', 'alt', 'width', 'height', 'loading'],
  'td':           ['colspan', 'rowspan'],
  'th':           ['colspan', 'rowspan'],
  'code':         ['class'],
  'hml-prompt':   ['id', 'type', 'min', 'max', 'step', 'default', 'answered'],
  'hml-thinking': ['title'],
  'option':       ['value', 'selected'],
};

// =============================================================================
// Main Render Function
// =============================================================================

/**
 * Render content with custom HML elements.
 * Content is expected to be HTML (not markdown).
 *
 * @param {string} content - HTML content from agent
 * @returns {string} Sanitized and processed HTML
 */
function renderMarkup(content) {
  if (!content)
    return '';

  // Safeguard: ensure content is a string
  // If content is an object, convert it appropriately
  if (typeof content !== 'string') {
    console.warn('[renderMarkup] Received non-string content:', typeof content, content);
    // Try to extract text if it's a content block array
    if (Array.isArray(content)) {
      content = content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text || '')
        .join('');
    } else if (content && typeof content === 'object') {
      // Single content block
      if (content.type === 'text' && content.text) {
        content = content.text;
      } else {
        // Last resort: stringify for debugging
        content = JSON.stringify(content, null, 2);
      }
    } else {
      return '';
    }
  }

  // Create DOM fragment for processing
  let template = document.createElement('template');
  template.innerHTML = content;

  // Sanitize content (defense in depth - server also sanitizes)
  sanitizeContent(template.content);

  // Process custom HML elements
  processCustomElements(template.content);

  return template.innerHTML;
}

// =============================================================================
// Sanitization (Defense in Depth)
// =============================================================================

/**
 * Sanitize content by removing dangerous elements and attributes.
 * This is defense-in-depth - the server also sanitizes.
 */
function sanitizeContent(container) {
  // Remove dangerous tags completely
  for (let tag of DANGEROUS_TAGS) {
    container.querySelectorAll(tag).forEach((el) => el.remove());
  }

  // Remove comments
  let walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT, null, false);
  let comments = [];
  while (walker.nextNode())
    comments.push(walker.currentNode);
  for (let comment of comments)
    comment.remove();

  // Process all elements
  container.querySelectorAll('*').forEach((el) => {
    let tagName = el.tagName.toLowerCase();

    // Strip unknown tags (keep content)
    if (!ALLOWED_TAGS.has(tagName)) {
      let parent = el.parentNode;
      while (el.firstChild)
        parent.insertBefore(el.firstChild, el);
      el.remove();
      return;
    }

    // Strip dangerous attributes
    let attrs = Array.from(el.attributes);
    let globalAllowed = ALLOWED_ATTRS['*'] || [];
    let tagAllowed = ALLOWED_ATTRS[tagName] || [];
    let allowedSet = new Set([...globalAllowed, ...tagAllowed]);

    for (let attr of attrs) {
      let attrName = attr.name.toLowerCase();

      // Remove event handlers
      if (EVENT_HANDLERS.has(attrName) || attrName.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }

      // Remove style attribute
      if (attrName === 'style') {
        el.removeAttribute(attr.name);
        continue;
      }

      // Check whitelist
      if (!allowedSet.has(attrName)) {
        el.removeAttribute(attr.name);
        continue;
      }

      // Sanitize URLs
      if (attrName === 'href' || attrName === 'src') {
        let value = attr.value.trim().toLowerCase();
        if (value.startsWith('javascript:') || value.startsWith('data:text/html')) {
          el.setAttribute(attr.name, '#');
        }
      }
    }

    // Add security attributes to links
    if (tagName === 'a' && el.hasAttribute('href')) {
      let href = el.getAttribute('href');
      if (href && !href.startsWith('#')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
}

// =============================================================================
// Custom Element Processing
// =============================================================================

/**
 * Process custom HML elements in the container.
 */
function processCustomElements(container) {
  processThinkingElements(container);
  // Note: hml-prompt is a Web Component - it handles its own rendering
}

/**
 * Process <hml-thinking> elements into collapsible blocks.
 */
function processThinkingElements(container) {
  container.querySelectorAll('hml-thinking').forEach((el, index) => {
    let content = el.innerHTML.trim();
    let title = el.getAttribute('title') || 'Thinking';

    let html = `
      <details class="hml-thinking-block">
        <summary class="hml-thinking-header">
          <span class="hml-thinking-brain">🧠</span>
          <span class="hml-thinking-title">${escapeHtml(title)}</span>
          <span class="hml-thinking-toggle"></span>
        </summary>
        <div class="hml-thinking-content">
          ${content}
        </div>
      </details>
    `;

    replaceElementWithHTML(el, html);
  });
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Replace an element with HTML string.
 */
function replaceElementWithHTML(el, html) {
  let template = document.createElement('template');
  template.innerHTML = html;
  el.replaceWith(template.content);
}

/**
 * Escape HTML entities.
 */
function escapeHtml(text) {
  if (!text)
    return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =============================================================================
// Hero Interaction WebComponent
// =============================================================================

/**
 * <hero-interaction> WebComponent
 * Displays a jiggling brain emoji while processing interactions.
 */
class HeroInteraction extends HTMLElement {
  constructor() {
    super();
    if (!this.shadowRoot)
      this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  static get observedAttributes() {
    return ['status', 'message'];
  }

  attributeChangedCallback() {
    this.render();
  }

  render() {
    let status = this.getAttribute('status') || 'processing';
    let message = this.getAttribute('message') || '';

    if (!message) {
      switch (status) {
        case 'processing': message = 'Thinking...'; break;
        case 'searching':  message = 'Searching...'; break;
        case 'waiting':    message = 'Waiting...'; break;
        case 'complete':   message = 'Done'; break;
        default:           message = 'Processing...';
      }
    }

    let isActive = (status !== 'complete' && status !== 'error');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .brain {
          font-size: 1.2em;
          display: inline-block;
        }
        .brain.active {
          animation: jiggle 0.4s ease-in-out infinite;
        }
        @keyframes jiggle {
          0%, 100% { transform: rotate(0deg) scale(1); }
          25% { transform: rotate(-8deg) scale(1.05); }
          50% { transform: rotate(0deg) scale(1); }
          75% { transform: rotate(8deg) scale(1.05); }
        }
        .message {
          color: inherit;
          opacity: 0.8;
        }
        :host([status="complete"]) .brain {
          animation: none;
        }
        :host([status="error"]) .brain::after {
          content: "❌";
          font-size: 0.6em;
          position: relative;
          top: -0.3em;
        }
      </style>
      <span class="brain ${(isActive) ? 'active' : ''}" role="img" aria-label="thinking">🧠</span>
      <span class="message">${message}</span>
    `;
  }
}

// Register the WebComponent
customElements.define('hero-interaction', HeroInteraction);

// =============================================================================
// Legacy Compatibility
// =============================================================================

/**
 * Attach event handlers to user prompt elements.
 * Note: <hml-prompt> Web Components handle their own events via Shadow DOM.
 * This function is kept for backwards compatibility but is now a no-op.
 */
function attachUserPromptHandlers(container, messageId) {
  // No-op: <hml-prompt> Web Component handles its own events
}

// Make functions available globally
window.renderMarkup = renderMarkup;
window.attachUserPromptHandlers = attachUserPromptHandlers;
