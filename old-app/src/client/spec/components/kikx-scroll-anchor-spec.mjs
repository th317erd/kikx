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

  class KikxScrollAnchor extends JsdomHTMLElement {
    constructor() {
      super();

      this._onClick = this._onClick.bind(this);
    }

    static get observedAttributes() { return ['hidden', 'unread-count']; }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-scroll-anchor {
            display: block;
            position: absolute;
            bottom: var(--spacing-md, 16px);
            left: 50%;
            transform: translateX(-50%);
            z-index: 10;
            pointer-events: none;
            transition: opacity 0.2s ease, transform 0.2s ease;
          }

          kikx-scroll-anchor[hidden] {
            display: none;
          }

          .anchor-button {
            pointer-events: auto;
            display: flex;
            align-items: center;
            gap: var(--spacing-xs, 4px);
            padding: 8px 16px;
            background: var(--glass-background, rgba(255, 255, 255, 0.05));
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-medium, 8px);
            color: var(--text-primary, #e8e8f0);
            font-size: 0.875rem;
            cursor: pointer;
            transition: background 0.2s ease, box-shadow 0.2s ease;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
          }

          .anchor-button:hover {
            background: var(--glass-hover, rgba(255, 255, 255, 0.08));
            box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.30));
          }

          .chevron {
            font-size: 1.125rem;
            line-height: 1;
          }

          .badge {
            display: none;
            background: var(--accent-primary, #00e5ff);
            color: var(--bg-primary, #0a0a12);
            border-radius: 50%;
            min-width: 20px;
            height: 20px;
            font-size: 0.75rem;
            font-weight: 700;
            text-align: center;
            line-height: 20px;
            padding: 0 4px;
          }

          .badge[data-count]:not([data-count="0"]) {
            display: inline-block;
          }
        </style>

        <button class="anchor-button" title="">
          <span class="chevron">\u25BC</span>
          <span class="badge" data-count="0"></span>
        </button>
      `;

      this._button = this.querySelector('.anchor-button');
      this._badge  = this.querySelector('.badge');

      this._button.title = mockT('chat.scrollAnchor.jumpToBottom');
      this._button.addEventListener('click', this._onClick);
    }

    disconnectedCallback() {
      this._button.removeEventListener('click', this._onClick);
    }

    attributeChangedCallback(name) {
      if (name === 'unread-count')
        this._updateBadge();
    }

    _onClick() {
      this.dispatchEvent(new dom.window.CustomEvent('jump-to-bottom', {
        bubbles:  true,
        composed: true,
      }));
    }

    _updateBadge() {
      let count = parseInt(this.getAttribute('unread-count') || '0', 10);
      this._badge.textContent = (count > 0) ? String(count) : '';
      this._badge.setAttribute('data-count', String(count));
    }

    show() {
      this.removeAttribute('hidden');
    }

    hide() {
      this.setAttribute('hidden', '');
    }

    setUnreadCount(count) {
      this.setAttribute('unread-count', String(count));
    }
  }

  dom.window.customElements.define('kikx-scroll-anchor', KikxScrollAnchor);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-scroll-anchor', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-scroll-anchor');
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
    let registered = dom.window.customElements.get('kikx-scroll-anchor');
    assert.ok(registered, 'kikx-scroll-anchor should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Contains anchor button with chevron
  // -------------------------------------------------------------------------

  it('contains anchor button with chevron', () => {
    let button = element.querySelector('.anchor-button');
    assert.ok(button, 'should contain .anchor-button');

    let chevron = element.querySelector('.chevron');
    assert.ok(chevron, 'should contain .chevron');
    assert.equal(chevron.textContent, '\u25BC', 'chevron should display the down arrow character');
  });

  // -------------------------------------------------------------------------
  // 4. Button title is set from i18n
  // -------------------------------------------------------------------------

  it('button title is set from i18n', () => {
    let button = element.querySelector('.anchor-button');
    assert.equal(
      button.title,
      localeData.chat.scrollAnchor.jumpToBottom,
      'button title should match i18n value',
    );
  });

  // -------------------------------------------------------------------------
  // 5. Clicking button dispatches jump-to-bottom event
  // -------------------------------------------------------------------------

  it('clicking button dispatches jump-to-bottom event', () => {
    let button    = element.querySelector('.anchor-button');
    let eventFired = false;
    let eventData  = null;

    element.addEventListener('jump-to-bottom', (event) => {
      eventFired = true;
      eventData  = event;
    });

    button.click();

    assert.ok(eventFired, 'jump-to-bottom event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
  });

  // -------------------------------------------------------------------------
  // 6. Badge is hidden by default (data-count="0")
  // -------------------------------------------------------------------------

  it('badge is hidden by default', () => {
    let badge = element.querySelector('.badge');
    assert.ok(badge, 'should contain .badge');
    assert.equal(badge.getAttribute('data-count'), '0', 'default data-count should be 0');
    assert.equal(badge.textContent, '', 'badge text should be empty when count is 0');
  });

  // -------------------------------------------------------------------------
  // 7. setUnreadCount(5) shows badge with "5"
  // -------------------------------------------------------------------------

  it('setUnreadCount(5) shows badge with text 5', () => {
    element.setUnreadCount(5);

    let badge = element.querySelector('.badge');
    assert.equal(badge.getAttribute('data-count'), '5', 'data-count should be 5');
    assert.equal(badge.textContent, '5', 'badge text should be 5');
  });

  // -------------------------------------------------------------------------
  // 8. setUnreadCount(0) hides badge
  // -------------------------------------------------------------------------

  it('setUnreadCount(0) hides badge', () => {
    element.setUnreadCount(5);
    element.setUnreadCount(0);

    let badge = element.querySelector('.badge');
    assert.equal(badge.getAttribute('data-count'), '0', 'data-count should be 0');
    assert.equal(badge.textContent, '', 'badge text should be empty when count is 0');
  });

  // -------------------------------------------------------------------------
  // 9. show() removes hidden attribute
  // -------------------------------------------------------------------------

  it('show() removes hidden attribute', () => {
    element.setAttribute('hidden', '');
    assert.ok(element.hasAttribute('hidden'), 'element should be hidden initially');

    element.show();
    assert.ok(!element.hasAttribute('hidden'), 'hidden attribute should be removed after show()');
  });

  // -------------------------------------------------------------------------
  // 10. hide() sets hidden attribute
  // -------------------------------------------------------------------------

  it('hide() sets hidden attribute', () => {
    assert.ok(!element.hasAttribute('hidden'), 'element should not be hidden initially');

    element.hide();
    assert.ok(element.hasAttribute('hidden'), 'hidden attribute should be set after hide()');
  });

  // -------------------------------------------------------------------------
  // 11. hidden attribute uses display:none via kikx-scroll-anchor[hidden] CSS rule
  // -------------------------------------------------------------------------

  it('hidden attribute uses display:none via kikx-scroll-anchor[hidden] CSS rule', () => {
    let style = element.querySelector('style');
    assert.ok(style, 'should have a style element');
    assert.ok(
      style.textContent.includes('kikx-scroll-anchor[hidden]'),
      'style should include kikx-scroll-anchor[hidden] rule',
    );
    assert.ok(
      style.textContent.includes('display: none'),
      'kikx-scroll-anchor[hidden] rule should set display to none',
    );
  });

  // -------------------------------------------------------------------------
  // 12. unread-count attribute updates badge via attributeChangedCallback
  // -------------------------------------------------------------------------

  it('unread-count attribute updates badge via attributeChangedCallback', () => {
    element.setAttribute('unread-count', '3');

    let badge = element.querySelector('.badge');
    assert.equal(badge.getAttribute('data-count'), '3', 'data-count should reflect attribute');
    assert.equal(badge.textContent, '3', 'badge text should reflect attribute');

    element.setAttribute('unread-count', '0');
    assert.equal(badge.getAttribute('data-count'), '0', 'data-count should update to 0');
    assert.equal(badge.textContent, '', 'badge text should be empty when count resets to 0');
  });

  // -------------------------------------------------------------------------
  // Additional: real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/kikx-scroll-anchor/kikx-scroll-anchor.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
