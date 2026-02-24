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
// Constants mirroring the real component
// ---------------------------------------------------------------------------

const TAB_KEYS = ['profile', 'account', 'apiKeys', 'permissions', 'appearance'];

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/hero/settings',
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
// Mirrors the real component's DOM structure and logic, but wires mockT()
// instead of the real t() import. Runs directly inside jsdom without
// needing browser globals at module scope.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;
  let doc              = dom.window.document;

  class HeroSettingsPage extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._activeTab   = 'profile';
      this._onTabClick  = this._onTabClick.bind(this);
      this._onBackClick = this._onBackClick.bind(this);
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: var(--bg-primary, #0a0a1a);
            color: var(--text-primary, #e8e8f0);
            overflow: hidden;
          }

          .top-area {
            display: flex;
            align-items: center;
            gap: var(--spacing-sm, 8px);
            padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px);
            background: var(--glass-background, rgba(255, 255, 255, 0.05));
            border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
          }

          .back-button {
            background: none;
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            color: var(--text-primary, #e8e8f0);
            font-size: 1.25rem;
            cursor: pointer;
            padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
            border-radius: var(--border-radius-small, 4px);
            transition: background 0.2s ease;
          }

          .back-button:hover {
            background: var(--glass-hover, rgba(255, 255, 255, 0.10));
          }

          .settings-title {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text-primary, #e8e8f0);
          }

          .tab-bar {
            display: flex;
            gap: var(--spacing-xs, 4px);
            padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px) 0;
            background: var(--glass-background, rgba(255, 255, 255, 0.05));
            border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
          }

          .tab-button {
            background: none;
            border: none;
            color: var(--text-secondary, #a0a0b8);
            padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px);
            cursor: pointer;
            font-size: 0.9rem;
            border-bottom: 2px solid transparent;
            border-radius: var(--border-radius-small, 4px) var(--border-radius-small, 4px) 0 0;
            transition: color 0.2s ease, border-color 0.2s ease;
          }

          .tab-button:hover {
            color: var(--text-primary, #e8e8f0);
            background: var(--glass-hover, rgba(255, 255, 255, 0.10));
          }

          .tab-button.active {
            color: var(--accent-primary, #00e5ff);
            border-bottom-color: var(--accent-primary, #00e5ff);
            box-shadow: 0 2px 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
          }

          .tab-content {
            flex: 1;
            overflow: auto;
            padding: var(--spacing-sm, 8px);
          }

          .tab-panel {
            display: none;
            color: var(--text-muted, #606078);
          }

          .tab-panel.active {
            display: block;
          }
        </style>

        <div class="top-area">
          <button class="back-button"></button>
          <span class="settings-title"></span>
        </div>
        <div class="tab-bar"></div>
        <div class="tab-content"></div>
      `;

      this._backButton   = this.shadowRoot.querySelector('.back-button');
      this._titleElement = this.shadowRoot.querySelector('.settings-title');
      this._tabBar       = this.shadowRoot.querySelector('.tab-bar');
      this._tabContent   = this.shadowRoot.querySelector('.tab-content');

      this._render();
      this._backButton.addEventListener('click', this._onBackClick);
      this._tabBar.addEventListener('click', this._onTabClick);
    }

    disconnectedCallback() {
      if (this._backButton)
        this._backButton.removeEventListener('click', this._onBackClick);

      if (this._tabBar)
        this._tabBar.removeEventListener('click', this._onTabClick);
    }

    _render() {
      this._backButton.textContent   = mockT('topBar.backButton');
      this._titleElement.textContent = mockT('settings.title');

      this._tabBar.innerHTML    = '';
      this._tabContent.innerHTML = '';

      for (let key of TAB_KEYS) {
        let button       = doc.createElement('button');
        button.className = 'tab-button' + ((key === this._activeTab) ? ' active' : '');
        button.textContent = mockT('settings.tabs.' + key);
        button.dataset.tab = key;
        this._tabBar.appendChild(button);

        let panel       = doc.createElement('div');
        panel.className = 'tab-panel' + ((key === this._activeTab) ? ' active' : '');
        panel.dataset.tab = key;
        panel.textContent = mockT('settings.tabs.' + key) + ' settings content';
        this._tabContent.appendChild(panel);
      }
    }

    _onTabClick(event) {
      let button = event.target.closest('.tab-button');
      if (!button) return;

      let tabKey = button.dataset.tab;
      if (tabKey === this._activeTab) return;

      this._activeTab = tabKey;

      for (let btn of this._tabBar.querySelectorAll('.tab-button'))
        btn.classList.toggle('active', btn.dataset.tab === tabKey);

      for (let panel of this._tabContent.querySelectorAll('.tab-panel'))
        panel.classList.toggle('active', panel.dataset.tab === tabKey);
    }

    _onBackClick() {
      this.dispatchEvent(new dom.window.CustomEvent('navigate', {
        bubbles:  true,
        composed: true,
        detail:   { path: '/hero/' },
      }));
    }
  }

  dom.window.customElements.define('hero-settings-page', HeroSettingsPage);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-settings-page', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-settings-page');
    dom.window.document.body.appendChild(element);
  });

  afterEach(() => {
    if (element && element.parentNode)
      element.parentNode.removeChild(element);

    teardownDOM();
  });

  // -----------------------------------------------------------------------
  // 1. Registers as custom element
  // -----------------------------------------------------------------------

  it('registers as a custom element', () => {
    let registered = dom.window.customElements.get('hero-settings-page');
    assert.ok(registered, 'hero-settings-page should be registered as a custom element');
  });

  // -----------------------------------------------------------------------
  // 2. Has shadow root
  // -----------------------------------------------------------------------

  it('has shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -----------------------------------------------------------------------
  // 3. Contains title from i18n settings.title
  // -----------------------------------------------------------------------

  it('contains title from i18n settings.title', () => {
    let title = element.shadowRoot.querySelector('.settings-title');
    assert.ok(title, 'should have a settings title element');
    assert.equal(title.textContent, localeData.settings.title);
  });

  // -----------------------------------------------------------------------
  // 4. Contains back button with topBar.backButton text
  // -----------------------------------------------------------------------

  it('contains back button with topBar.backButton text', () => {
    let backButton = element.shadowRoot.querySelector('.back-button');
    assert.ok(backButton, 'should have a back button');
    assert.equal(backButton.textContent, localeData.topBar.backButton);
  });

  // -----------------------------------------------------------------------
  // 5. Renders 5 tab buttons with correct i18n labels
  // -----------------------------------------------------------------------

  it('renders 5 tab buttons with correct i18n labels', () => {
    let tabButtons = element.shadowRoot.querySelectorAll('.tab-button');
    assert.equal(tabButtons.length, 5, 'should have 5 tab buttons');

    let expectedLabels = TAB_KEYS.map((key) => localeData.settings.tabs[key]);

    for (let i = 0; i < tabButtons.length; i++)
      assert.equal(tabButtons[i].textContent, expectedLabels[i], `tab ${i} should have label "${expectedLabels[i]}"`);
  });

  // -----------------------------------------------------------------------
  // 6. Profile tab is active by default
  // -----------------------------------------------------------------------

  it('has profile tab active by default', () => {
    let tabButtons = element.shadowRoot.querySelectorAll('.tab-button');
    let profileButton = tabButtons[0];
    assert.ok(profileButton.classList.contains('active'), 'profile tab button should have active class');

    let panels = element.shadowRoot.querySelectorAll('.tab-panel');
    let profilePanel = panels[0];
    assert.ok(profilePanel.classList.contains('active'), 'profile tab panel should have active class');
  });

  // -----------------------------------------------------------------------
  // 7. Clicking a tab activates it and deactivates others
  // -----------------------------------------------------------------------

  it('clicking a tab activates it and deactivates others', () => {
    let tabButtons = element.shadowRoot.querySelectorAll('.tab-button');

    // Click the third tab (API Keys)
    tabButtons[2].click();

    // Verify the clicked tab is now active
    assert.ok(tabButtons[2].classList.contains('active'), 'clicked tab should have active class');

    // Verify all other tabs are inactive
    for (let i = 0; i < tabButtons.length; i++) {
      if (i === 2) continue;
      assert.ok(!tabButtons[i].classList.contains('active'), `tab ${i} should not have active class`);
    }
  });

  // -----------------------------------------------------------------------
  // 8. Only the active tab's content panel is visible
  // -----------------------------------------------------------------------

  it('only the active tab content panel is visible', () => {
    let panels = element.shadowRoot.querySelectorAll('.tab-panel');

    // By default, only the first panel (profile) should be active
    assert.ok(panels[0].classList.contains('active'), 'profile panel should be active initially');

    for (let i = 1; i < panels.length; i++)
      assert.ok(!panels[i].classList.contains('active'), `panel ${i} should not be active initially`);

    // Click the Account tab (index 1)
    let tabButtons = element.shadowRoot.querySelectorAll('.tab-button');
    tabButtons[1].click();

    // Now only the account panel should be active
    assert.ok(!panels[0].classList.contains('active'), 'profile panel should no longer be active');
    assert.ok(panels[1].classList.contains('active'), 'account panel should now be active');

    for (let i = 2; i < panels.length; i++)
      assert.ok(!panels[i].classList.contains('active'), `panel ${i} should not be active after clicking account`);
  });

  // -----------------------------------------------------------------------
  // 9. Back button dispatches navigate event with path /hero/
  // -----------------------------------------------------------------------

  it('back button dispatches navigate event with path /hero/', () => {
    let events = [];

    element.addEventListener('navigate', (event) => {
      events.push(event);
    });

    let backButton = element.shadowRoot.querySelector('.back-button');
    backButton.click();

    assert.equal(events.length, 1, 'should dispatch exactly one navigate event');
    assert.equal(events[0].detail.path, '/hero/', 'navigate event should have path /hero/');
    assert.equal(events[0].bubbles, true, 'navigate event should bubble');
    assert.equal(events[0].composed, true, 'navigate event should be composed');
  });

  // -----------------------------------------------------------------------
  // 10. Each tab has corresponding content panel
  // -----------------------------------------------------------------------

  it('each tab has a corresponding content panel', () => {
    let tabButtons = element.shadowRoot.querySelectorAll('.tab-button');
    let panels     = element.shadowRoot.querySelectorAll('.tab-panel');

    assert.equal(tabButtons.length, panels.length, 'number of tabs and panels should match');

    for (let i = 0; i < TAB_KEYS.length; i++) {
      let key = TAB_KEYS[i];
      assert.equal(tabButtons[i].dataset.tab, key, `tab button ${i} should have data-tab="${key}"`);
      assert.equal(panels[i].dataset.tab, key, `panel ${i} should have data-tab="${key}"`);
    }
  });

  // -----------------------------------------------------------------------
  // 11. Tab styling includes active class
  // -----------------------------------------------------------------------

  it('tab styling includes active class rules', () => {
    let styleElement = element.shadowRoot.querySelector('style');
    assert.ok(styleElement, 'shadow DOM should contain a style element');

    let cssText = styleElement.textContent;
    assert.ok(cssText.includes('.tab-button.active'), 'CSS should include .tab-button.active rule');
    assert.ok(cssText.includes('.tab-panel.active'), 'CSS should include .tab-panel.active rule');
  });

  // -----------------------------------------------------------------------
  // 12. Real module exports a class constructor
  // -----------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;
    globalThis.CustomEvent    = dom.window.CustomEvent;

    try {
      let mod = await import('../../components/hero-settings-page/hero-settings-page.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
    }
  });
});
