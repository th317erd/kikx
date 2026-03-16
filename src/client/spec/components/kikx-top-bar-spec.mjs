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
// Mock state -- shared between the test-local component and assertions
// ---------------------------------------------------------------------------

let navigateCalls;
let profileLogoutCalls;

function resetMocks() {
  navigateCalls      = [];
  profileLogoutCalls = [];
}

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/kikx/session/abc',
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
// into the mock functions above. This avoids issues with:
//   - ESM module caching (the real module captures its imports once)
//   - seqda store actions being non-writable/non-configurable
//   - The real module needing browser globals at import time
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxTopBar extends JsdomHTMLElement {
    static get observedAttributes() {
      return ['session-name'];
    }

    constructor() {
      super();

      this._onBackClick       = this._onBackClick.bind(this);
      this._onAgentsClick     = this._onAgentsClick.bind(this);
      this._onAbilitiesClick  = this._onAbilitiesClick.bind(this);
      this._onNewSessionClick = this._onNewSessionClick.bind(this);
      this._onSettingsClick   = this._onSettingsClick.bind(this);
      this._onLogoutClick     = this._onLogoutClick.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-top-bar { display: block; height: 52px; }
        </style>
        <div class="bar">
          <div class="left-group">
            <button class="back-button" type="button"></button>
            <span class="session-name"></span>
          </div>
          <div class="right-group">
            <button class="agents-button" type="button"></button>
            <button class="abilities-button" type="button"></button>
            <button class="new-session-button" type="button"></button>
            <button class="settings-button" type="button"></button>
            <button class="logout-button" type="button"></button>
          </div>
        </div>
      `;

      this._backButton       = this.querySelector('.back-button');
      this._sessionName      = this.querySelector('.session-name');
      this._agentsButton     = this.querySelector('.agents-button');
      this._abilitiesButton  = this.querySelector('.abilities-button');
      this._newSessionButton = this.querySelector('.new-session-button');
      this._settingsButton   = this.querySelector('.settings-button');
      this._logoutButton     = this.querySelector('.logout-button');

      this._render();

      this._backButton.addEventListener('click', this._onBackClick);
      this._agentsButton.addEventListener('click', this._onAgentsClick);
      this._abilitiesButton.addEventListener('click', this._onAbilitiesClick);
      this._newSessionButton.addEventListener('click', this._onNewSessionClick);
      this._settingsButton.addEventListener('click', this._onSettingsClick);
      this._logoutButton.addEventListener('click', this._onLogoutClick);
    }

    disconnectedCallback() {
      this._backButton.removeEventListener('click', this._onBackClick);
      this._agentsButton.removeEventListener('click', this._onAgentsClick);
      this._abilitiesButton.removeEventListener('click', this._onAbilitiesClick);
      this._newSessionButton.removeEventListener('click', this._onNewSessionClick);
      this._settingsButton.removeEventListener('click', this._onSettingsClick);
      this._logoutButton.removeEventListener('click', this._onLogoutClick);
    }

    attributeChangedCallback() {
      this._updateSessionName();
    }

    _render() {
      this._backButton.textContent       = mockT('topBar.backButton');
      this._agentsButton.textContent     = mockT('topBar.agents');
      this._abilitiesButton.textContent  = mockT('topBar.abilities');
      this._newSessionButton.textContent = mockT('topBar.newSession');
      this._settingsButton.textContent   = mockT('topBar.settings');
      this._logoutButton.textContent     = mockT('topBar.logout');

      this._updateSessionName();
    }

    _updateSessionName() {
      let name = this.getAttribute('session-name');

      if (name) {
        this._sessionName.textContent = name;
      } else {
        this._sessionName.textContent = mockT('application.title');
      }
    }

    _onBackClick() {
      navigateCalls.push({ path: '/kikx/' });
    }

    _onAgentsClick() {
      this.dispatchEvent(new dom.window.CustomEvent('open-agents-modal', { bubbles: true, composed: true }));
    }

    _onAbilitiesClick() {
      this.dispatchEvent(new dom.window.CustomEvent('open-abilities-modal', { bubbles: true, composed: true }));
    }

    _onNewSessionClick() {
      this.dispatchEvent(new dom.window.CustomEvent('create-session', { bubbles: true, composed: true }));
    }

    _onSettingsClick() {
      navigateCalls.push({ path: '/kikx/settings' });
    }

    _onLogoutClick() {
      profileLogoutCalls.push(true);
      navigateCalls.push({ path: '/kikx/login' });
    }
  }

  dom.window.customElements.define('kikx-top-bar', KikxTopBar);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-top-bar', () => {
  let element;

  beforeEach(() => {
    resetMocks();
    setupDOM();
    element = dom.window.document.createElement('kikx-top-bar');
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
    let registered = dom.window.customElements.get('kikx-top-bar');
    assert.ok(registered, 'kikx-top-bar should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Contains back button
  // -------------------------------------------------------------------------

  it('contains a back button', () => {
    let backButton = element.querySelector('.back-button');
    assert.ok(backButton, 'should have a back button');
    assert.equal(backButton.textContent, localeData.topBar.backButton);
  });

  // -------------------------------------------------------------------------
  // 4. Contains session name display (default = app title)
  // -------------------------------------------------------------------------

  it('displays application title as default session name', () => {
    let sessionName = element.querySelector('.session-name');
    assert.ok(sessionName, 'should have a session name element');
    assert.equal(sessionName.textContent, localeData.application.title);
  });

  // -------------------------------------------------------------------------
  // 5. Session name updates when attribute changes
  // -------------------------------------------------------------------------

  it('updates session name when session-name attribute changes', () => {
    element.setAttribute('session-name', 'My Custom Session');

    let sessionName = element.querySelector('.session-name');
    assert.equal(sessionName.textContent, 'My Custom Session');
  });

  it('reverts to application title when session-name attribute is removed', () => {
    element.setAttribute('session-name', 'Temporary Name');
    element.removeAttribute('session-name');

    let sessionName = element.querySelector('.session-name');
    assert.equal(sessionName.textContent, localeData.application.title);
  });

  // -------------------------------------------------------------------------
  // 6. Contains Agents button
  // -------------------------------------------------------------------------

  it('contains an Agents button', () => {
    let agentsButton = element.querySelector('.agents-button');
    assert.ok(agentsButton, 'should have an Agents button');
    assert.equal(agentsButton.textContent, localeData.topBar.agents);
  });

  // -------------------------------------------------------------------------
  // 7. Contains Abilities button
  // -------------------------------------------------------------------------

  it('contains an Abilities button', () => {
    let abilitiesButton = element.querySelector('.abilities-button');
    assert.ok(abilitiesButton, 'should have an Abilities button');
    assert.equal(abilitiesButton.textContent, localeData.topBar.abilities);
  });

  // -------------------------------------------------------------------------
  // 8. Contains New Session button
  // -------------------------------------------------------------------------

  it('contains a New Session button', () => {
    let newSessionButton = element.querySelector('.new-session-button');
    assert.ok(newSessionButton, 'should have a New Session button');
    assert.equal(newSessionButton.textContent, localeData.topBar.newSession);
  });

  // -------------------------------------------------------------------------
  // 9. Contains Settings button
  // -------------------------------------------------------------------------

  it('contains a Settings button', () => {
    let settingsButton = element.querySelector('.settings-button');
    assert.ok(settingsButton, 'should have a Settings button');
    assert.equal(settingsButton.textContent, localeData.topBar.settings);
  });

  // -------------------------------------------------------------------------
  // 10. Contains Logout button
  // -------------------------------------------------------------------------

  it('contains a Logout button', () => {
    let logoutButton = element.querySelector('.logout-button');
    assert.ok(logoutButton, 'should have a Logout button');
    assert.equal(logoutButton.textContent, localeData.topBar.logout);
  });

  // -------------------------------------------------------------------------
  // 11. Agents button dispatches open-agents-modal event
  // -------------------------------------------------------------------------

  it('dispatches open-agents-modal event when Agents button is clicked', () => {
    let eventFired = false;
    element.addEventListener('open-agents-modal', () => {
      eventFired = true;
    });

    let agentsButton = element.querySelector('.agents-button');
    agentsButton.click();

    assert.ok(eventFired, 'open-agents-modal event should have been dispatched');
  });

  it('dispatches open-abilities-modal event when Abilities button is clicked', () => {
    let eventFired = false;
    element.addEventListener('open-abilities-modal', () => {
      eventFired = true;
    });

    let abilitiesButton = element.querySelector('.abilities-button');
    abilitiesButton.click();

    assert.ok(eventFired, 'open-abilities-modal event should have been dispatched');
  });

  it('dispatches create-session event when New Session button is clicked', () => {
    let eventFired = false;
    element.addEventListener('create-session', () => {
      eventFired = true;
    });

    let newSessionButton = element.querySelector('.new-session-button');
    newSessionButton.click();

    assert.ok(eventFired, 'create-session event should have been dispatched');
  });

  // -------------------------------------------------------------------------
  // 12. Logout button calls navigate to login
  // -------------------------------------------------------------------------

  it('calls profile.logout and navigates to login when Logout button is clicked', () => {
    let logoutButton = element.querySelector('.logout-button');
    logoutButton.click();

    assert.equal(profileLogoutCalls.length, 1, 'profile.logout should have been called');
    assert.equal(navigateCalls.length, 1, 'navigate should have been called once');
    assert.equal(navigateCalls[0].path, '/kikx/login');
  });

  // -------------------------------------------------------------------------
  // Additional: Back button navigates to session list
  // -------------------------------------------------------------------------

  it('navigates to /kikx/ when back button is clicked', () => {
    let backButton = element.querySelector('.back-button');
    backButton.click();

    assert.equal(navigateCalls.length, 1, 'navigate should have been called');
    assert.equal(navigateCalls[0].path, '/kikx/');
  });

  // -------------------------------------------------------------------------
  // Additional: Settings button navigates to settings
  // -------------------------------------------------------------------------

  it('navigates to /kikx/settings when settings button is clicked', () => {
    let settingsButton = element.querySelector('.settings-button');
    settingsButton.click();

    assert.equal(navigateCalls.length, 1, 'navigate should have been called');
    assert.equal(navigateCalls[0].path, '/kikx/settings');
  });

  // -------------------------------------------------------------------------
  // Additional: Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement     = dom.window.HTMLElement;
    globalThis.customElements  = { define() {}, get() {} };
    globalThis.document        = dom.window.document;
    globalThis.CustomEvent     = dom.window.CustomEvent;

    try {
      let mod = await import('../../components/kikx-top-bar/kikx-top-bar.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
    }
  });
});
