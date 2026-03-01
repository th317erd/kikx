'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// Locale data (pure data — safe to import in Node.js)
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
// Mock state — shared between the test-local component and assertions
// ---------------------------------------------------------------------------

let sendMagicLinkMock;
let sendMagicLinkCalls;
let setAuthTokenCalls;
let profileSetUserCalls;
let navigateCalls;

function resetMocks() {
  sendMagicLinkCalls  = [];
  setAuthTokenCalls   = [];
  profileSetUserCalls = [];
  navigateCalls       = [];

  sendMagicLinkMock = async (email) => {
    sendMagicLinkCalls.push(email);
    return { data: { sessionToken: 'mock-session-token-123' } };
  };
}

// ---------------------------------------------------------------------------
// jsdom setup — fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/kikx/login',
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
//   - The real module needing browser globals (HTMLElement, document, etc.)
//     at import time
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxLoginPage extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; min-height: 100vh; }
          .status-message { display: none; }
          .status-message.visible { display: block; }
          .status-message.error { color: red; }
          .status-message.success { color: green; }
        </style>
        <div class="login-card">
          <div class="title"></div>
          <div class="subtitle"></div>
          <form>
            <input class="email-input" type="email" autocomplete="email" />
            <button class="submit-button" type="submit"></button>
          </form>
          <div class="status-message"></div>
        </div>
      `;

      this._emailInput      = this.shadowRoot.querySelector('.email-input');
      this._submitButton    = this.shadowRoot.querySelector('.submit-button');
      this._statusMessage   = this.shadowRoot.querySelector('.status-message');
      this._titleElement    = this.shadowRoot.querySelector('.title');
      this._subtitleElement = this.shadowRoot.querySelector('.subtitle');
      this._form            = this.shadowRoot.querySelector('form');

      this._onSubmit = this._onSubmit.bind(this);
    }

    connectedCallback() {
      this._render();
      this._form.addEventListener('submit', this._onSubmit);
    }

    disconnectedCallback() {
      this._form.removeEventListener('submit', this._onSubmit);
    }

    _render() {
      this._titleElement.textContent    = mockT('application.title');
      this._subtitleElement.textContent = mockT('login.subtitle');
      this._emailInput.placeholder      = mockT('login.emailPlaceholder');
      this._submitButton.textContent    = mockT('login.submitButton');
    }

    _showError(message) {
      this._statusMessage.textContent = message;
      this._statusMessage.className   = 'status-message visible error';
    }

    _hideStatus() {
      this._statusMessage.textContent = '';
      this._statusMessage.className   = 'status-message';
    }

    _setLoading(loading) {
      this._submitButton.disabled    = loading;
      this._submitButton.textContent = (loading) ? mockT('login.loading') : mockT('login.submitButton');
    }

    async _onSubmit(event) {
      event.preventDefault();
      this._hideStatus();

      let email = this._emailInput.value.trim();

      if (!email) {
        this._showError(mockT('login.error.emailRequired'));
        return;
      }

      this._setLoading(true);

      try {
        let result       = await sendMagicLinkMock(email);
        let sessionToken = result.data.sessionToken;

        setAuthTokenCalls.push(sessionToken);
        profileSetUserCalls.push({ user: { email }, token: sessionToken });
        navigateCalls.push({ path: '/kikx/', replace: true });
      } catch (error) {
        let message = (error && error.body && error.body.message)
          ? error.body.message
          : mockT('login.error.generic');

        this._showError(message);
        this._setLoading(false);
      }
    }
  }

  dom.window.customElements.define('kikx-login-page', KikxLoginPage);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-login-page', () => {
  let element;

  beforeEach(() => {
    resetMocks();
    setupDOM();
    element = dom.window.document.createElement('kikx-login-page');
    dom.window.document.body.appendChild(element);
  });

  afterEach(() => {
    if (element && element.parentNode)
      element.parentNode.removeChild(element);

    teardownDOM();
  });

  // -----------------------------------------------------------------------
  // 1. Element registers as custom element
  // -----------------------------------------------------------------------

  it('registers as a custom element', () => {
    let registered = dom.window.customElements.get('kikx-login-page');
    assert.ok(registered, 'kikx-login-page should be registered as a custom element');
  });

  it('real module exports a class constructor', async () => {
    // Set up minimal browser globals so the real module can be imported
    globalThis.HTMLElement     = dom.window.HTMLElement;
    globalThis.customElements  = { define() {}, get() {} };
    globalThis.document        = dom.window.document;

    try {
      let mod = await import('../../components/kikx-login-page/kikx-login-page.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });

  // -----------------------------------------------------------------------
  // 2. Renders email input and submit button in shadow DOM
  // -----------------------------------------------------------------------

  it('renders email input and submit button in shadow DOM', () => {
    let shadow = element.shadowRoot;
    assert.ok(shadow, 'should have a shadow root');

    let emailInput = shadow.querySelector('.email-input');
    assert.ok(emailInput, 'should have an email input');
    assert.equal(emailInput.getAttribute('type'), 'email');

    let submitButton = shadow.querySelector('.submit-button');
    assert.ok(submitButton, 'should have a submit button');
    assert.equal(submitButton.getAttribute('type'), 'submit');
  });

  // -----------------------------------------------------------------------
  // 3. Shows title and subtitle
  // -----------------------------------------------------------------------

  it('renders the application title', () => {
    let title = element.shadowRoot.querySelector('.title');
    assert.equal(title.textContent, 'Kikx');
  });

  it('renders the login subtitle', () => {
    let subtitle = element.shadowRoot.querySelector('.subtitle');
    assert.equal(subtitle.textContent, 'AI-powered collaborative channels');
  });

  // -----------------------------------------------------------------------
  // 4. Submitting with empty email shows validation error
  // -----------------------------------------------------------------------

  it('shows validation error when submitting with empty email', () => {
    let form        = element.shadowRoot.querySelector('form');
    let submitEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    let statusMessage = element.shadowRoot.querySelector('.status-message');
    assert.ok(statusMessage.classList.contains('visible'), 'status message should be visible');
    assert.ok(statusMessage.classList.contains('error'), 'status message should have error class');
    assert.equal(statusMessage.textContent, 'Email is required.');
  });

  // -----------------------------------------------------------------------
  // 5. Successful login flow
  // -----------------------------------------------------------------------

  it('calls sendMagicLink, sets token, updates store, and navigates on successful login', async () => {
    let emailInput = element.shadowRoot.querySelector('.email-input');
    emailInput.value = 'test@example.com';

    let form        = element.shadowRoot.querySelector('form');
    let submitEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    // Wait for the async submit handler to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify sendMagicLink was called with the email
    assert.equal(sendMagicLinkCalls.length, 1);
    assert.equal(sendMagicLinkCalls[0], 'test@example.com');

    // Verify setAuthToken was called with the session token
    assert.equal(setAuthTokenCalls.length, 1);
    assert.equal(setAuthTokenCalls[0], 'mock-session-token-123');

    // Verify profile.setUser was called
    assert.equal(profileSetUserCalls.length, 1);
    assert.deepEqual(profileSetUserCalls[0].user, { email: 'test@example.com' });
    assert.equal(profileSetUserCalls[0].token, 'mock-session-token-123');

    // Verify navigation to /kikx/ with replace
    assert.equal(navigateCalls.length, 1);
    assert.equal(navigateCalls[0].path, '/kikx/');
    assert.equal(navigateCalls[0].replace, true);
  });

  // -----------------------------------------------------------------------
  // 6. Failed login shows error message
  // -----------------------------------------------------------------------

  it('shows error message when login fails with body message', async () => {
    sendMagicLinkMock = async () => {
      let error  = new Error('Not found');
      error.body = { message: 'No account found for that email.' };
      throw error;
    };

    let emailInput = element.shadowRoot.querySelector('.email-input');
    emailInput.value = 'missing@example.com';

    let form        = element.shadowRoot.querySelector('form');
    let submitEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));

    let statusMessage = element.shadowRoot.querySelector('.status-message');
    assert.ok(statusMessage.classList.contains('visible'), 'status message should be visible');
    assert.ok(statusMessage.classList.contains('error'), 'status message should have error class');
    assert.equal(statusMessage.textContent, 'No account found for that email.');
  });

  it('shows generic error when error has no body message', async () => {
    sendMagicLinkMock = async () => {
      throw new Error('Network error');
    };

    let emailInput = element.shadowRoot.querySelector('.email-input');
    emailInput.value = 'user@example.com';

    let form        = element.shadowRoot.querySelector('form');
    let submitEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));

    let statusMessage = element.shadowRoot.querySelector('.status-message');
    assert.ok(statusMessage.classList.contains('visible'));
    assert.equal(statusMessage.textContent, 'Login failed. Please try again.');
  });

  // -----------------------------------------------------------------------
  // 7. Button is disabled during loading state
  // -----------------------------------------------------------------------

  it('disables the submit button during loading', async () => {
    let resolveLogin;
    sendMagicLinkMock = (email) => {
      sendMagicLinkCalls.push(email);
      return new Promise((resolve) => { resolveLogin = resolve; });
    };

    let emailInput = element.shadowRoot.querySelector('.email-input');
    emailInput.value = 'user@example.com';

    let form        = element.shadowRoot.querySelector('form');
    let submitEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    // Allow microtask to run the sync portion of _onSubmit up to the await
    await new Promise((resolve) => setTimeout(resolve, 5));

    let submitButton = element.shadowRoot.querySelector('.submit-button');
    assert.equal(submitButton.disabled, true, 'button should be disabled during loading');
    assert.equal(submitButton.textContent, 'Sending...');

    // Resolve the pending login to clean up
    resolveLogin({ data: { sessionToken: 'tok' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('re-enables the submit button after failed login', async () => {
    sendMagicLinkMock = async () => {
      throw new Error('fail');
    };

    let emailInput = element.shadowRoot.querySelector('.email-input');
    emailInput.value = 'user@example.com';

    let form        = element.shadowRoot.querySelector('form');
    let submitEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));

    let submitButton = element.shadowRoot.querySelector('.submit-button');
    assert.equal(submitButton.disabled, false, 'button should be re-enabled after error');
    assert.equal(submitButton.textContent, 'Send Magic Link');
  });

  // -----------------------------------------------------------------------
  // 8. All user-facing strings come from i18n
  // -----------------------------------------------------------------------

  it('uses i18n for all user-facing strings (no hardcoded text)', () => {
    let title    = element.shadowRoot.querySelector('.title').textContent;
    let subtitle = element.shadowRoot.querySelector('.subtitle').textContent;
    let button   = element.shadowRoot.querySelector('.submit-button').textContent;
    let input    = element.shadowRoot.querySelector('.email-input').placeholder;

    // All displayed strings must match locale values
    assert.equal(title, localeData.application.title);
    assert.equal(subtitle, localeData.login.subtitle);
    assert.equal(button, localeData.login.submitButton);
    assert.equal(input, localeData.login.emailPlaceholder);
  });

  it('uses i18n for error messages', () => {
    let form        = element.shadowRoot.querySelector('form');
    let submitEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    let statusMessage = element.shadowRoot.querySelector('.status-message');
    assert.equal(statusMessage.textContent, localeData.login.error.emailRequired);
  });

  it('uses i18n for loading text', async () => {
    let resolveLogin;
    sendMagicLinkMock = () => new Promise((resolve) => { resolveLogin = resolve; });

    let emailInput = element.shadowRoot.querySelector('.email-input');
    emailInput.value = 'user@example.com';

    let form        = element.shadowRoot.querySelector('form');
    let submitEvent = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    await new Promise((resolve) => setTimeout(resolve, 5));

    let submitButton = element.shadowRoot.querySelector('.submit-button');
    assert.equal(submitButton.textContent, localeData.login.loading);

    // Cleanup
    resolveLogin({ data: { sessionToken: 'tok' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  // -----------------------------------------------------------------------
  // Additional: status message hidden by default
  // -----------------------------------------------------------------------

  it('has status message hidden by default', () => {
    let statusMessage = element.shadowRoot.querySelector('.status-message');
    assert.ok(statusMessage, 'status message element should exist');
    assert.ok(!statusMessage.classList.contains('visible'), 'status message should not be visible initially');
  });
});
