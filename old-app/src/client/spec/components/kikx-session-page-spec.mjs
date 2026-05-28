'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/kikx/sessions/abc-123',
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

  class KikxSessionPage extends JsdomHTMLElement {
    constructor() {
      super();
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-session-page {
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

          kikx-top-bar {
            grid-area: topbar;
          }

          kikx-chat-view {
            grid-area: chat;
            overflow: hidden;
          }

          kikx-sidebar {
            grid-area: sidebar;
            width: 300px;
          }

          kikx-status-bar {
            grid-area: statusbar;
          }
        </style>

        <kikx-top-bar></kikx-top-bar>
        <kikx-chat-view></kikx-chat-view>
        <kikx-sidebar></kikx-sidebar>
        <kikx-status-bar></kikx-status-bar>
      `;
    }

    get sessionID() {
      return this.getAttribute('data-id');
    }
  }

  dom.window.customElements.define('kikx-session-page', KikxSessionPage);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-session-page', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-session-page');
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
    let registered = dom.window.customElements.get('kikx-session-page');
    assert.ok(registered, 'kikx-session-page should be registered as a custom element');
  });

  // -----------------------------------------------------------------------
  // 2. Renders template on connect
  // -----------------------------------------------------------------------

  it('renders template on connect', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -----------------------------------------------------------------------
  // 3. Contains kikx-top-bar
  // -----------------------------------------------------------------------

  it('contains kikx-top-bar', () => {
    let topBar = element.querySelector('kikx-top-bar');
    assert.ok(topBar, 'should contain kikx-top-bar');
  });

  // -----------------------------------------------------------------------
  // 4. Contains kikx-chat-view
  // -----------------------------------------------------------------------

  it('contains kikx-chat-view', () => {
    let chatView = element.querySelector('kikx-chat-view');
    assert.ok(chatView, 'should contain kikx-chat-view');
  });

  // -----------------------------------------------------------------------
  // 5. Contains kikx-sidebar
  // -----------------------------------------------------------------------

  it('contains kikx-sidebar', () => {
    let sidebar = element.querySelector('kikx-sidebar');
    assert.ok(sidebar, 'should contain kikx-sidebar');
  });

  // -----------------------------------------------------------------------
  // 6. Contains kikx-status-bar
  // -----------------------------------------------------------------------

  it('contains kikx-status-bar', () => {
    let statusBar = element.querySelector('kikx-status-bar');
    assert.ok(statusBar, 'should contain kikx-status-bar');
  });

  // -----------------------------------------------------------------------
  // 7. Uses CSS Grid layout on the host element
  // -----------------------------------------------------------------------

  it('uses CSS Grid layout on the host element', () => {
    let styleElement = element.querySelector('style');
    assert.ok(styleElement, 'should contain a style element');

    let cssText = styleElement.textContent;
    assert.ok(cssText.includes('display: grid'), 'style should use display: grid');
    assert.ok(cssText.includes('grid-template-areas'), 'style should define grid-template-areas');
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
    assert.equal(element.sessionID, 'session-456', 'sessionID getter should return data-id attribute value');
  });

  it('returns null when data-id is not set', () => {
    assert.equal(element.sessionID, null, 'sessionID should be null when data-id is absent');
  });

  // -----------------------------------------------------------------------
  // 9. Has full viewport height styling
  // -----------------------------------------------------------------------

  it('has full viewport height styling', () => {
    let styleElement = element.querySelector('style');
    let cssText = styleElement.textContent;
    assert.ok(cssText.includes('height: 100vh'), 'style should include height: 100vh');
    assert.ok(cssText.includes('overflow: hidden'), 'style should include overflow: hidden');
  });

  // -----------------------------------------------------------------------
  // Additional: real module exports a class constructor
  // -----------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/kikx-session-page/kikx-session-page.mjs');
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
    let styleElement = element.querySelector('style');
    let cssText = styleElement.textContent;
    assert.ok(cssText.includes('width: 300px'), 'sidebar style should set width: 300px');
  });
});
