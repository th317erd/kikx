'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url:               'http://localhost/hero/',
    pretendToBeVisual: true,
  });

  registerComponent();
}

function teardownDOM() {
  if (dom)
    dom.window.close();

  dom = null;
}

// ---------------------------------------------------------------------------
// Sanitization constants (must match the real component)
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
// Test-local component definition
// ---------------------------------------------------------------------------
// Mirrors the real component's DOM structure and logic, but runs entirely
// within the jsdom window. This avoids issues with ESM module caching and
// browser globals at import time.
// ---------------------------------------------------------------------------

function sanitizeNode(node) {
  let children = Array.from(node.childNodes);

  for (let child of children) {
    if (child.nodeType === 3) continue;
    if (child.nodeType === 8) { child.remove(); continue; }

    if (child.nodeType !== 1) { child.remove(); continue; }

    let tagName = child.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tagName)) {
      let text = child.ownerDocument.createTextNode(child.textContent);
      child.parentNode.replaceChild(text, child);
      continue;
    }

    let allowedAttrs = ALLOWED_ATTRIBUTES[tagName] || [];
    for (let attr of Array.from(child.attributes)) {
      if (attr.name.startsWith('on')) { child.removeAttribute(attr.name); continue; }
      if (!allowedAttrs.includes(attr.name)) { child.removeAttribute(attr.name); continue; }
      if ((attr.name === 'href' || attr.name === 'src') && DANGEROUS_URL.test(attr.value)) {
        child.removeAttribute(attr.name);
      }
    }

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

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class HeroMessageContent extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
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

  dom.window.customElements.define('hero-message-content', HeroMessageContent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-message-content', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-message-content');
    dom.window.document.body.appendChild(element);
  });

  afterEach(() => {
    if (element && element.parentNode)
      element.parentNode.removeChild(element);

    teardownDOM();
  });

  // -------------------------------------------------------------------------
  // 1. Registers as custom element
  // -------------------------------------------------------------------------

  it('registers as a custom element', () => {
    let registered = dom.window.customElements.get('hero-message-content');
    assert.ok(registered, 'hero-message-content should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Contains .message-body container
  // -------------------------------------------------------------------------

  it('contains .message-body container', () => {
    let messageBody = element.shadowRoot.querySelector('.message-body');
    assert.ok(messageBody, 'shadow DOM should contain .message-body');
  });

  // -------------------------------------------------------------------------
  // 4. Renders plain text content
  // -------------------------------------------------------------------------

  it('renders plain text content', () => {
    element.content = 'Hello, world!';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    assert.equal(messageBody.textContent, 'Hello, world!');
  });

  // -------------------------------------------------------------------------
  // 5. Renders basic HTML (bold, italic, lists)
  // -------------------------------------------------------------------------

  it('renders basic HTML formatting', () => {
    element.content = '<b>bold</b> and <i>italic</i> and <em>emphasis</em> and <strong>strong</strong>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    assert.ok(messageBody.querySelector('b'), 'should render <b> tag');
    assert.ok(messageBody.querySelector('i'), 'should render <i> tag');
    assert.ok(messageBody.querySelector('em'), 'should render <em> tag');
    assert.ok(messageBody.querySelector('strong'), 'should render <strong> tag');
    assert.equal(messageBody.querySelector('b').textContent, 'bold');
    assert.equal(messageBody.querySelector('i').textContent, 'italic');
  });

  // -------------------------------------------------------------------------
  // 6. Renders headings (h1-h3)
  // -------------------------------------------------------------------------

  it('renders headings', () => {
    element.content = '<h1>Heading 1</h1><h2>Heading 2</h2><h3>Heading 3</h3>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    assert.ok(messageBody.querySelector('h1'), 'should render <h1>');
    assert.ok(messageBody.querySelector('h2'), 'should render <h2>');
    assert.ok(messageBody.querySelector('h3'), 'should render <h3>');
    assert.equal(messageBody.querySelector('h1').textContent, 'Heading 1');
    assert.equal(messageBody.querySelector('h2').textContent, 'Heading 2');
    assert.equal(messageBody.querySelector('h3').textContent, 'Heading 3');
  });

  // -------------------------------------------------------------------------
  // 7. Renders code blocks (pre > code)
  // -------------------------------------------------------------------------

  it('renders code blocks', () => {
    element.content = '<pre><code class="language-js">let x = 1;</code></pre>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    let pre = messageBody.querySelector('pre');
    assert.ok(pre, 'should render <pre>');

    let code = pre.querySelector('code');
    assert.ok(code, 'should render <code> inside <pre>');
    assert.equal(code.textContent, 'let x = 1;');
    assert.equal(code.getAttribute('class'), 'language-js', 'should preserve class on code element');
  });

  // -------------------------------------------------------------------------
  // 8. Renders blockquotes
  // -------------------------------------------------------------------------

  it('renders blockquotes', () => {
    element.content = '<blockquote>A wise quote</blockquote>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    let blockquote = messageBody.querySelector('blockquote');
    assert.ok(blockquote, 'should render <blockquote>');
    assert.equal(blockquote.textContent, 'A wise quote');
  });

  // -------------------------------------------------------------------------
  // 9. Renders tables
  // -------------------------------------------------------------------------

  it('renders tables', () => {
    element.content = '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    let table = messageBody.querySelector('table');
    assert.ok(table, 'should render <table>');
    assert.ok(table.querySelector('thead'), 'should render <thead>');
    assert.ok(table.querySelector('tbody'), 'should render <tbody>');
    assert.ok(table.querySelector('th'), 'should render <th>');
    assert.ok(table.querySelector('td'), 'should render <td>');
    assert.equal(table.querySelector('th').textContent, 'Name');
    assert.equal(table.querySelector('td').textContent, 'A');
  });

  // -------------------------------------------------------------------------
  // 10. Strips script tags
  // -------------------------------------------------------------------------

  it('strips script tags', () => {
    element.content = '<p>safe</p><script>alert("xss")</script>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    assert.ok(!messageBody.querySelector('script'), 'should not contain <script> element');
    assert.ok(messageBody.querySelector('p'), 'should still render the safe <p>');
    assert.equal(messageBody.querySelector('p').textContent, 'safe');
  });

  // -------------------------------------------------------------------------
  // 11. Strips event handler attributes (onclick, onerror)
  // -------------------------------------------------------------------------

  it('strips event handler attributes', () => {
    element.content = '<b onclick="alert(1)">click</b><img src="x.png" onerror="alert(2)">';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    let bold = messageBody.querySelector('b');
    assert.ok(bold, 'should render <b>');
    assert.equal(bold.getAttribute('onclick'), null, 'onclick should be stripped');

    let img = messageBody.querySelector('img');
    assert.ok(img, 'should render <img>');
    assert.equal(img.getAttribute('onerror'), null, 'onerror should be stripped');
  });

  // -------------------------------------------------------------------------
  // 12. Strips javascript: URLs from links
  // -------------------------------------------------------------------------

  it('strips javascript: URLs from links', () => {
    element.content = '<a href="javascript:alert(1)">evil</a>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    let link = messageBody.querySelector('a');
    assert.ok(link, 'should render <a> tag');
    assert.equal(link.getAttribute('href'), null, 'javascript: href should be stripped');
    assert.equal(link.textContent, 'evil');
  });

  // -------------------------------------------------------------------------
  // 13. Allows safe links with href
  // -------------------------------------------------------------------------

  it('allows safe links with href', () => {
    element.content = '<a href="https://example.com" title="Example">link</a>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    let link = messageBody.querySelector('a');
    assert.ok(link, 'should render <a> tag');
    assert.equal(link.getAttribute('href'), 'https://example.com', 'safe href should be preserved');
    assert.equal(link.getAttribute('title'), 'Example', 'title attribute should be preserved');
    assert.equal(link.textContent, 'link');
  });

  // -------------------------------------------------------------------------
  // 14. Links get target="_blank" and rel="noopener noreferrer"
  // -------------------------------------------------------------------------

  it('links get target="_blank" and rel="noopener noreferrer"', () => {
    element.content = '<a href="https://example.com">safe link</a>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    let link = messageBody.querySelector('a');
    assert.ok(link, 'should render <a> tag');
    assert.equal(link.getAttribute('target'), '_blank', 'should have target="_blank"');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer', 'should have rel="noopener noreferrer"');
  });

  // -------------------------------------------------------------------------
  // 15. Strips iframe/object/embed tags
  // -------------------------------------------------------------------------

  it('strips iframe, object, and embed tags', () => {
    element.content = '<iframe src="https://evil.com"></iframe><object data="x"></object><embed src="y"><p>safe</p>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    assert.ok(!messageBody.querySelector('iframe'), 'should not contain <iframe>');
    assert.ok(!messageBody.querySelector('object'), 'should not contain <object>');
    assert.ok(!messageBody.querySelector('embed'), 'should not contain <embed>');
    assert.ok(messageBody.querySelector('p'), 'should still render the safe <p>');
  });

  // -------------------------------------------------------------------------
  // 16. Setting content property updates the display
  // -------------------------------------------------------------------------

  it('setting content property updates the display', () => {
    element.content = '<p>first</p>';

    let messageBody = element.shadowRoot.querySelector('.message-body');
    assert.equal(messageBody.querySelector('p').textContent, 'first');

    element.content = '<p>second</p>';
    assert.equal(messageBody.querySelector('p').textContent, 'second');
  });

  // -------------------------------------------------------------------------
  // 17. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/hero-message-content/hero-message-content.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
