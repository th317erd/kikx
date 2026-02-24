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

function mockFormatTokenCount(count) {
  let num = parseInt(count, 10);

  if (isNaN(num) || num <= 0)
    return '';

  return (num === 1)
    ? mockT('chat.interaction.tokenCount.one').replace('{count}', '1')
    : mockT('chat.interaction.tokenCount.other').replace('{count}', String(num));
}

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/hero/session/abc',
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
// into mockT() instead of the real t(). This avoids ESM module caching
// issues with customElements.define().
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;
  let JsdomCustomEvent = dom.window.CustomEvent;
  let doc              = dom.window.document;

  class HeroInteraction extends JsdomHTMLElement {
    static get observedAttributes() {
      return [
        'participant-name',
        'participant-initials',
        'avatar-color',
        'alignment',
        'timestamp',
        'token-count',
        'show-actions',
        'interaction-id',
      ];
    }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: flex;
            gap: var(--spacing-sm, 8px);
            padding: var(--spacing-sm, 8px);
            max-width: 85%;
            align-self: flex-start;
          }

          :host([alignment="user"]) {
            align-self: flex-end;
            flex-direction: row-reverse;
          }

          :host([alignment="system"]) {
            align-self: center;
            max-width: 100%;
          }

          .avatar {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 0.8rem;
            flex-shrink: 0;
            color: #fff;
            background: var(--interaction-avatar-color, #e53935);
          }

          .body {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: var(--spacing-xs, 4px);
          }

          .header {
            font-size: 0.8125rem;
            font-weight: 600;
            color: var(--text-secondary, #a0a0b8);
          }

          .content {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-xs, 4px);
            background: var(--glass-background, rgba(255, 255, 255, 0.05));
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-medium, 8px);
            padding: var(--spacing-sm, 8px) 12px;
            color: var(--text-primary, #e8e8f0);
          }

          :host([alignment="user"]) .content {
            background: var(--user-bubble-background, rgba(229, 57, 53, 0.15));
            border-color: var(--user-bubble-border, rgba(229, 57, 53, 0.30));
          }

          .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 0.75rem;
            color: var(--text-muted, #606078);
            padding-top: 2px;
          }

          .footer-left {
            display: flex;
            gap: var(--spacing-sm, 8px);
            align-items: center;
          }

          .footer-right {
            display: flex;
            gap: var(--spacing-xs, 4px);
            align-items: center;
          }

          .action-button {
            background: none;
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-small, 4px);
            color: var(--text-secondary, #a0a0b8);
            padding: 4px 10px;
            font-size: 0.75rem;
            cursor: pointer;
            transition: background 0.2s ease;
          }

          .submit-button {
            background: var(--accent-primary, #00e5ff);
            color: var(--bg-primary, #0a0a12);
            border-color: transparent;
            font-weight: 600;
          }
        </style>

        <div class="avatar"></div>
        <div class="body">
          <div class="header"></div>
          <div class="content">
            <slot></slot>
          </div>
          <div class="footer">
            <div class="footer-left">
              <span class="timestamp"></span>
              <span class="token-count"></span>
            </div>
            <div class="footer-right"></div>
          </div>
        </div>
      `;

      this._avatar      = this.shadowRoot.querySelector('.avatar');
      this._header      = this.shadowRoot.querySelector('.header');
      this._timestamp   = this.shadowRoot.querySelector('.timestamp');
      this._tokenCount  = this.shadowRoot.querySelector('.token-count');
      this._footerRight = this.shadowRoot.querySelector('.footer-right');

      this._onIgnoreClick = this._onIgnoreClick.bind(this);
      this._onSubmitClick = this._onSubmitClick.bind(this);
    }

    connectedCallback() {
      this._render();
    }

    disconnectedCallback() {
      this._removeActionListeners();
    }

    attributeChangedCallback() {
      if (this.isConnected)
        this._render();
    }

    _render() {
      this._header.textContent    = this.getAttribute('participant-name') || '';
      this._avatar.textContent    = this.getAttribute('participant-initials') || '';
      this._timestamp.textContent = this.getAttribute('timestamp') || '';

      let avatarColor = this.getAttribute('avatar-color');
      if (avatarColor) {
        this._avatar.style.setProperty('--interaction-avatar-color', avatarColor);
      } else {
        this._avatar.style.removeProperty('--interaction-avatar-color');
      }

      let tokenCountAttr = this.getAttribute('token-count');
      this._tokenCount.textContent = tokenCountAttr ? mockFormatTokenCount(tokenCountAttr) : '';

      this._renderActions();
    }

    _renderActions() {
      this._removeActionListeners();
      this._footerRight.innerHTML = '';

      if (!this.hasAttribute('show-actions'))
        return;

      let ignoreButton = doc.createElement('button');
      ignoreButton.className   = 'action-button ignore-button';
      ignoreButton.textContent = mockT('chat.interaction.ignoreButton');
      ignoreButton.type        = 'button';

      let submitButton = doc.createElement('button');
      submitButton.className   = 'action-button submit-button';
      submitButton.textContent = mockT('chat.interaction.submitButton');
      submitButton.type        = 'button';

      ignoreButton.addEventListener('click', this._onIgnoreClick);
      submitButton.addEventListener('click', this._onSubmitClick);

      this._ignoreButton = ignoreButton;
      this._submitButton = submitButton;

      this._footerRight.appendChild(ignoreButton);
      this._footerRight.appendChild(submitButton);
    }

    _removeActionListeners() {
      if (this._ignoreButton) {
        this._ignoreButton.removeEventListener('click', this._onIgnoreClick);
        this._ignoreButton = null;
      }

      if (this._submitButton) {
        this._submitButton.removeEventListener('click', this._onSubmitClick);
        this._submitButton = null;
      }
    }

    _onIgnoreClick() {
      this.dispatchEvent(new JsdomCustomEvent('interaction-ignore', {
        bubbles:  true,
        composed: true,
        detail:   { interactionId: this.getAttribute('interaction-id') },
      }));
    }

    _onSubmitClick() {
      this.dispatchEvent(new JsdomCustomEvent('interaction-submit', {
        bubbles:  true,
        composed: true,
        detail:   { interactionId: this.getAttribute('interaction-id') },
      }));
    }
  }

  dom.window.customElements.define('hero-interaction', HeroInteraction);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-interaction', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-interaction');
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
    let registered = dom.window.customElements.get('hero-interaction');
    assert.ok(registered, 'hero-interaction should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Displays participant name in header
  // -------------------------------------------------------------------------

  it('displays participant name in header', () => {
    element.setAttribute('participant-name', 'Agent Smith');

    let header = element.shadowRoot.querySelector('.header');
    assert.equal(header.textContent, 'Agent Smith');
  });

  // -------------------------------------------------------------------------
  // 4. Displays initials in avatar
  // -------------------------------------------------------------------------

  it('displays initials in avatar', () => {
    element.setAttribute('participant-initials', 'AS');

    let avatar = element.shadowRoot.querySelector('.avatar');
    assert.equal(avatar.textContent, 'AS');
  });

  // -------------------------------------------------------------------------
  // 5. Avatar color applies from attribute
  // -------------------------------------------------------------------------

  it('applies avatar color from attribute', () => {
    element.setAttribute('avatar-color', '#4caf50');

    let avatar = element.shadowRoot.querySelector('.avatar');
    let inlineStyle = avatar.style.getPropertyValue('--interaction-avatar-color');
    assert.equal(inlineStyle, '#4caf50');
  });

  // -------------------------------------------------------------------------
  // 6. User alignment sets the alignment attribute on the host
  // -------------------------------------------------------------------------

  it('user alignment sets alignment attribute for right-align styling', () => {
    element.setAttribute('alignment', 'user');

    assert.equal(element.getAttribute('alignment'), 'user',
      'alignment attribute should be "user" for CSS :host([alignment="user"]) rules');

    // Verify the CSS rule exists in the shadow root style
    let style = element.shadowRoot.querySelector('style');
    assert.ok(style.textContent.includes(':host([alignment="user"])'),
      'shadow CSS should contain :host([alignment="user"]) rule');
  });

  // -------------------------------------------------------------------------
  // 7. Agent alignment (default) left-aligns
  // -------------------------------------------------------------------------

  it('default (agent) alignment uses flex-start via :host base styles', () => {
    // No alignment attribute set -- defaults to flex-start (left-aligned)
    assert.equal(element.getAttribute('alignment'), null,
      'alignment should not be set by default');

    let style = element.shadowRoot.querySelector('style');
    assert.ok(style.textContent.includes('align-self: flex-start'),
      'base :host style should include align-self: flex-start');
  });

  // -------------------------------------------------------------------------
  // 8. System alignment centers
  // -------------------------------------------------------------------------

  it('system alignment sets alignment attribute for center styling', () => {
    element.setAttribute('alignment', 'system');

    assert.equal(element.getAttribute('alignment'), 'system');

    let style = element.shadowRoot.querySelector('style');
    assert.ok(style.textContent.includes(':host([alignment="system"])'),
      'shadow CSS should contain :host([alignment="system"]) rule');
  });

  // -------------------------------------------------------------------------
  // 9. Timestamp displays in footer
  // -------------------------------------------------------------------------

  it('displays timestamp in footer', () => {
    element.setAttribute('timestamp', '2:35 PM');

    let timestamp = element.shadowRoot.querySelector('.timestamp');
    assert.equal(timestamp.textContent, '2:35 PM');
  });

  // -------------------------------------------------------------------------
  // 10. Token count formats with pluralization (1 token vs N tokens)
  // -------------------------------------------------------------------------

  it('formats token count with pluralization', () => {
    element.setAttribute('token-count', '1');
    let tokenCount = element.shadowRoot.querySelector('.token-count');
    assert.equal(tokenCount.textContent, '~1 token');

    element.setAttribute('token-count', '150');
    assert.equal(tokenCount.textContent, '~150 tokens');
  });

  // -------------------------------------------------------------------------
  // 11. Token count empty when attribute missing
  // -------------------------------------------------------------------------

  it('token count is empty when attribute is missing', () => {
    let tokenCount = element.shadowRoot.querySelector('.token-count');
    assert.equal(tokenCount.textContent, '');
  });

  // -------------------------------------------------------------------------
  // 12. show-actions renders Ignore and Submit buttons
  // -------------------------------------------------------------------------

  it('renders Ignore and Submit buttons when show-actions is present', () => {
    element.setAttribute('show-actions', '');

    let footerRight   = element.shadowRoot.querySelector('.footer-right');
    let ignoreButton  = footerRight.querySelector('.ignore-button');
    let submitButton  = footerRight.querySelector('.submit-button');

    assert.ok(ignoreButton, 'should have an Ignore button');
    assert.ok(submitButton, 'should have a Submit button');
    assert.equal(ignoreButton.textContent, localeData.chat.interaction.ignoreButton);
    assert.equal(submitButton.textContent, localeData.chat.interaction.submitButton);
  });

  // -------------------------------------------------------------------------
  // 13. No action buttons when show-actions not present
  // -------------------------------------------------------------------------

  it('does not render action buttons when show-actions is absent', () => {
    let footerRight = element.shadowRoot.querySelector('.footer-right');
    let buttons     = footerRight.querySelectorAll('button');
    assert.equal(buttons.length, 0, 'should have no action buttons');
  });

  // -------------------------------------------------------------------------
  // 14. Ignore button dispatches interaction-ignore event
  // -------------------------------------------------------------------------

  it('dispatches interaction-ignore event with interactionId when Ignore is clicked', () => {
    element.setAttribute('interaction-id', 'frame-42');
    element.setAttribute('show-actions', '');

    let receivedEvent = null;
    element.addEventListener('interaction-ignore', (event) => {
      receivedEvent = event;
    });

    let ignoreButton = element.shadowRoot.querySelector('.ignore-button');
    ignoreButton.click();

    assert.ok(receivedEvent, 'interaction-ignore event should have been dispatched');
    assert.equal(receivedEvent.detail.interactionId, 'frame-42');
  });

  // -------------------------------------------------------------------------
  // 15. Submit button dispatches interaction-submit event
  // -------------------------------------------------------------------------

  it('dispatches interaction-submit event with interactionId when Submit is clicked', () => {
    element.setAttribute('interaction-id', 'frame-99');
    element.setAttribute('show-actions', '');

    let receivedEvent = null;
    element.addEventListener('interaction-submit', (event) => {
      receivedEvent = event;
    });

    let submitButton = element.shadowRoot.querySelector('.submit-button');
    submitButton.click();

    assert.ok(receivedEvent, 'interaction-submit event should have been dispatched');
    assert.equal(receivedEvent.detail.interactionId, 'frame-99');
  });
});
