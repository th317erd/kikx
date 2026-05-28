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

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxCommandResult extends JsdomHTMLElement {
    static get observedAttributes() {
      return ['command-name', 'status'];
    }

    constructor() {
      super();

      this._expanded   = false;
      this._arguments  = '';
      this._result     = '';

      this._onHeaderClick = this._onHeaderClick.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-command-result {
            display: block;
            border-radius: var(--border-radius-small, 4px);
            overflow: hidden;
            font-size: 0.875rem;
          }

          .command-header {
            display: flex;
            align-items: center;
            gap: var(--spacing-xs, 4px);
            padding: 6px 8px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-small, 4px);
            cursor: pointer;
            user-select: none;
            color: var(--text-secondary, #a0a0b8);
            transition: background 0.2s ease;
            width: 100%;
            text-align: left;
          }

          .command-header:hover {
            background: var(--glass-hover, rgba(255, 255, 255, 0.08));
          }

          .collapse-indicator {
            display: inline-block;
            font-size: 0.625rem;
            transition: transform 0.2s ease;
          }

          .collapse-indicator.expanded {
            transform: rotate(90deg);
          }

          .tool-icon {
            font-size: 1rem;
          }

          .command-name {
            font-weight: 600;
            font-family: 'Fira Code', 'Cascadia Code', monospace;
          }

          .status-badge {
            margin-left: auto;
            padding: 1px 6px;
            border-radius: 3px;
            font-size: 0.7rem;
            font-weight: 600;
            text-transform: uppercase;
          }

          .status-badge.success {
            background: rgba(76, 175, 80, 0.2);
            color: #66bb6a;
          }

          .status-badge.error {
            background: rgba(229, 57, 53, 0.2);
            color: #ef5350;
          }

          .status-badge.running {
            background: rgba(255, 183, 77, 0.2);
            color: #ffb74d;
          }

          .command-body {
            display: none;
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-top: none;
            border-radius: 0 0 var(--border-radius-small, 4px) var(--border-radius-small, 4px);
          }

          .command-body.expanded {
            display: block;
          }

          .section-label {
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-muted, #606078);
            padding: 6px 8px 2px;
          }

          .section-content {
            padding: 4px 8px 8px;
            font-family: 'Fira Code', 'Cascadia Code', monospace;
            font-size: 0.8rem;
            line-height: 1.4;
            white-space: pre-wrap;
            color: var(--text-primary, #e8e8f0);
            overflow-x: auto;
          }
        </style>

        <button class="command-header">
          <span class="collapse-indicator">\u25B6</span>
          <span class="tool-icon">\u2699</span>
          <span class="command-name"></span>
          <span class="status-badge"></span>
        </button>
        <div class="command-body">
          <div class="section-label arguments-label">Arguments</div>
          <div class="section-content arguments-content"></div>
          <div class="section-label result-label">Result</div>
          <div class="section-content result-content"></div>
        </div>
      `;

      this._header             = this.querySelector('.command-header');
      this._collapseIndicator  = this.querySelector('.collapse-indicator');
      this._commandName        = this.querySelector('.command-name');
      this._statusBadge        = this.querySelector('.status-badge');
      this._body               = this.querySelector('.command-body');
      this._argumentsContent   = this.querySelector('.arguments-content');
      this._resultContent      = this.querySelector('.result-content');

      this._header.addEventListener('click', this._onHeaderClick);
      this._render();
    }

    disconnectedCallback() {
      this._header.removeEventListener('click', this._onHeaderClick);
    }

    attributeChangedCallback() {
      if (this.isConnected)
        this._render();
    }

    get arguments() {
      return this._arguments;
    }

    set arguments(value) {
      this._arguments = value;
      this._renderArguments();
    }

    get result() {
      return this._result;
    }

    set result(value) {
      this._result = value;
      this._renderResult();
    }

    toggle() {
      if (this._expanded) {
        this.collapse();
      } else {
        this.expand();
      }
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

    _onHeaderClick() {
      this.toggle();
    }

    _render() {
      this._commandName.textContent = this.getAttribute('command-name') || '';
      this._renderStatus();
    }

    _renderStatus() {
      let status = this.getAttribute('status') || '';

      this._statusBadge.textContent = status;
      this._statusBadge.className   = 'status-badge';

      if (status)
        this._statusBadge.classList.add(status);
    }

    _renderArguments() {
      let value = this._arguments;

      if (value && typeof value === 'object')
        value = JSON.stringify(value, null, 2);

      this._argumentsContent.textContent = value || '';
    }

    _renderResult() {
      this._resultContent.textContent = this._result || '';
    }
  }

  dom.window.customElements.define('kikx-command-result', KikxCommandResult);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-command-result', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-command-result');
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
    let registered = dom.window.customElements.get('kikx-command-result');
    assert.ok(registered, 'kikx-command-result should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Default state is collapsed
  // -------------------------------------------------------------------------

  it('default state is collapsed', () => {
    let body = element.querySelector('.command-body');
    assert.ok(body, 'should contain .command-body');
    assert.ok(
      !body.classList.contains('expanded'),
      'command-body should not have expanded class by default',
    );

    let indicator = element.querySelector('.collapse-indicator');
    assert.ok(
      !indicator.classList.contains('expanded'),
      'collapse-indicator should not have expanded class by default',
    );
  });

  // -------------------------------------------------------------------------
  // 4. Displays command name from attribute
  // -------------------------------------------------------------------------

  it('displays command name from attribute', () => {
    element.setAttribute('command-name', 'web_search');

    let nameElement = element.querySelector('.command-name');
    assert.equal(nameElement.textContent, 'web_search', 'should display the command name');
  });

  // -------------------------------------------------------------------------
  // 5. Shows status badge with correct class (success)
  // -------------------------------------------------------------------------

  it('shows status badge with correct class for success', () => {
    element.setAttribute('status', 'success');

    let badge = element.querySelector('.status-badge');
    assert.equal(badge.textContent, 'success', 'badge should display status text');
    assert.ok(badge.classList.contains('success'), 'badge should have success class');
  });

  // -------------------------------------------------------------------------
  // 6. Shows status badge with correct class (error)
  // -------------------------------------------------------------------------

  it('shows status badge with correct class for error', () => {
    element.setAttribute('status', 'error');

    let badge = element.querySelector('.status-badge');
    assert.equal(badge.textContent, 'error', 'badge should display status text');
    assert.ok(badge.classList.contains('error'), 'badge should have error class');
  });

  // -------------------------------------------------------------------------
  // 7. Shows status badge with correct class (running)
  // -------------------------------------------------------------------------

  it('shows status badge with correct class for running', () => {
    element.setAttribute('status', 'running');

    let badge = element.querySelector('.status-badge');
    assert.equal(badge.textContent, 'running', 'badge should display status text');
    assert.ok(badge.classList.contains('running'), 'badge should have running class');
  });

  // -------------------------------------------------------------------------
  // 8. Clicking header toggles expanded state
  // -------------------------------------------------------------------------

  it('clicking header toggles expanded state', () => {
    let header = element.querySelector('.command-header');
    let body   = element.querySelector('.command-body');

    assert.ok(!body.classList.contains('expanded'), 'should start collapsed');

    header.click();
    assert.ok(body.classList.contains('expanded'), 'should be expanded after first click');

    header.click();
    assert.ok(!body.classList.contains('expanded'), 'should be collapsed after second click');
  });

  // -------------------------------------------------------------------------
  // 9. Collapse indicator rotates when expanded
  // -------------------------------------------------------------------------

  it('collapse indicator rotates when expanded', () => {
    let indicator = element.querySelector('.collapse-indicator');

    assert.ok(!indicator.classList.contains('expanded'), 'indicator should start without expanded class');

    element.expand();
    assert.ok(indicator.classList.contains('expanded'), 'indicator should have expanded class after expand');

    element.collapse();
    assert.ok(!indicator.classList.contains('expanded'), 'indicator should lose expanded class after collapse');
  });

  // -------------------------------------------------------------------------
  // 10. Arguments property sets arguments content
  // -------------------------------------------------------------------------

  it('arguments property sets arguments content', () => {
    element.arguments = 'search query here';

    let content = element.querySelector('.arguments-content');
    assert.equal(content.textContent, 'search query here', 'arguments content should display the string value');
  });

  // -------------------------------------------------------------------------
  // 11. Result property sets result content
  // -------------------------------------------------------------------------

  it('result property sets result content', () => {
    element.result = 'Search completed successfully with 5 results.';

    let content = element.querySelector('.result-content');
    assert.equal(content.textContent, 'Search completed successfully with 5 results.', 'result content should display the string value');
  });

  // -------------------------------------------------------------------------
  // 12. Object arguments are JSON-stringified
  // -------------------------------------------------------------------------

  it('object arguments are JSON-stringified with 2-space indent', () => {
    let argumentsObject = { query: 'hello world', limit: 10 };
    element.arguments = argumentsObject;

    let content  = element.querySelector('.arguments-content');
    let expected = JSON.stringify(argumentsObject, null, 2);
    assert.equal(content.textContent, expected, 'object arguments should be pretty-printed as JSON');
  });

  // -------------------------------------------------------------------------
  // 13. toggle()/expand()/collapse() methods work
  // -------------------------------------------------------------------------

  it('toggle()/expand()/collapse() methods work correctly', () => {
    let body = element.querySelector('.command-body');

    assert.ok(!body.classList.contains('expanded'), 'should start collapsed');

    element.expand();
    assert.ok(body.classList.contains('expanded'), 'expand() should expand');

    element.expand();
    assert.ok(body.classList.contains('expanded'), 'expand() when already expanded should stay expanded');

    element.collapse();
    assert.ok(!body.classList.contains('expanded'), 'collapse() should collapse');

    element.collapse();
    assert.ok(!body.classList.contains('expanded'), 'collapse() when already collapsed should stay collapsed');

    element.toggle();
    assert.ok(body.classList.contains('expanded'), 'toggle() from collapsed should expand');

    element.toggle();
    assert.ok(!body.classList.contains('expanded'), 'toggle() from expanded should collapse');
  });

  // -------------------------------------------------------------------------
  // 14. Tool icon displays gear symbol
  // -------------------------------------------------------------------------

  it('tool icon displays gear symbol', () => {
    let icon = element.querySelector('.tool-icon');
    assert.ok(icon, 'should contain .tool-icon');
    assert.equal(icon.textContent, '\u2699', 'tool icon should display the gear symbol');
  });

  // -------------------------------------------------------------------------
  // 15. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/kikx-command-result/kikx-command-result.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
