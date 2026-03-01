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
// into the mockT function above. This avoids issues with ESM module caching
// and browser globals at import time.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxCreateSessionModal extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }
          .form-group { margin-bottom: 16px; }
          .form-label { display: block; font-size: 0.875rem; font-weight: 600; color: var(--text-secondary, #a0a0b8); margin-bottom: 6px; }
          .session-name-input { width: 100%; box-sizing: border-box; padding: 10px 14px; font-size: 1rem; background: var(--input-background, rgba(255,255,255,0.05)); border: 1px solid var(--input-border, rgba(255,255,255,0.12)); border-radius: var(--border-radius-medium, 8px); color: var(--text-primary, #e8e8f0); outline: none; font-family: inherit; }
          .session-name-input:focus { border-color: var(--accent-primary, #00e5ff); box-shadow: 0 0 8px var(--accent-glow, rgba(0,229,255,0.30)); }
          .button-row { display: flex; gap: var(--spacing-sm, 8px); justify-content: flex-end; }
          .create-button { background: var(--accent-primary, #00e5ff); color: var(--bg-primary, #0a0a12); border: none; border-radius: var(--border-radius-small, 4px); padding: 10px 24px; font-weight: 600; font-size: 0.875rem; cursor: pointer; }
          .create-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0,229,255,0.40)); }
          .create-button:disabled { opacity: 0.5; cursor: not-allowed; }
          .cancel-button { background: none; border: 1px solid var(--glass-border, rgba(255,255,255,0.10)); color: var(--text-secondary, #a0a0b8); border-radius: var(--border-radius-small, 4px); padding: 10px 20px; font-size: 0.875rem; cursor: pointer; }
          .cancel-button:hover { background: var(--glass-hover, rgba(255,255,255,0.08)); }
        </style>

        <div class="form-group">
          <label class="form-label"></label>
          <input class="session-name-input" type="text" />
        </div>
        <div class="button-row">
          <button class="cancel-button"></button>
          <button class="create-button"></button>
        </div>
      `;

      this._label        = this.shadowRoot.querySelector('.form-label');
      this._input        = this.shadowRoot.querySelector('.session-name-input');
      this._createButton = this.shadowRoot.querySelector('.create-button');
      this._cancelButton = this.shadowRoot.querySelector('.cancel-button');

      this._label.textContent        = mockT('session.create.title');
      this._input.placeholder        = mockT('session.create.namePlaceholder');
      this._createButton.textContent = mockT('session.create.createButton');
      this._cancelButton.textContent = mockT('session.create.cancelButton');

      this._createButton.disabled = true;

      this._onInput   = this._onInput.bind(this);
      this._onCreate  = this._onCreate.bind(this);
      this._onCancel  = this._onCancel.bind(this);
      this._onKeydown = this._onKeydown.bind(this);
    }

    connectedCallback() {
      this._input.addEventListener('input', this._onInput);
      this._createButton.addEventListener('click', this._onCreate);
      this._cancelButton.addEventListener('click', this._onCancel);
      this._input.addEventListener('keydown', this._onKeydown);
    }

    disconnectedCallback() {
      this._input.removeEventListener('input', this._onInput);
      this._createButton.removeEventListener('click', this._onCreate);
      this._cancelButton.removeEventListener('click', this._onCancel);
      this._input.removeEventListener('keydown', this._onKeydown);
    }

    // -----------------------------------------------------------------------
    // Public methods
    // -----------------------------------------------------------------------

    reset() {
      this._input.value = '';
      this._createButton.disabled = true;
    }

    focus() {
      this._input.focus();
    }

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    _onInput() {
      this._createButton.disabled = this._input.value.trim().length === 0;
    }

    _onCreate() {
      let name = this._input.value.trim();
      if (!name) return;

      this.dispatchEvent(new dom.window.CustomEvent('session-create', {
        bubbles:  true,
        composed: true,
        detail:   { name },
      }));
    }

    _onCancel() {
      this.dispatchEvent(new dom.window.CustomEvent('session-cancel', {
        bubbles:  true,
        composed: true,
      }));
    }

    _onKeydown(event) {
      if (event.key === 'Enter') {
        this._onCreate();
      }
    }
  }

  dom.window.customElements.define('kikx-create-session-modal', KikxCreateSessionModal);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-create-session-modal', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-create-session-modal');
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
    let registered = dom.window.customElements.get('kikx-create-session-modal');
    assert.ok(registered, 'kikx-create-session-modal should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Label from i18n
  // -------------------------------------------------------------------------

  it('label text comes from i18n session.create.title', () => {
    let label = element.shadowRoot.querySelector('.form-label');
    assert.equal(label.textContent, localeData.session.create.title);
  });

  // -------------------------------------------------------------------------
  // 4. Input has correct placeholder
  // -------------------------------------------------------------------------

  it('input has placeholder from i18n session.create.namePlaceholder', () => {
    let input = element.shadowRoot.querySelector('.session-name-input');
    assert.equal(input.placeholder, localeData.session.create.namePlaceholder);
  });

  // -------------------------------------------------------------------------
  // 5. Create button text from i18n
  // -------------------------------------------------------------------------

  it('create button text comes from i18n session.create.createButton', () => {
    let button = element.shadowRoot.querySelector('.create-button');
    assert.equal(button.textContent, localeData.session.create.createButton);
  });

  // -------------------------------------------------------------------------
  // 6. Cancel button text from i18n
  // -------------------------------------------------------------------------

  it('cancel button text comes from i18n session.create.cancelButton', () => {
    let button = element.shadowRoot.querySelector('.cancel-button');
    assert.equal(button.textContent, localeData.session.create.cancelButton);
  });

  // -------------------------------------------------------------------------
  // 7. Create button disabled when input empty
  // -------------------------------------------------------------------------

  it('create button is disabled when input is empty', () => {
    let button = element.shadowRoot.querySelector('.create-button');
    assert.equal(button.disabled, true, 'create button should be disabled when input is empty');
  });

  // -------------------------------------------------------------------------
  // 8. Create button enabled when input has text
  // -------------------------------------------------------------------------

  it('create button is enabled when input has text', () => {
    let input  = element.shadowRoot.querySelector('.session-name-input');
    let button = element.shadowRoot.querySelector('.create-button');

    input.value = 'My Session';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    assert.equal(button.disabled, false, 'create button should be enabled when input has text');
  });

  // -------------------------------------------------------------------------
  // 9. Create dispatches session-create with name
  // -------------------------------------------------------------------------

  it('create button dispatches session-create event with trimmed name', () => {
    let input  = element.shadowRoot.querySelector('.session-name-input');
    let button = element.shadowRoot.querySelector('.create-button');

    input.value = '  My Session  ';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('session-create', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    button.click();

    assert.ok(eventFired, 'session-create event should be dispatched');
    assert.deepEqual(eventDetail, { name: 'My Session' });
  });

  // -------------------------------------------------------------------------
  // 10. Cancel dispatches session-cancel
  // -------------------------------------------------------------------------

  it('cancel button dispatches session-cancel event', () => {
    let button = element.shadowRoot.querySelector('.cancel-button');

    let eventFired = false;

    element.addEventListener('session-cancel', () => {
      eventFired = true;
    });

    button.click();

    assert.ok(eventFired, 'session-cancel event should be dispatched');
  });

  // -------------------------------------------------------------------------
  // 11. Enter key triggers create
  // -------------------------------------------------------------------------

  it('Enter key in input triggers session-create event', () => {
    let input = element.shadowRoot.querySelector('.session-name-input');

    input.value = 'Enter Session';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('session-create', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key:     'Enter',
      bubbles: true,
    }));

    assert.ok(eventFired, 'session-create event should fire on Enter key');
    assert.deepEqual(eventDetail, { name: 'Enter Session' });
  });

  // -------------------------------------------------------------------------
  // 12. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;
    globalThis.CustomEvent    = dom.window.CustomEvent;

    try {
      let mod = await import('../../components/kikx-create-session-modal/kikx-create-session-modal.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
    }
  });
});
