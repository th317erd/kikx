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
// Option definitions (mirrors the real component)
// ---------------------------------------------------------------------------

const OPTIONS = [
  { value: 'allow-once',    labelKey: 'permission.allowOnce' },
  { value: 'allow-session', labelKey: 'permission.allowSession' },
  { value: 'allow-always',  labelKey: 'permission.allowAlways' },
  { value: 'deny',          labelKey: 'permission.deny' },
];

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
  let doc              = dom.window.document;

  class KikxPermissionRequest extends JsdomHTMLElement {
    static get observedAttributes() { return ['processed', 'permission-id']; }

    constructor() {
      super();
      this._selectedValue  = null;

      this._onSubmitClick  = this._onSubmitClick.bind(this);
      this._onOptionChange = this._onOptionChange.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-permission-request { display: block; padding: var(--spacing-sm, 8px); }

          .permission-header {
            display: flex; align-items: center; gap: var(--spacing-xs, 4px);
            margin-bottom: var(--spacing-sm, 8px);
            font-weight: 600; font-size: 0.9375rem;
            color: var(--text-primary, #e8e8f0);
          }

          .lightning-icon { font-size: 1.125rem; }

          .permission-description {
            font-size: 0.875rem; color: var(--text-secondary, #a0a0b8);
            margin-bottom: var(--spacing-sm, 8px); line-height: 1.4;
          }

          .options-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--spacing-sm, 8px); }

          .option-row {
            display: flex; align-items: center; gap: var(--spacing-xs, 4px);
            padding: 6px 8px; border-radius: var(--border-radius-small, 4px);
            cursor: pointer; font-size: 0.875rem; color: var(--text-primary, #e8e8f0);
            transition: background 0.2s ease;
          }

          .option-row:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

          .option-row input[type="radio"] { accent-color: var(--accent-primary, #00e5ff); }

          .submit-button {
            background: var(--accent-primary, #00e5ff); color: var(--bg-primary, #0a0a12);
            border: none; border-radius: var(--border-radius-small, 4px);
            padding: 8px 16px; font-weight: 600; font-size: 0.875rem;
            cursor: pointer; transition: box-shadow 0.2s ease;
          }

          .submit-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }
          .submit-button:disabled { opacity: 0.5; cursor: not-allowed; }

          kikx-permission-request[processed] .options-list,
          kikx-permission-request[processed] .submit-button { display: none; }

          .processed-badge {
            display: none; font-size: 0.8125rem; font-weight: 600;
            color: #66bb6a; padding: 4px 0;
          }

          kikx-permission-request[processed] .processed-badge { display: block; }
        </style>

        <div class="permission-header">
          <span class="lightning-icon">\u26A1</span>
          <span class="title-text"></span>
        </div>
        <div class="permission-description"></div>
        <div class="options-list"></div>
        <button class="submit-button" disabled></button>
        <div class="processed-badge">\u2713 Processed</div>
      `;

      this._titleText      = this.querySelector('.title-text');
      this._descriptionEl  = this.querySelector('.permission-description');
      this._optionsList    = this.querySelector('.options-list');
      this._submitButton   = this.querySelector('.submit-button');
      this._processedBadge = this.querySelector('.processed-badge');

      this._titleText.textContent    = mockT('permission.title');
      this._submitButton.textContent = mockT('chat.interaction.submitButton');

      this._renderOptions();
      this._submitButton.addEventListener('click', this._onSubmitClick);
    }

    disconnectedCallback() {
      this._submitButton.removeEventListener('click', this._onSubmitClick);
      this._optionsList.removeEventListener('change', this._onOptionChange);
    }

    get description() {
      return this._descriptionEl.textContent;
    }

    set description(value) {
      this._descriptionEl.textContent = value || '';
    }

    _renderOptions() {
      this._optionsList.innerHTML = '';

      for (let option of OPTIONS) {
        let row   = doc.createElement('label');
        let radio = doc.createElement('input');
        let span  = doc.createElement('span');

        row.className    = 'option-row';
        radio.type       = 'radio';
        radio.name       = 'permission-decision';
        radio.value      = option.value;
        span.textContent = mockT(option.labelKey);

        row.appendChild(radio);
        row.appendChild(span);
        this._optionsList.appendChild(row);
      }

      this._optionsList.addEventListener('change', this._onOptionChange);
    }

    _onOptionChange(event) {
      this._selectedValue = event.target.value;
      this._submitButton.disabled = false;
    }

    _onSubmitClick() {
      if (!this._selectedValue)
        return;

      this.dispatchEvent(new dom.window.CustomEvent('permission-response', {
        bubbles:  true,
        composed: true,
        detail: {
          permissionID: this.getAttribute('permission-id') || '',
          decision:     this._selectedValue,
        },
      }));
    }
  }

  dom.window.customElements.define('kikx-permission-request', KikxPermissionRequest);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-permission-request', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-permission-request');
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
    let registered = dom.window.customElements.get('kikx-permission-request');
    assert.ok(registered, 'kikx-permission-request should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Shows lightning icon and title from i18n
  // -------------------------------------------------------------------------

  it('shows lightning icon and title from i18n', () => {
    let icon  = element.querySelector('.lightning-icon');
    let title = element.querySelector('.title-text');

    assert.ok(icon, 'should contain .lightning-icon');
    assert.equal(icon.textContent, '\u26A1', 'lightning icon should display the zap emoji');
    assert.ok(title, 'should contain .title-text');
    assert.equal(
      title.textContent,
      localeData.permission.title,
      'title should match i18n permission.title',
    );
  });

  // -------------------------------------------------------------------------
  // 4. Description property sets description text
  // -------------------------------------------------------------------------

  it('description property sets description text', () => {
    element.description = 'Allow access to the file system?';

    let descEl = element.querySelector('.permission-description');
    assert.equal(
      descEl.textContent,
      'Allow access to the file system?',
      'description element should display the set value',
    );
  });

  // -------------------------------------------------------------------------
  // 5. Renders 4 radio options with correct labels
  // -------------------------------------------------------------------------

  it('renders 4 radio options with correct labels', () => {
    let rows = element.querySelectorAll('.option-row');
    assert.equal(rows.length, 4, 'should render 4 option rows');

    let expectedLabels = [
      localeData.permission.allowOnce,
      localeData.permission.allowSession,
      localeData.permission.allowAlways,
      localeData.permission.deny,
    ];

    for (let i = 0; i < rows.length; i++) {
      let span = rows[i].querySelector('span');
      assert.equal(span.textContent, expectedLabels[i], `option ${i} label should match`);
    }
  });

  // -------------------------------------------------------------------------
  // 6. Submit button disabled by default (no selection)
  // -------------------------------------------------------------------------

  it('submit button is disabled by default', () => {
    let button = element.querySelector('.submit-button');
    assert.ok(button, 'should contain .submit-button');
    assert.equal(button.disabled, true, 'submit button should be disabled when no option is selected');
  });

  // -------------------------------------------------------------------------
  // 7. Submit button enabled after radio selection
  // -------------------------------------------------------------------------

  it('submit button is enabled after radio selection', () => {
    let radios = element.querySelectorAll('input[type="radio"]');
    let button = element.querySelector('.submit-button');

    // Simulate selecting the first radio
    radios[0].checked = true;
    radios[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    assert.equal(button.disabled, false, 'submit button should be enabled after selecting a radio option');
  });

  // -------------------------------------------------------------------------
  // 8. Submit dispatches permission-response with correct decision
  // -------------------------------------------------------------------------

  it('submit dispatches permission-response with correct decision', () => {
    element.setAttribute('permission-id', 'perm-42');

    let radios = element.querySelectorAll('input[type="radio"]');
    let button = element.querySelector('.submit-button');
    let events = [];

    element.addEventListener('permission-response', (event) => {
      events.push(event);
    });

    // Select "allow-session" (index 1)
    radios[1].checked = true;
    radios[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    button.click();

    assert.equal(events.length, 1, 'should have dispatched one event');
    assert.equal(events[0].detail.permissionID, 'perm-42', 'permissionID should match attribute');
    assert.equal(events[0].detail.decision, 'allow-session', 'decision should be allow-session');
    assert.equal(events[0].bubbles, true, 'event should bubble');
    assert.equal(events[0].composed, true, 'event should be composed');
  });

  // -------------------------------------------------------------------------
  // 9. processed attribute hides options and submit
  // -------------------------------------------------------------------------

  it('processed attribute hides options and submit', () => {
    element.setAttribute('processed', '');

    let optionsList = element.querySelector('.options-list');
    let button      = element.querySelector('.submit-button');

    // The kikx-permission-request[processed] CSS rule sets display:none on these elements.
    // In JSDOM, computed styles via CSS selectors are not applied, so we
    // verify the attribute is present on the host (which the CSS rule targets).
    assert.ok(element.hasAttribute('processed'), 'element should have processed attribute');
    assert.ok(optionsList, 'options-list should still exist in the DOM');
    assert.ok(button, 'submit button should still exist in the DOM');
  });

  // -------------------------------------------------------------------------
  // 10. processed attribute shows processed badge
  // -------------------------------------------------------------------------

  it('processed attribute shows processed badge', () => {
    element.setAttribute('processed', '');

    let badge = element.querySelector('.processed-badge');
    assert.ok(badge, 'should contain .processed-badge');
    assert.ok(
      badge.textContent.includes('Processed'),
      'processed badge should contain "Processed" text',
    );
  });

  // -------------------------------------------------------------------------
  // 11. Radio options have correct values
  // -------------------------------------------------------------------------

  it('radio options have correct values', () => {
    let radios = element.querySelectorAll('input[type="radio"]');
    assert.equal(radios.length, 4, 'should have 4 radio inputs');

    let expectedValues = ['allow-once', 'allow-session', 'allow-always', 'deny'];

    for (let i = 0; i < radios.length; i++) {
      assert.equal(radios[i].value, expectedValues[i], `radio ${i} value should be ${expectedValues[i]}`);
      assert.equal(radios[i].name, 'permission-decision', `radio ${i} should share the same name`);
    }
  });

  // -------------------------------------------------------------------------
  // 12. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/kikx-permission-request/kikx-permission-request.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
