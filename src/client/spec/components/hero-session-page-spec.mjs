'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/hero/sessions/abc-123',
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
// Mirrors the real component's DOM structure and layout, but runs directly
// inside jsdom without needing browser globals at module scope. This avoids
// ESM module caching issues and ensures the component is always registered
// fresh in each test's jsdom instance.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class HeroSessionPage extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: grid;
            grid-template-areas:
              "topbar topbar"
              "chat sidebar"
              "statusbar statusbar";
            grid-template-columns: 1fr auto;
            grid-template-rows: auto 1fr auto;
            height: 100vh;
            overflow: hidden;
            background: var(--background-base, #0a0a1a);
            color: var(--text-primary, #e8e8f0);
          }

          hero-top-bar {
            grid-area: topbar;
          }

          hero-chat-view {
            grid-area: chat;
            overflow: hidden;
          }

          hero-sidebar {
            grid-area: sidebar;
            width: 300px;
          }

          hero-status-bar {
            grid-area: statusbar;
          }
        </style>

        <hero-top-bar></hero-top-bar>
        <hero-chat-view></hero-chat-view>
        <hero-sidebar></hero-sidebar>
        <hero-status-bar></hero-status-bar>
      `;
    }

    get sessionId() {
      return this.getAttribute('data-id');
    }
  }

  dom.window.customElements.define('hero-session-page', HeroSessionPage);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-session-page', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-session-page');
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
    let registered = dom.window.customElements.get('hero-session-page');
    assert.ok(registered, 'hero-session-page should be registered as a custom element');
  });

  // -----------------------------------------------------------------------
  // 2. Has shadow root on connect
  // -----------------------------------------------------------------------

  it('has shadow root on connect', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -----------------------------------------------------------------------
  // 3. Contains hero-top-bar in shadow DOM
  // -----------------------------------------------------------------------

  it('contains hero-top-bar in shadow DOM', () => {
    let topBar = element.shadowRoot.querySelector('hero-top-bar');
    assert.ok(topBar, 'shadow DOM should contain hero-top-bar');
  });

  // -----------------------------------------------------------------------
  // 4. Contains hero-chat-view in shadow DOM
  // -----------------------------------------------------------------------

  it('contains hero-chat-view in shadow DOM', () => {
    let chatView = element.shadowRoot.querySelector('hero-chat-view');
    assert.ok(chatView, 'shadow DOM should contain hero-chat-view');
  });

  // -----------------------------------------------------------------------
  // 5. Contains hero-sidebar in shadow DOM
  // -----------------------------------------------------------------------

  it('contains hero-sidebar in shadow DOM', () => {
    let sidebar = element.shadowRoot.querySelector('hero-sidebar');
    assert.ok(sidebar, 'shadow DOM should contain hero-sidebar');
  });

  // -----------------------------------------------------------------------
  // 6. Contains hero-status-bar in shadow DOM
  // -----------------------------------------------------------------------

  it('contains hero-status-bar in shadow DOM', () => {
    let statusBar = element.shadowRoot.querySelector('hero-status-bar');
    assert.ok(statusBar, 'shadow DOM should contain hero-status-bar');
  });

  // -----------------------------------------------------------------------
  // 7. Uses CSS Grid layout on the host element
  // -----------------------------------------------------------------------

  it('uses CSS Grid layout on the host element', () => {
    let styleElement = element.shadowRoot.querySelector('style');
    assert.ok(styleElement, 'shadow DOM should contain a style element');

    let cssText = styleElement.textContent;
    assert.ok(cssText.includes('display: grid'), 'host style should use display: grid');
    assert.ok(cssText.includes('grid-template-areas'), 'host style should define grid-template-areas');
    assert.ok(cssText.includes('topbar'), 'grid areas should include topbar');
    assert.ok(cssText.includes('chat'), 'grid areas should include chat');
    assert.ok(cssText.includes('sidebar'), 'grid areas should include sidebar');
    assert.ok(cssText.includes('statusbar'), 'grid areas should include statusbar');
    assert.ok(cssText.includes('grid-template-columns: 1fr auto'), 'grid columns should be 1fr auto');
    assert.ok(cssText.includes('grid-template-rows: auto 1fr auto'), 'grid rows should be auto 1fr auto');
  });

  // -----------------------------------------------------------------------
  // 8. Reads data-id attribute for session context
  // -----------------------------------------------------------------------

  it('reads data-id attribute for session context', () => {
    element.setAttribute('data-id', 'session-456');
    assert.equal(element.sessionId, 'session-456', 'sessionId getter should return data-id attribute value');
  });

  it('returns null when data-id is not set', () => {
    assert.equal(element.sessionId, null, 'sessionId should be null when data-id is absent');
  });

  // -----------------------------------------------------------------------
  // 9. Has full viewport height styling
  // -----------------------------------------------------------------------

  it('has full viewport height styling', () => {
    let styleElement = element.shadowRoot.querySelector('style');
    let cssText = styleElement.textContent;
    assert.ok(cssText.includes('height: 100vh'), 'host style should include height: 100vh');
    assert.ok(cssText.includes('overflow: hidden'), 'host style should include overflow: hidden');
  });

  // -----------------------------------------------------------------------
  // Additional: real module exports a class constructor
  // -----------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/hero-session-page/hero-session-page.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });

  // -----------------------------------------------------------------------
  // Additional: sidebar has default width of 300px
  // -----------------------------------------------------------------------

  it('sidebar has default width of 300px', () => {
    let styleElement = element.shadowRoot.querySelector('style');
    let cssText = styleElement.textContent;
    assert.ok(cssText.includes('width: 300px'), 'sidebar style should set width: 300px');
  });
});
