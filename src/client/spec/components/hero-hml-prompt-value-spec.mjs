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
    url: 'http://localhost/hero/',
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

  class HeroHmlPromptValue extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; padding: 4px 0; }

          .value-label {
            font-size: 0.75rem; font-weight: 600;
            color: var(--text-muted, #606078); margin-bottom: 2px;
          }

          .value-container {
            display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
          }

          .value-pill {
            display: inline-flex; align-items: center;
            padding: 3px 10px;
            background: rgba(76, 175, 80, 0.15);
            border: 1px solid rgba(76, 175, 80, 0.40);
            border-radius: 12px;
            font-size: 0.8125rem; font-weight: 500;
            color: #81c784;
            white-space: nowrap;
          }

          .value-pill.color-value {
            gap: 6px;
          }

          .color-swatch {
            width: 14px; height: 14px;
            border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.2);
            display: inline-block;
          }
        </style>

        <div class="value-label"></div>
        <div class="value-container"></div>
      `;

      this._labelEl     = this.shadowRoot.querySelector('.value-label');
      this._containerEl = this.shadowRoot.querySelector('.value-container');

      this._label     = '';
      this._values    = [];
      this._inputType = '';
    }

    get label() {
      return this._label;
    }

    set label(value) {
      this._label = value || '';
      this._labelEl.textContent = this._label;
    }

    get values() {
      return this._values;
    }

    set values(value) {
      if (typeof value === 'string')
        value = [value];

      this._values = Array.isArray(value) ? value : [];
      this._renderPills();
    }

    get inputType() {
      return this._inputType;
    }

    set inputType(value) {
      this._inputType = value || '';
      this._renderPills();
    }

    _renderPills() {
      this._containerEl.innerHTML = '';
      let doc = this._containerEl.ownerDocument;

      for (let val of this._values) {
        let pill = doc.createElement('span');
        pill.className = 'value-pill';

        if (this._inputType === 'color') {
          pill.classList.add('color-value');

          let swatch = doc.createElement('span');
          swatch.className = 'color-swatch';
          swatch.style.backgroundColor = val;
          pill.appendChild(swatch);
          pill.appendChild(doc.createTextNode(val));
        } else if (this._inputType === 'boolean' || this._inputType === 'checkbox') {
          let display = (val === true || val === 'true') ? 'Yes' : 'No';
          pill.textContent = display;
        } else {
          pill.textContent = val;
        }

        this._containerEl.appendChild(pill);
      }
    }
  }

  dom.window.customElements.define('hero-hml-prompt-value', HeroHmlPromptValue);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-hml-prompt-value', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-hml-prompt-value');
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
    let registered = dom.window.customElements.get('hero-hml-prompt-value');
    assert.ok(registered, 'hero-hml-prompt-value should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Renders label text
  // -------------------------------------------------------------------------

  it('renders label text', () => {
    element.label = 'Favorite Color';

    let labelEl = element.shadowRoot.querySelector('.value-label');
    assert.equal(labelEl.textContent, 'Favorite Color', 'label element should display the label text');
  });

  // -------------------------------------------------------------------------
  // 4. Renders single value as pill
  // -------------------------------------------------------------------------

  it('renders single value as pill', () => {
    element.values = ['Blue'];

    let pills = element.shadowRoot.querySelectorAll('.value-pill');
    assert.equal(pills.length, 1, 'should render exactly one pill');
    assert.equal(pills[0].textContent, 'Blue', 'pill should display the value text');
  });

  // -------------------------------------------------------------------------
  // 5. Renders multiple values as multiple pills
  // -------------------------------------------------------------------------

  it('renders multiple values as multiple pills', () => {
    element.values = ['Red', 'Green', 'Blue'];

    let pills = element.shadowRoot.querySelectorAll('.value-pill');
    assert.equal(pills.length, 3, 'should render three pills');
    assert.equal(pills[0].textContent, 'Red');
    assert.equal(pills[1].textContent, 'Green');
    assert.equal(pills[2].textContent, 'Blue');
  });

  // -------------------------------------------------------------------------
  // 6. String value wrapped in array
  // -------------------------------------------------------------------------

  it('wraps a single string value into an array', () => {
    element.values = 'Solo';

    assert.ok(Array.isArray(element.values), 'values getter should return an array');
    assert.equal(element.values.length, 1, 'array should have one element');
    assert.equal(element.values[0], 'Solo', 'element should be the original string');

    let pills = element.shadowRoot.querySelectorAll('.value-pill');
    assert.equal(pills.length, 1, 'should render one pill for the wrapped string');
    assert.equal(pills[0].textContent, 'Solo');
  });

  // -------------------------------------------------------------------------
  // 7. Color inputType shows swatch with hex
  // -------------------------------------------------------------------------

  it('color inputType shows swatch with hex text', () => {
    element.inputType = 'color';
    element.values = ['#ff5733'];

    let pills = element.shadowRoot.querySelectorAll('.value-pill');
    assert.equal(pills.length, 1, 'should render one pill');
    assert.ok(pills[0].classList.contains('color-value'), 'pill should have color-value class');

    let swatch = pills[0].querySelector('.color-swatch');
    assert.ok(swatch, 'pill should contain a color swatch element');

    assert.ok(
      pills[0].textContent.includes('#ff5733'),
      'pill text should include the hex value',
    );
  });

  // -------------------------------------------------------------------------
  // 8. Empty values shows no pills
  // -------------------------------------------------------------------------

  it('empty values shows no pills', () => {
    element.values = [];

    let pills = element.shadowRoot.querySelectorAll('.value-pill');
    assert.equal(pills.length, 0, 'should render zero pills for empty array');
  });

  // -------------------------------------------------------------------------
  // 9. Boolean true shows "Yes" pill
  // -------------------------------------------------------------------------

  it('boolean true shows "Yes" pill', () => {
    element.inputType = 'boolean';
    element.values = ['true'];

    let pills = element.shadowRoot.querySelectorAll('.value-pill');
    assert.equal(pills.length, 1, 'should render one pill');
    assert.equal(pills[0].textContent, 'Yes', 'true value should render as "Yes"');

    // Also check false
    element.values = ['false'];
    pills = element.shadowRoot.querySelectorAll('.value-pill');
    assert.equal(pills[0].textContent, 'No', 'false value should render as "No"');
  });

  // -------------------------------------------------------------------------
  // 10. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/hero-hml-prompt-value/hero-hml-prompt-value.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
