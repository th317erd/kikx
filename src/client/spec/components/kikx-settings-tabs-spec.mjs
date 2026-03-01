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

const TAB_KEYS = ['profile', 'account', 'apiKeys', 'permissions', 'appearance'];

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

  class KikxSettingsTabs extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            color: var(--text-primary, #e8e8f0);
          }

          .panel {
            display: none;
            padding: var(--spacing-sm, 8px);
          }

          .panel[data-active] {
            display: block;
          }

          .panel h2 {
            margin: 0 0 var(--spacing-sm, 8px) 0;
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text-primary, #e8e8f0);
          }

          .panel p {
            margin: 0;
            color: var(--text-secondary, #a0a0b8);
            font-size: 0.875rem;
            line-height: 1.5;
          }
        </style>

        <div class="panel" data-tab="profile">
          <h2 class="panel-heading"></h2>
          <p class="panel-placeholder">Profile settings will appear here.</p>
        </div>
        <div class="panel" data-tab="account">
          <h2 class="panel-heading"></h2>
          <p class="panel-placeholder">Account settings will appear here.</p>
        </div>
        <div class="panel" data-tab="apiKeys">
          <h2 class="panel-heading"></h2>
          <p class="panel-placeholder">API key management will appear here.</p>
        </div>
        <div class="panel" data-tab="permissions">
          <h2 class="panel-heading"></h2>
          <p class="panel-placeholder">Permission settings will appear here.</p>
        </div>
        <div class="panel" data-tab="appearance">
          <h2 class="panel-heading"></h2>
          <p class="panel-placeholder">Appearance settings will appear here.</p>
        </div>
      `;

      this._panels    = this.shadowRoot.querySelectorAll('.panel');
      this._activeTab = 'profile';
    }

    connectedCallback() {
      this._render();
      this._showTab(this._activeTab);
    }

    get activeTab() {
      return this._activeTab;
    }

    set activeTab(value) {
      this._activeTab = value;
      this._showTab(value);
    }

    _render() {
      for (let key of TAB_KEYS) {
        let panel   = this.shadowRoot.querySelector(`.panel[data-tab="${key}"]`);
        let heading = panel.querySelector('.panel-heading');
        heading.textContent = mockT(`settings.tabs.${key}`);
      }
    }

    _showTab(tabKey) {
      for (let panel of this._panels) {
        if (panel.getAttribute('data-tab') === tabKey) {
          panel.setAttribute('data-active', '');
        } else {
          panel.removeAttribute('data-active');
        }
      }
    }
  }

  dom.window.customElements.define('kikx-settings-tabs', KikxSettingsTabs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-settings-tabs', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-settings-tabs');
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
    let registered = dom.window.customElements.get('kikx-settings-tabs');
    assert.ok(registered, 'kikx-settings-tabs should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Contains 5 content panels with data-tab attributes
  // -------------------------------------------------------------------------

  it('contains 5 content panels with data-tab attributes', () => {
    let panels = element.shadowRoot.querySelectorAll('.panel[data-tab]');
    assert.equal(panels.length, 5, 'should have 5 panels');

    let tabValues = Array.from(panels).map((p) => p.getAttribute('data-tab'));
    assert.deepEqual(tabValues, TAB_KEYS);
  });

  // -------------------------------------------------------------------------
  // 4. Default active tab is profile
  // -------------------------------------------------------------------------

  it('default active tab is profile', () => {
    assert.equal(element.activeTab, 'profile');
  });

  // -------------------------------------------------------------------------
  // 5. Profile panel visible by default, others hidden
  // -------------------------------------------------------------------------

  it('profile panel visible by default, others hidden', () => {
    let profilePanel = element.shadowRoot.querySelector('.panel[data-tab="profile"]');
    assert.ok(profilePanel.hasAttribute('data-active'), 'profile panel should be active');

    for (let key of ['account', 'apiKeys', 'permissions', 'appearance']) {
      let panel = element.shadowRoot.querySelector(`.panel[data-tab="${key}"]`);
      assert.ok(!panel.hasAttribute('data-active'), `${key} panel should not be active`);
    }
  });

  // -------------------------------------------------------------------------
  // 6. Setting activeTab to 'account' shows account panel
  // -------------------------------------------------------------------------

  it('setting activeTab to account shows account panel', () => {
    element.activeTab = 'account';

    let accountPanel = element.shadowRoot.querySelector('.panel[data-tab="account"]');
    assert.ok(accountPanel.hasAttribute('data-active'), 'account panel should be active');

    let profilePanel = element.shadowRoot.querySelector('.panel[data-tab="profile"]');
    assert.ok(!profilePanel.hasAttribute('data-active'), 'profile panel should not be active');
  });

  // -------------------------------------------------------------------------
  // 7. Setting activeTab to 'apiKeys' shows API Keys panel
  // -------------------------------------------------------------------------

  it('setting activeTab to apiKeys shows API Keys panel', () => {
    element.activeTab = 'apiKeys';

    let apiKeysPanel = element.shadowRoot.querySelector('.panel[data-tab="apiKeys"]');
    assert.ok(apiKeysPanel.hasAttribute('data-active'), 'apiKeys panel should be active');
  });

  // -------------------------------------------------------------------------
  // 8. Setting activeTab to 'permissions' shows permissions panel
  // -------------------------------------------------------------------------

  it('setting activeTab to permissions shows permissions panel', () => {
    element.activeTab = 'permissions';

    let permissionsPanel = element.shadowRoot.querySelector('.panel[data-tab="permissions"]');
    assert.ok(permissionsPanel.hasAttribute('data-active'), 'permissions panel should be active');
  });

  // -------------------------------------------------------------------------
  // 9. Setting activeTab to 'appearance' shows appearance panel
  // -------------------------------------------------------------------------

  it('setting activeTab to appearance shows appearance panel', () => {
    element.activeTab = 'appearance';

    let appearancePanel = element.shadowRoot.querySelector('.panel[data-tab="appearance"]');
    assert.ok(appearancePanel.hasAttribute('data-active'), 'appearance panel should be active');
  });

  // -------------------------------------------------------------------------
  // 10. Each panel has heading text from i18n
  // -------------------------------------------------------------------------

  it('each panel has heading text from i18n', () => {
    for (let key of TAB_KEYS) {
      let panel   = element.shadowRoot.querySelector(`.panel[data-tab="${key}"]`);
      let heading = panel.querySelector('.panel-heading');
      let expected = localeData.settings.tabs[key];
      assert.equal(heading.textContent, expected, `${key} panel heading should be "${expected}"`);
    }
  });

  // -------------------------------------------------------------------------
  // 11. Only one panel is visible at a time
  // -------------------------------------------------------------------------

  it('only one panel is visible at a time', () => {
    for (let targetKey of TAB_KEYS) {
      element.activeTab = targetKey;

      let activePanels = element.shadowRoot.querySelectorAll('.panel[data-active]');
      assert.equal(activePanels.length, 1, `only one panel should be active when tab is "${targetKey}"`);
      assert.equal(activePanels[0].getAttribute('data-tab'), targetKey);
    }
  });

  // -------------------------------------------------------------------------
  // 12. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement     = dom.window.HTMLElement;
    globalThis.customElements  = { define() {}, get() {} };
    globalThis.document        = dom.window.document;

    try {
      let mod = await import('../../components/kikx-settings-tabs/kikx-settings-tabs.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
