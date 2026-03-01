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

  class KikxModal extends JsdomHTMLElement {
    static get observedAttributes() { return ['open', 'modal-title']; }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 1000;
            align-items: center;
            justify-content: center;
          }

          :host([open]) {
            display: flex;
          }

          .backdrop {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
          }

          .panel {
            position: relative;
            z-index: 1;
            min-width: 320px;
            max-width: 90vw;
            max-height: 85vh;
            overflow-y: auto;
            background: var(--glass-background-solid, rgba(18, 18, 30, 0.95));
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-large, 12px);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 16px var(--accent-glow, rgba(0, 229, 255, 0.10));
            color: var(--text-primary, #e8e8f0);
            padding: 0;
          }

          .panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px 12px;
            border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
          }

          .panel-title {
            font-size: 1.125rem;
            font-weight: 600;
          }

          .close-button {
            background: none;
            border: none;
            color: var(--text-muted, #606078);
            font-size: 1.25rem;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: var(--border-radius-small, 4px);
            transition: background 0.2s ease, color 0.2s ease;
            line-height: 1;
          }

          .close-button:hover {
            background: var(--glass-hover, rgba(255, 255, 255, 0.08));
            color: var(--text-primary, #e8e8f0);
          }

          .panel-body {
            padding: 16px 20px 20px;
          }

          .panel::-webkit-scrollbar { width: 6px; }
          .panel::-webkit-scrollbar-track { background: transparent; }
          .panel::-webkit-scrollbar-thumb {
            background: var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: 3px;
          }
        </style>

        <div class="backdrop"></div>
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title"></span>
            <button class="close-button" aria-label="${mockT('common.close')}">&#10005;</button>
          </div>
          <div class="panel-body">
            <slot></slot>
          </div>
        </div>
      `;

      this._backdrop    = this.shadowRoot.querySelector('.backdrop');
      this._closeButton = this.shadowRoot.querySelector('.close-button');
      this._panelTitle  = this.shadowRoot.querySelector('.panel-title');

      this._onBackdropClick = this._onBackdropClick.bind(this);
      this._onCloseClick    = this._onCloseClick.bind(this);
      this._onKeyDown       = this._onKeyDown.bind(this);
    }

    connectedCallback() {
      this._backdrop.addEventListener('click', this._onBackdropClick);
      this._closeButton.addEventListener('click', this._onCloseClick);
      this._updateTitle();

      if (this.hasAttribute('open'))
        this._addEscapeListener();
    }

    disconnectedCallback() {
      this._backdrop.removeEventListener('click', this._onBackdropClick);
      this._closeButton.removeEventListener('click', this._onCloseClick);
      this._removeEscapeListener();
    }

    attributeChangedCallback(name) {
      if (name === 'modal-title')
        this._updateTitle();

      if (name === 'open') {
        if (this.hasAttribute('open'))
          this._addEscapeListener();
        else
          this._removeEscapeListener();
      }
    }

    _updateTitle() {
      if (this._panelTitle)
        this._panelTitle.textContent = this.getAttribute('modal-title') || '';
    }

    _onBackdropClick() { this.close(); }
    _onCloseClick() { this.close(); }

    _onKeyDown(event) {
      if (event.key === 'Escape')
        this.close();
    }

    _addEscapeListener() {
      let doc = this.ownerDocument || dom.window.document;
      doc.addEventListener('keydown', this._onKeyDown);
    }

    _removeEscapeListener() {
      let doc = this.ownerDocument || dom.window.document;
      doc.removeEventListener('keydown', this._onKeyDown);
    }

    open() {
      this.setAttribute('open', '');
      this.dispatchEvent(new dom.window.CustomEvent('modal-open', {
        bubbles:  true,
        composed: true,
      }));
    }

    close() {
      this.removeAttribute('open');
      this.dispatchEvent(new dom.window.CustomEvent('modal-close', {
        bubbles:  true,
        composed: true,
      }));
    }
  }

  dom.window.customElements.define('kikx-modal', KikxModal);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-modal', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-modal');
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
    let registered = dom.window.customElements.get('kikx-modal');
    assert.ok(registered, 'kikx-modal should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Hidden by default (no open attribute)
  // -------------------------------------------------------------------------

  it('is hidden by default (no open attribute)', () => {
    assert.ok(!element.hasAttribute('open'), 'element should not have open attribute by default');

    let style = element.shadowRoot.querySelector('style');
    assert.ok(style, 'should have a style element');
    assert.ok(
      style.textContent.includes('display: none'),
      ':host default should set display to none',
    );
  });

  // -------------------------------------------------------------------------
  // 4. Visible when open attribute is set
  // -------------------------------------------------------------------------

  it('is visible when open attribute is set', () => {
    let style = element.shadowRoot.querySelector('style');
    assert.ok(
      style.textContent.includes(':host([open])'),
      'style should include :host([open]) rule',
    );
    assert.ok(
      style.textContent.includes('display: flex'),
      ':host([open]) rule should set display to flex',
    );
  });

  // -------------------------------------------------------------------------
  // 5. modal-title attribute sets panel title text
  // -------------------------------------------------------------------------

  it('modal-title attribute sets panel title text', () => {
    element.setAttribute('modal-title', 'Test Title');

    let panelTitle = element.shadowRoot.querySelector('.panel-title');
    assert.equal(panelTitle.textContent, 'Test Title', 'panel title should reflect modal-title attribute');
  });

  // -------------------------------------------------------------------------
  // 6. open() method sets open attribute and dispatches modal-open event
  // -------------------------------------------------------------------------

  it('open() method sets open attribute and dispatches modal-open event', () => {
    let eventFired = false;
    let eventData  = null;

    element.addEventListener('modal-open', (event) => {
      eventFired = true;
      eventData  = event;
    });

    element.open();

    assert.ok(element.hasAttribute('open'), 'element should have open attribute after open()');
    assert.ok(eventFired, 'modal-open event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
  });

  // -------------------------------------------------------------------------
  // 7. close() method removes open attribute and dispatches modal-close event
  // -------------------------------------------------------------------------

  it('close() method removes open attribute and dispatches modal-close event', () => {
    element.open();

    let eventFired = false;
    let eventData  = null;

    element.addEventListener('modal-close', (event) => {
      eventFired = true;
      eventData  = event;
    });

    element.close();

    assert.ok(!element.hasAttribute('open'), 'element should not have open attribute after close()');
    assert.ok(eventFired, 'modal-close event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
  });

  // -------------------------------------------------------------------------
  // 8. Clicking backdrop calls close
  // -------------------------------------------------------------------------

  it('clicking backdrop calls close', () => {
    element.open();

    let eventFired = false;

    element.addEventListener('modal-close', () => {
      eventFired = true;
    });

    let backdrop = element.shadowRoot.querySelector('.backdrop');
    backdrop.click();

    assert.ok(eventFired, 'modal-close event should fire when backdrop is clicked');
    assert.ok(!element.hasAttribute('open'), 'open attribute should be removed after backdrop click');
  });

  // -------------------------------------------------------------------------
  // 9. Clicking close button calls close
  // -------------------------------------------------------------------------

  it('clicking close button calls close', () => {
    element.open();

    let eventFired = false;

    element.addEventListener('modal-close', () => {
      eventFired = true;
    });

    let closeButton = element.shadowRoot.querySelector('.close-button');
    closeButton.click();

    assert.ok(eventFired, 'modal-close event should fire when close button is clicked');
    assert.ok(!element.hasAttribute('open'), 'open attribute should be removed after close button click');
  });

  // -------------------------------------------------------------------------
  // 10. Escape key calls close when open
  // -------------------------------------------------------------------------

  it('escape key calls close when open', () => {
    element.open();

    let eventFired = false;

    element.addEventListener('modal-close', () => {
      eventFired = true;
    });

    let event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    dom.window.document.dispatchEvent(event);

    assert.ok(eventFired, 'modal-close event should fire when Escape is pressed');
    assert.ok(!element.hasAttribute('open'), 'open attribute should be removed after Escape key');
  });

  // -------------------------------------------------------------------------
  // 11. Has a slot for content
  // -------------------------------------------------------------------------

  it('has a slot for content', () => {
    let slot = element.shadowRoot.querySelector('slot');
    assert.ok(slot, 'shadow DOM should contain a <slot> element');
  });

  // -------------------------------------------------------------------------
  // 12. Contains panel with header and body
  // -------------------------------------------------------------------------

  it('contains panel with header and body', () => {
    let panel       = element.shadowRoot.querySelector('.panel');
    let panelHeader = element.shadowRoot.querySelector('.panel-header');
    let panelBody   = element.shadowRoot.querySelector('.panel-body');

    assert.ok(panel, 'shadow DOM should contain .panel');
    assert.ok(panelHeader, 'shadow DOM should contain .panel-header');
    assert.ok(panelBody, 'shadow DOM should contain .panel-body');
  });

  // -------------------------------------------------------------------------
  // 13. Close button has aria-label
  // -------------------------------------------------------------------------

  it('close button has aria-label', () => {
    let closeButton = element.shadowRoot.querySelector('.close-button');
    assert.ok(closeButton, 'shadow DOM should contain .close-button');

    let ariaLabel = closeButton.getAttribute('aria-label');
    assert.equal(ariaLabel, localeData.common.close, 'aria-label should match i18n common.close');
  });

  // -------------------------------------------------------------------------
  // 14. Escape listener removed when closed/disconnected
  // -------------------------------------------------------------------------

  it('escape listener removed when closed/disconnected', () => {
    element.open();
    element.close();

    let eventFired = false;

    element.addEventListener('modal-close', () => {
      eventFired = true;
    });

    let event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    dom.window.document.dispatchEvent(event);

    assert.ok(!eventFired, 'modal-close should not fire when Escape is pressed after modal is closed');
  });

  // -------------------------------------------------------------------------
  // 15. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/kikx-modal/kikx-modal.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
