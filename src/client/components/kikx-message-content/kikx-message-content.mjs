'use strict';

// ---------------------------------------------------------------------------
// Sanitization constants
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
  'b', 'i', 'em', 'strong', 's', 'strike', 'u',
  'ol', 'ul', 'li',
  'table', 'tr', 'td', 'th', 'thead', 'tbody',
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'pre', 'code', 'blockquote',
  'a', 'span', 'div', 'img',
]);

const ALLOWED_ATTRIBUTES = {
  'a':    ['href', 'title', 'target', 'rel'],
  'img':  ['src', 'alt', 'width', 'height'],
  'td':   ['colspan', 'rowspan'],
  'th':   ['colspan', 'rowspan'],
  'code': ['class'],
};

const DANGEROUS_URL = /^\s*javascript\s*:/i;

// ---------------------------------------------------------------------------
// Sanitization logic
// ---------------------------------------------------------------------------

function sanitizeNode(node) {
  let children = Array.from(node.childNodes);

  for (let child of children) {
    if (child.nodeType === 3) continue; // text node OK
    if (child.nodeType === 8) { child.remove(); continue; } // remove comments

    if (child.nodeType !== 1) { child.remove(); continue; } // remove non-elements

    let tagName = child.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tagName)) {
      let text = child.ownerDocument.createTextNode(child.textContent);
      child.parentNode.replaceChild(text, child);
      continue;
    }

    // Remove disallowed attributes
    let allowedAttrs = ALLOWED_ATTRIBUTES[tagName] || [];
    for (let attr of Array.from(child.attributes)) {
      if (attr.name.startsWith('on')) { child.removeAttribute(attr.name); continue; }
      if (!allowedAttrs.includes(attr.name)) { child.removeAttribute(attr.name); continue; }
      if ((attr.name === 'href' || attr.name === 'src') && DANGEROUS_URL.test(attr.value)) {
        child.removeAttribute(attr.name);
      }
    }

    // Add safety attributes to links
    if (tagName === 'a') {
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noopener noreferrer');
    }

    sanitizeNode(child);
  }
}

function sanitizeHTML(html, ownerDocument) {
  let template = ownerDocument.createElement('template');
  template.innerHTML = html;

  sanitizeNode(template.content);
  return template.innerHTML;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .message-body {
      font-size: 0.9375rem;
    }

    .message-body h1, .message-body h2, .message-body h3,
    .message-body h4, .message-body h5, .message-body h6 {
      margin: 0.5em 0 0.25em;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
    }

    .message-body h1 { font-size: 1.25rem; }
    .message-body h2 { font-size: 1.125rem; }
    .message-body h3 { font-size: 1rem; }

    .message-body p { margin: 0.25em 0; }

    .message-body ul, .message-body ol {
      margin: 0.25em 0;
      padding-left: 1.5em;
    }

    .message-body code {
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.85em;
    }

    .message-body pre {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-small, 4px);
      padding: var(--spacing-sm, 8px);
      overflow-x: auto;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.85em;
      line-height: 1.4;
    }

    .message-body pre code {
      background: none;
      padding: 0;
      border-radius: 0;
    }

    .message-body blockquote {
      border-left: 3px solid var(--accent-primary, #00e5ff);
      margin: 0.5em 0;
      padding: 0.25em 0.75em;
      color: var(--text-secondary, #a0a0b8);
    }

    .message-body table {
      border-collapse: collapse;
      width: 100%;
      margin: 0.5em 0;
    }

    .message-body th, .message-body td {
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      padding: 6px 10px;
      text-align: left;
    }

    .message-body th {
      background: rgba(255, 255, 255, 0.05);
      font-weight: 600;
    }

    .message-body a {
      color: var(--accent-primary, #00e5ff);
      text-decoration: none;
    }

    .message-body a:hover {
      text-decoration: underline;
    }

    .message-body img {
      max-width: 100%;
      border-radius: var(--border-radius-small, 4px);
    }

    .message-body hr {
      border: none;
      border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      margin: 0.5em 0;
    }
  </style>

  <div class="message-body"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

class KikxMessageContent extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._messageBody = this.shadowRoot.querySelector('.message-body');
    this._content = '';
  }

  get content() { return this._content; }

  set content(value) {
    this._content = (value != null) ? String(value) : '';
    this._render();
  }

  connectedCallback() {
    let attributeContent = this.getAttribute('content');
    if (attributeContent && !this._content)
      this.content = attributeContent;
  }

  _render() {
    let sanitized = sanitizeHTML(this._content, this.shadowRoot.ownerDocument);
    this._messageBody.innerHTML = sanitized;
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-message-content', KikxMessageContent);

export default KikxMessageContent;
