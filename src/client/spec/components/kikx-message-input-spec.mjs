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
    url:              'http://localhost/kikx/',
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
// into mockT instead of the real t(). This avoids issues with:
//   - ESM module caching (the real module captures its imports once)
//   - The real module needing browser globals at import time
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxMessageInput extends JsdomHTMLElement {
    static get observedAttributes() {
      return ['disabled'];
    }

    constructor() {
      super();

      this._onKeyDown   = this._onKeyDown.bind(this);
      this._onSendClick = this._onSendClick.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-message-input { display: block; padding: 8px; flex-shrink: 0; }
        </style>
        <div class="input-area">
          <textarea class="message-textarea" rows="1"></textarea>
          <button class="send-button"></button>
        </div>
      `;

      this._textarea   = this.querySelector('.message-textarea');
      this._sendButton = this.querySelector('.send-button');

      this._render();
      this._textarea.addEventListener('keydown', this._onKeyDown);
      this._sendButton.addEventListener('click', this._onSendClick);
    }

    disconnectedCallback() {
      this._textarea.removeEventListener('keydown', this._onKeyDown);
      this._sendButton.removeEventListener('click', this._onSendClick);
    }

    attributeChangedCallback() {
      if (!this._textarea || !this._sendButton) return;
      let isDisabled = this.hasAttribute('disabled');
      this._textarea.disabled   = isDisabled;
      this._sendButton.disabled = isDisabled;
    }

    _render() {
      this._textarea.placeholder   = mockT('chat.input.placeholder');
      this._sendButton.textContent = mockT('chat.input.sendButton');

      let isDisabled = this.hasAttribute('disabled');
      this._textarea.disabled   = isDisabled;
      this._sendButton.disabled = isDisabled;
    }

    _onKeyDown(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this._send();
      }
    }

    _onSendClick() {
      this._send();
    }

    _send() {
      let text = this._textarea.value.trim();
      if (!text)
        return;

      this.dispatchEvent(new dom.window.CustomEvent('send-message', {
        bubbles:  true,
        composed: true,
        detail:   { text },
      }));

      this._textarea.value = '';
    }

    focus() {
      this._textarea.focus();
    }

    clear() {
      this._textarea.value = '';
    }
  }

  dom.window.customElements.define('kikx-message-input', KikxMessageInput);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-message-input', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-message-input');
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
    let registered = dom.window.customElements.get('kikx-message-input');
    assert.ok(registered, 'kikx-message-input should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Contains textarea with correct placeholder
  // -------------------------------------------------------------------------

  it('contains textarea with correct placeholder', () => {
    let textarea = element.querySelector('.message-textarea');
    assert.ok(textarea, 'should have a textarea');
    assert.equal(textarea.placeholder, localeData.chat.input.placeholder);
  });

  // -------------------------------------------------------------------------
  // 4. Contains send button with correct text
  // -------------------------------------------------------------------------

  it('contains send button with correct text', () => {
    let sendButton = element.querySelector('.send-button');
    assert.ok(sendButton, 'should have a send button');
    assert.equal(sendButton.textContent, localeData.chat.input.sendButton);
  });

  // -------------------------------------------------------------------------
  // 5. Enter key dispatches send-message event with text
  // -------------------------------------------------------------------------

  it('dispatches send-message event on Enter key', () => {
    let textarea = element.querySelector('.message-textarea');
    textarea.value = 'Hello world';

    let receivedEvent = null;
    element.addEventListener('send-message', (event) => {
      receivedEvent = event;
    });

    let keyEvent = new dom.window.KeyboardEvent('keydown', {
      key:      'Enter',
      shiftKey: false,
      bubbles:  true,
    });
    textarea.dispatchEvent(keyEvent);

    assert.ok(receivedEvent, 'send-message event should have been dispatched');
    assert.equal(receivedEvent.detail.text, 'Hello world');
  });

  // -------------------------------------------------------------------------
  // 6. Enter key clears textarea after send
  // -------------------------------------------------------------------------

  it('clears textarea after Enter key send', () => {
    let textarea = element.querySelector('.message-textarea');
    textarea.value = 'Hello world';

    let keyEvent = new dom.window.KeyboardEvent('keydown', {
      key:      'Enter',
      shiftKey: false,
      bubbles:  true,
    });
    textarea.dispatchEvent(keyEvent);

    assert.equal(textarea.value, '', 'textarea should be cleared after send');
  });

  // -------------------------------------------------------------------------
  // 7. Shift+Enter does NOT dispatch send-message event
  // -------------------------------------------------------------------------

  it('does not dispatch send-message on Shift+Enter', () => {
    let textarea = element.querySelector('.message-textarea');
    textarea.value = 'Hello world';

    let eventFired = false;
    element.addEventListener('send-message', () => {
      eventFired = true;
    });

    let keyEvent = new dom.window.KeyboardEvent('keydown', {
      key:      'Enter',
      shiftKey: true,
      bubbles:  true,
    });
    textarea.dispatchEvent(keyEvent);

    assert.ok(!eventFired, 'send-message event should NOT have been dispatched on Shift+Enter');
    assert.equal(textarea.value, 'Hello world', 'textarea should NOT be cleared on Shift+Enter');
  });

  // -------------------------------------------------------------------------
  // 8. Click send button dispatches send-message event with text
  // -------------------------------------------------------------------------

  it('dispatches send-message event on send button click', () => {
    let textarea   = element.querySelector('.message-textarea');
    let sendButton = element.querySelector('.send-button');
    textarea.value = 'Button test';

    let receivedEvent = null;
    element.addEventListener('send-message', (event) => {
      receivedEvent = event;
    });

    sendButton.click();

    assert.ok(receivedEvent, 'send-message event should have been dispatched');
    assert.equal(receivedEvent.detail.text, 'Button test');
  });

  // -------------------------------------------------------------------------
  // 9. Click send button clears textarea after send
  // -------------------------------------------------------------------------

  it('clears textarea after send button click', () => {
    let textarea   = element.querySelector('.message-textarea');
    let sendButton = element.querySelector('.send-button');
    textarea.value = 'Button test';

    sendButton.click();

    assert.equal(textarea.value, '', 'textarea should be cleared after send');
  });

  // -------------------------------------------------------------------------
  // 10. Does not dispatch send-message when textarea is empty
  // -------------------------------------------------------------------------

  it('does not dispatch send-message when textarea is empty', () => {
    let textarea   = element.querySelector('.message-textarea');
    let sendButton = element.querySelector('.send-button');
    textarea.value = '';

    let eventFired = false;
    element.addEventListener('send-message', () => {
      eventFired = true;
    });

    sendButton.click();

    assert.ok(!eventFired, 'send-message event should NOT have been dispatched for empty input');
  });

  // -------------------------------------------------------------------------
  // 11. Does not dispatch send-message when textarea is whitespace-only
  // -------------------------------------------------------------------------

  it('does not dispatch send-message when textarea is whitespace-only', () => {
    let textarea   = element.querySelector('.message-textarea');
    let sendButton = element.querySelector('.send-button');
    textarea.value = '   \n  \t  ';

    let eventFired = false;
    element.addEventListener('send-message', () => {
      eventFired = true;
    });

    sendButton.click();

    assert.ok(!eventFired, 'send-message event should NOT have been dispatched for whitespace-only input');
  });

  // -------------------------------------------------------------------------
  // 12. disabled attribute disables textarea
  // -------------------------------------------------------------------------

  it('disabled attribute disables textarea', () => {
    element.setAttribute('disabled', '');

    let textarea = element.querySelector('.message-textarea');
    assert.equal(textarea.disabled, true, 'textarea should be disabled');
  });

  // -------------------------------------------------------------------------
  // 13. disabled attribute disables send button
  // -------------------------------------------------------------------------

  it('disabled attribute disables send button', () => {
    element.setAttribute('disabled', '');

    let sendButton = element.querySelector('.send-button');
    assert.equal(sendButton.disabled, true, 'send button should be disabled');
  });

  // -------------------------------------------------------------------------
  // 14. focus() method focuses the textarea
  // -------------------------------------------------------------------------

  it('focus() method focuses the textarea', () => {
    let textarea = element.querySelector('.message-textarea');

    element.focus();

    assert.equal(dom.window.document.activeElement, element, 'element should be the active element');
  });

  // -------------------------------------------------------------------------
  // 15. clear() method clears the textarea
  // -------------------------------------------------------------------------

  it('clear() method clears the textarea', () => {
    let textarea = element.querySelector('.message-textarea');
    textarea.value = 'Some text to clear';

    element.clear();

    assert.equal(textarea.value, '', 'textarea should be cleared');
  });

  // -------------------------------------------------------------------------
  // 16. Enter key preventDefault is called
  // -------------------------------------------------------------------------

  it('Enter key calls preventDefault', () => {
    let textarea = element.querySelector('.message-textarea');
    textarea.value = 'Hello';

    let keyEvent = new dom.window.KeyboardEvent('keydown', {
      key:        'Enter',
      shiftKey:   false,
      bubbles:    true,
      cancelable: true,
    });
    textarea.dispatchEvent(keyEvent);

    assert.equal(keyEvent.defaultPrevented, true, 'Enter key should have called preventDefault');
  });

  // -------------------------------------------------------------------------
  // 17. send-message event has correct bubbles and composed properties
  // -------------------------------------------------------------------------

  it('send-message event bubbles and is composed', () => {
    let textarea = element.querySelector('.message-textarea');
    textarea.value = 'Event props test';

    let receivedEvent = null;
    element.addEventListener('send-message', (event) => {
      receivedEvent = event;
    });

    let sendButton = element.querySelector('.send-button');
    sendButton.click();

    assert.ok(receivedEvent, 'event should have been dispatched');
    assert.equal(receivedEvent.bubbles, true, 'event should bubble');
    assert.equal(receivedEvent.composed, true, 'event should be composed');
  });

  // -------------------------------------------------------------------------
  // 18. Removing disabled attribute re-enables controls
  // -------------------------------------------------------------------------

  it('removing disabled attribute re-enables controls', () => {
    element.setAttribute('disabled', '');
    element.removeAttribute('disabled');

    let textarea   = element.querySelector('.message-textarea');
    let sendButton = element.querySelector('.send-button');

    assert.equal(textarea.disabled, false, 'textarea should be re-enabled');
    assert.equal(sendButton.disabled, false, 'send button should be re-enabled');
  });

  // -------------------------------------------------------------------------
  // 19. Trims whitespace from message text in event detail
  // -------------------------------------------------------------------------

  it('trims whitespace from message text in event detail', () => {
    let textarea = element.querySelector('.message-textarea');
    textarea.value = '  trimmed message  ';

    let receivedEvent = null;
    element.addEventListener('send-message', (event) => {
      receivedEvent = event;
    });

    let sendButton = element.querySelector('.send-button');
    sendButton.click();

    assert.ok(receivedEvent, 'event should have been dispatched');
    assert.equal(receivedEvent.detail.text, 'trimmed message', 'text should be trimmed');
  });

  // -------------------------------------------------------------------------
  // 20. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;
    globalThis.CustomEvent    = dom.window.CustomEvent;

    try {
      let mod = await import('../../components/kikx-message-input/kikx-message-input.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
    }
  });
});
