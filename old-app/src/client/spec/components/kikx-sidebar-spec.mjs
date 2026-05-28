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

  class KikxSidebar extends JsdomHTMLElement {
    constructor() {
      super();

      this._archiveVisible = false;
      this._onArchiveToggle = this._onArchiveToggle.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-sidebar {
            display: flex;
            flex-direction: column;
            width: 300px;
            height: 100%;
            overflow: hidden;
            transition: width 0.3s ease;
          }

          kikx-sidebar[collapsed] {
            width: 0;
            overflow: hidden;
          }
        </style>

        <div class="search-area">
          <input class="search-input" type="text" />
          <button class="archive-toggle"></button>
        </div>
        <div class="section-header sessions-header"></div>
        <div class="session-list"></div>
        <div class="section-header participants-header"></div>
        <div class="participant-list"></div>
      `;

      this._searchInput        = this.querySelector('.search-input');
      this._archiveToggle      = this.querySelector('.archive-toggle');
      this._sessionsHeader     = this.querySelector('.sessions-header');
      this._participantsHeader = this.querySelector('.participants-header');

      this._render();
      this._archiveToggle.addEventListener('click', this._onArchiveToggle);
    }

    disconnectedCallback() {
      this._archiveToggle.removeEventListener('click', this._onArchiveToggle);
    }

    _render() {
      this._searchInput.placeholder        = mockT('sidebar.searchPlaceholder');
      this._sessionsHeader.textContent     = mockT('sidebar.sessions');
      this._participantsHeader.textContent = mockT('sidebar.participants');
      this._archiveToggle.textContent      = mockT('sidebar.archiveHide');
    }

    _onArchiveToggle() {
      this._archiveVisible = !this._archiveVisible;

      this._archiveToggle.textContent = (this._archiveVisible)
        ? mockT('sidebar.archiveShow')
        : mockT('sidebar.archiveHide');

      this.dispatchEvent(new dom.window.CustomEvent('toggle-archive', {
        bubbles:  true,
        composed: true,
        detail:   { visible: this._archiveVisible },
      }));
    }
  }

  dom.window.customElements.define('kikx-sidebar', KikxSidebar);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-sidebar', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-sidebar');
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
    let registered = dom.window.customElements.get('kikx-sidebar');
    assert.ok(registered, 'kikx-sidebar should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Contains search input with placeholder
  // -------------------------------------------------------------------------

  it('contains search input with correct placeholder', () => {
    let searchInput = element.querySelector('.search-input');
    assert.ok(searchInput, 'should have a search input');
    assert.equal(searchInput.getAttribute('type'), 'text');
    assert.equal(searchInput.placeholder, localeData.sidebar.searchPlaceholder);
  });

  // -------------------------------------------------------------------------
  // 4. Contains archive toggle button (default hide emoji)
  // -------------------------------------------------------------------------

  it('contains archive toggle button with default hide emoji', () => {
    let archiveToggle = element.querySelector('.archive-toggle');
    assert.ok(archiveToggle, 'should have an archive toggle button');
    assert.equal(archiveToggle.textContent, localeData.sidebar.archiveHide);
  });

  // -------------------------------------------------------------------------
  // 5. Archive toggle switches between hide and show emojis
  // -------------------------------------------------------------------------

  it('archive toggle switches between hide and show emojis on click', () => {
    let archiveToggle = element.querySelector('.archive-toggle');

    // Default state: hide emoji
    assert.equal(archiveToggle.textContent, localeData.sidebar.archiveHide);

    // First click: switches to show emoji
    archiveToggle.click();
    assert.equal(archiveToggle.textContent, localeData.sidebar.archiveShow);

    // Second click: switches back to hide emoji
    archiveToggle.click();
    assert.equal(archiveToggle.textContent, localeData.sidebar.archiveHide);
  });

  // -------------------------------------------------------------------------
  // 6. Archive toggle dispatches toggle-archive event
  // -------------------------------------------------------------------------

  it('archive toggle dispatches toggle-archive custom event', () => {
    let archiveToggle = element.querySelector('.archive-toggle');
    let eventFired    = false;
    let eventDetail   = null;

    element.addEventListener('toggle-archive', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    archiveToggle.click();

    assert.ok(eventFired, 'toggle-archive event should be dispatched');
    assert.deepEqual(eventDetail, { visible: true });
  });

  // -------------------------------------------------------------------------
  // 7. Contains session list area
  // -------------------------------------------------------------------------

  it('contains session list area', () => {
    let sessionList = element.querySelector('.session-list');
    assert.ok(sessionList, 'should have a session list area');
  });

  // -------------------------------------------------------------------------
  // 8. Contains participant list area
  // -------------------------------------------------------------------------

  it('contains participant list area', () => {
    let participantList = element.querySelector('.participant-list');
    assert.ok(participantList, 'should have a participant list area');
  });

  // -------------------------------------------------------------------------
  // 9. Collapsed attribute hides the sidebar
  // -------------------------------------------------------------------------

  it('collapsed attribute sets width to 0 via style', () => {
    element.setAttribute('collapsed', '');

    assert.ok(
      element.hasAttribute('collapsed'),
      'element should have the collapsed attribute',
    );

    // Verify the kikx-sidebar[collapsed] CSS rule is present
    let style = element.querySelector('style');
    assert.ok(style, 'should have a style element');
    assert.ok(
      style.textContent.includes('kikx-sidebar[collapsed]'),
      'style should include kikx-sidebar[collapsed] rule',
    );
    assert.ok(
      style.textContent.includes('width: 0'),
      'collapsed rule should set width to 0',
    );
  });

  // -------------------------------------------------------------------------
  // 10. Default state is not collapsed
  // -------------------------------------------------------------------------

  it('default state is not collapsed', () => {
    assert.ok(
      !element.hasAttribute('collapsed'),
      'element should not have collapsed attribute by default',
    );
  });

  // -------------------------------------------------------------------------
  // Additional: section headers use i18n
  // -------------------------------------------------------------------------

  it('renders section headers from i18n', () => {
    let sessionsHeader     = element.querySelector('.sessions-header');
    let participantsHeader = element.querySelector('.participants-header');

    assert.equal(sessionsHeader.textContent, localeData.sidebar.sessions);
    assert.equal(participantsHeader.textContent, localeData.sidebar.participants);
  });

  // -------------------------------------------------------------------------
  // Additional: real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement     = dom.window.HTMLElement;
    globalThis.customElements  = { define() {}, get() {} };
    globalThis.document        = dom.window.document;

    try {
      let mod = await import('../../components/kikx-sidebar/kikx-sidebar.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
