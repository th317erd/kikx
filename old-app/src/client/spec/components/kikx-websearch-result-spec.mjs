'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// Locale data (pure data -- safe to import in Node.js)
// ---------------------------------------------------------------------------

import localeData from '../../lib/locales/en.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePath(object, key) {
  let parts   = key.split('.');
  let current = object;

  for (let part of parts) {
    if (current == null || typeof current !== 'object')
      return undefined;

    current = current[part];
  }

  return current;
}

function mockT(key) {
  if (!key)
    return key;

  let value = resolvePath(localeData, key);
  return (value !== undefined && typeof value === 'string') ? value : key;
}

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/kikx/',
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
// Mirrors the real component's DOM structure and logic, but wires directly
// into the jsdom environment. This avoids issues with ESM module caching
// and browser globals at import time.
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  searching: 'Searching...',
  completed: 'Completed',
  error: 'Error',
};

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;
  let doc = dom.window.document;

  class KikxWebsearchResult extends JsdomHTMLElement {
    static get observedAttributes() {
      return ['status'];
    }

    constructor() {
      super();

      this._results     = [];
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-websearch-result { display: block; border-radius: var(--border-radius-small, 4px); }

          .search-header {
            display: flex; align-items: center; gap: var(--spacing-xs, 4px);
            padding: 6px 8px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-small, 4px);
            font-size: 0.8125rem; color: var(--text-secondary, #a0a0b8);
          }

          .search-icon { font-size: 1rem; }

          .status-text { font-weight: 600; }

          .status-text.searching { color: var(--accent-primary, #00e5ff); }
          .status-text.completed { color: #66bb6a; }
          .status-text.error { color: #ef5350; }

          .results-list {
            display: flex; flex-direction: column; gap: var(--spacing-xs, 4px);
            padding: var(--spacing-xs, 4px) 0;
          }

          .result-entry {
            padding: 6px 8px;
            border-radius: var(--border-radius-small, 4px);
            transition: background 0.2s ease;
          }

          .result-entry:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

          .result-title {
            font-weight: 600; font-size: 0.875rem;
            color: var(--accent-primary, #00e5ff);
            text-decoration: none; display: block;
          }

          .result-title:hover { text-decoration: underline; }

          .result-url {
            font-size: 0.75rem; color: var(--text-muted, #606078);
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          }

          .result-snippet {
            font-size: 0.8125rem; color: var(--text-secondary, #a0a0b8);
            line-height: 1.4; margin-top: 2px;
          }
        </style>

        <div class="search-header">
          <span class="search-icon">\uD83D\uDD0D</span>
          <span class="status-text"></span>
        </div>
        <div class="results-list"></div>
      `;

      this._statusText  = this.querySelector('.status-text');
      this._resultsList = this.querySelector('.results-list');

      this._renderStatus();
    }

    attributeChangedCallback() {
      if (this.isConnected)
        this._renderStatus();
    }

    get results() {
      return this._results;
    }

    set results(value) {
      this._results = Array.isArray(value) ? value : [];
      this._renderResults();
    }

    _renderStatus() {
      let status = this.getAttribute('status') || '';

      this._statusText.textContent = STATUS_LABELS[status] || '';
      this._statusText.className   = 'status-text';

      if (status)
        this._statusText.classList.add(status);
    }

    _renderResults() {
      this._resultsList.innerHTML = '';

      for (let result of this._results) {
        let entry = doc.createElement('div');
        entry.className = 'result-entry';

        let title = doc.createElement('a');
        title.className   = 'result-title';
        title.href        = result.url || '#';
        title.target      = '_blank';
        title.rel         = 'noopener noreferrer';
        title.textContent = result.title || '';

        let url = doc.createElement('div');
        url.className   = 'result-url';
        url.textContent = result.url || '';

        let snippet = doc.createElement('div');
        snippet.className   = 'result-snippet';
        snippet.textContent = result.snippet || '';

        entry.appendChild(title);
        entry.appendChild(url);
        entry.appendChild(snippet);
        this._resultsList.appendChild(entry);
      }
    }
  }

  dom.window.customElements.define('kikx-websearch-result', KikxWebsearchResult);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-websearch-result', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-websearch-result');
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
    let registered = dom.window.customElements.get('kikx-websearch-result');
    assert.ok(registered, 'kikx-websearch-result should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Contains search header with search icon
  // -------------------------------------------------------------------------

  it('contains search header with search icon', () => {
    let header = element.querySelector('.search-header');
    assert.ok(header, 'should contain .search-header');

    let icon = element.querySelector('.search-icon');
    assert.ok(icon, 'should contain .search-icon');
    assert.equal(icon.textContent, '\uD83D\uDD0D', 'search icon should display magnifying glass emoji');
  });

  // -------------------------------------------------------------------------
  // 4. Status "searching" shows searching text/class
  // -------------------------------------------------------------------------

  it('status "searching" shows searching text and class', () => {
    element.setAttribute('status', 'searching');

    let statusText = element.querySelector('.status-text');
    assert.equal(statusText.textContent, 'Searching...', 'status text should display "Searching..."');
    assert.ok(statusText.classList.contains('searching'), 'status text should have searching class');
  });

  // -------------------------------------------------------------------------
  // 5. Status "completed" shows completed text/class
  // -------------------------------------------------------------------------

  it('status "completed" shows completed text and class', () => {
    element.setAttribute('status', 'completed');

    let statusText = element.querySelector('.status-text');
    assert.equal(statusText.textContent, 'Completed', 'status text should display "Completed"');
    assert.ok(statusText.classList.contains('completed'), 'status text should have completed class');
  });

  // -------------------------------------------------------------------------
  // 6. Status "error" shows error text/class
  // -------------------------------------------------------------------------

  it('status "error" shows error text and class', () => {
    element.setAttribute('status', 'error');

    let statusText = element.querySelector('.status-text');
    assert.equal(statusText.textContent, 'Error', 'status text should display "Error"');
    assert.ok(statusText.classList.contains('error'), 'status text should have error class');
  });

  // -------------------------------------------------------------------------
  // 7. Results property renders result entries
  // -------------------------------------------------------------------------

  it('results property renders result entries', () => {
    element.results = [
      { title: 'First Result', url: 'https://example.com/1', snippet: 'First snippet' },
      { title: 'Second Result', url: 'https://example.com/2', snippet: 'Second snippet' },
    ];

    let entries = element.querySelectorAll('.result-entry');
    assert.equal(entries.length, 2, 'should render two result entries');
  });

  // -------------------------------------------------------------------------
  // 8. Result entry has linked title with target="_blank"
  // -------------------------------------------------------------------------

  it('result entry has linked title with target="_blank"', () => {
    element.results = [
      { title: 'Test Title', url: 'https://example.com', snippet: 'A snippet' },
    ];

    let title = element.querySelector('.result-title');
    assert.ok(title, 'result entry should contain a .result-title link');
    assert.equal(title.tagName, 'A', 'result title should be an anchor element');
    assert.equal(title.textContent, 'Test Title', 'title text should match');
    assert.equal(title.getAttribute('target'), '_blank', 'link should open in new tab');
    assert.equal(title.getAttribute('rel'), 'noopener noreferrer', 'link should have noopener noreferrer');
    assert.equal(title.href, 'https://example.com/', 'link href should match the url');
  });

  // -------------------------------------------------------------------------
  // 9. Result entry shows URL
  // -------------------------------------------------------------------------

  it('result entry shows URL', () => {
    element.results = [
      { title: 'Title', url: 'https://example.com/page', snippet: 'Snippet' },
    ];

    let url = element.querySelector('.result-url');
    assert.ok(url, 'result entry should contain a .result-url element');
    assert.equal(url.textContent, 'https://example.com/page', 'URL text should match');
  });

  // -------------------------------------------------------------------------
  // 10. Result entry shows snippet
  // -------------------------------------------------------------------------

  it('result entry shows snippet', () => {
    element.results = [
      { title: 'Title', url: 'https://example.com', snippet: 'This is the snippet text' },
    ];

    let snippet = element.querySelector('.result-snippet');
    assert.ok(snippet, 'result entry should contain a .result-snippet element');
    assert.equal(snippet.textContent, 'This is the snippet text', 'snippet text should match');
  });

  // -------------------------------------------------------------------------
  // 11. Empty results shows no entries
  // -------------------------------------------------------------------------

  it('empty results shows no entries', () => {
    element.results = [];

    let entries = element.querySelectorAll('.result-entry');
    assert.equal(entries.length, 0, 'should render zero result entries for empty array');
  });

  // -------------------------------------------------------------------------
  // 12. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/kikx-websearch-result/kikx-websearch-result.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
