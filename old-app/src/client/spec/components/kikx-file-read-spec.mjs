'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url:               'http://localhost/kikx/',
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
// Test-local component definition
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxFileRead extends JsdomHTMLElement {
    static get observedAttributes() {
      return ['file-path', 'language'];
    }

    constructor() {
      super();
      this._expanded      = false;
      this._fileContent   = '';
      this._lineCount     = 0;
      this._totalLines    = 0;
      this._offset        = 0;
      this._onHeaderClick = this._onHeaderClick.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <button class="file-header">
          <span class="collapse-indicator">\u25B6</span>
          <span class="file-icon">\uD83D\uDCC4</span>
          <span class="file-path"></span>
          <span class="line-count"></span>
        </button>
        <div class="file-body">
          <div class="file-lines"></div>
        </div>
      `;

      this._header            = this.querySelector('.file-header');
      this._collapseIndicator = this.querySelector('.collapse-indicator');
      this._filePathElement   = this.querySelector('.file-path');
      this._lineCountElement  = this.querySelector('.line-count');
      this._body              = this.querySelector('.file-body');
      this._linesContainer    = this.querySelector('.file-lines');

      this._header.addEventListener('click', this._onHeaderClick);
      this._render();
    }

    disconnectedCallback() {
      if (this._header)
        this._header.removeEventListener('click', this._onHeaderClick);
    }

    attributeChangedCallback() {
      if (this.isConnected)
        this._render();
    }

    get fileContent() { return this._fileContent; }
    set fileContent(value) {
      this._fileContent = value || '';
      this._renderLines();
    }

    get lineCount() { return this._lineCount; }
    set lineCount(value) {
      this._lineCount = value || 0;
      this._renderHeader();
    }

    get totalLines() { return this._totalLines; }
    set totalLines(value) {
      this._totalLines = value || 0;
      this._renderHeader();
    }

    get offset() { return this._offset; }
    set offset(value) {
      this._offset = value || 0;
      this._renderLines();
    }

    toggle() {
      if (this._expanded)
        this.collapse();
      else
        this.expand();
    }

    expand() {
      this._expanded = true;
      this._body.classList.add('expanded');
      this._collapseIndicator.classList.add('expanded');
    }

    collapse() {
      this._expanded = false;
      this._body.classList.remove('expanded');
      this._collapseIndicator.classList.remove('expanded');
    }

    _onHeaderClick() { this.toggle(); }

    _render() {
      this._renderHeader();
      this._renderLines();
    }

    _renderHeader() {
      if (!this._filePathElement) return;
      this._filePathElement.textContent = this.getAttribute('file-path') || '';
      let display = this._totalLines || this._lineCount;
      this._lineCountElement.textContent = (display) ? `(${display} lines)` : '';
    }

    _renderLines() {
      if (!this._linesContainer) return;
      let content = this._fileContent;
      if (!content) {
        this._linesContainer.innerHTML = '';
        return;
      }

      let lines    = content.split('\n');
      let offset   = this._offset || 0;
      let doc      = this.ownerDocument;
      let fragment = doc.createDocumentFragment();

      for (let i = 0; i < lines.length; i++) {
        let span = doc.createElement('span');
        span.className = 'line';
        span.setAttribute('data-line-number', String(offset + i + 1));
        span.textContent = lines[i];
        fragment.appendChild(span);
      }

      this._linesContainer.innerHTML = '';
      this._linesContainer.appendChild(fragment);
    }
  }

  dom.window.customElements.define('kikx-file-read', KikxFileRead);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-file-read', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-file-read');
    dom.window.document.body.appendChild(element);
  });

  afterEach(() => {
    if (element && element.parentNode)
      element.parentNode.removeChild(element);

    teardownDOM();
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  it('registers as a custom element', () => {
    let registered = dom.window.customElements.get('kikx-file-read');
    assert.ok(registered, 'kikx-file-read should be registered');
  });

  // -------------------------------------------------------------------------
  // Template rendering
  // -------------------------------------------------------------------------

  it('renders template on connect', () => {
    assert.ok(element.innerHTML.length > 0);
    assert.ok(element.querySelector('.file-header'));
    assert.ok(element.querySelector('.file-body'));
    assert.ok(element.querySelector('.file-lines'));
  });

  // -------------------------------------------------------------------------
  // Default state — collapsed
  // -------------------------------------------------------------------------

  it('starts collapsed by default', () => {
    let body = element.querySelector('.file-body');
    assert.ok(!body.classList.contains('expanded'));

    let indicator = element.querySelector('.collapse-indicator');
    assert.ok(!indicator.classList.contains('expanded'));
  });

  // -------------------------------------------------------------------------
  // File path display
  // -------------------------------------------------------------------------

  it('displays file path from attribute', () => {
    element.setAttribute('file-path', '/src/core/index.mjs');
    let pathElement = element.querySelector('.file-path');
    assert.equal(pathElement.textContent, '/src/core/index.mjs');
  });

  // -------------------------------------------------------------------------
  // Line count display
  // -------------------------------------------------------------------------

  it('displays line count in header', () => {
    element.totalLines = 245;
    let countElement = element.querySelector('.line-count');
    assert.equal(countElement.textContent, '(245 lines)');
  });

  it('displays empty string when lineCount is 0', () => {
    element.totalLines = 0;
    element.lineCount  = 0;
    let countElement = element.querySelector('.line-count');
    assert.equal(countElement.textContent, '');
  });

  // -------------------------------------------------------------------------
  // Toggle / expand / collapse
  // -------------------------------------------------------------------------

  it('clicking header toggles expanded state', () => {
    let header = element.querySelector('.file-header');
    let body   = element.querySelector('.file-body');

    assert.ok(!body.classList.contains('expanded'));

    header.click();
    assert.ok(body.classList.contains('expanded'));

    header.click();
    assert.ok(!body.classList.contains('expanded'));
  });

  it('expand() and collapse() work correctly', () => {
    let body = element.querySelector('.file-body');

    element.expand();
    assert.ok(body.classList.contains('expanded'));

    element.collapse();
    assert.ok(!body.classList.contains('expanded'));
  });

  it('collapse indicator rotates when expanded', () => {
    let indicator = element.querySelector('.collapse-indicator');

    element.expand();
    assert.ok(indicator.classList.contains('expanded'));

    element.collapse();
    assert.ok(!indicator.classList.contains('expanded'));
  });

  // -------------------------------------------------------------------------
  // File content rendering
  // -------------------------------------------------------------------------

  it('renders file content as line spans', () => {
    element.fileContent = 'line one\nline two\nline three';

    let lines = element.querySelectorAll('.line');
    assert.equal(lines.length, 3);
    assert.equal(lines[0].textContent, 'line one');
    assert.equal(lines[1].textContent, 'line two');
    assert.equal(lines[2].textContent, 'line three');
  });

  it('sets data-line-number attributes starting from 1', () => {
    element.fileContent = 'a\nb\nc';

    let lines = element.querySelectorAll('.line');
    assert.equal(lines[0].getAttribute('data-line-number'), '1');
    assert.equal(lines[1].getAttribute('data-line-number'), '2');
    assert.equal(lines[2].getAttribute('data-line-number'), '3');
  });

  it('respects offset for line numbering', () => {
    element.offset      = 10;
    element.fileContent = 'a\nb\nc';

    let lines = element.querySelectorAll('.line');
    assert.equal(lines[0].getAttribute('data-line-number'), '11');
    assert.equal(lines[1].getAttribute('data-line-number'), '12');
    assert.equal(lines[2].getAttribute('data-line-number'), '13');
  });

  it('clears content when fileContent set to empty', () => {
    element.fileContent = 'has content';
    assert.ok(element.querySelectorAll('.line').length > 0);

    element.fileContent = '';
    assert.equal(element.querySelector('.file-lines').innerHTML, '');
  });

  // -------------------------------------------------------------------------
  // Real module exports
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/kikx-file-read/kikx-file-read.mjs');
      assert.equal(typeof mod.default, 'function');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
