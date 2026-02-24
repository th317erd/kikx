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
// Constants (must match the real component)
// ---------------------------------------------------------------------------

const ANCHOR_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url:               'http://localhost/hero/',
    pretendToBeVisual: true,
  });

  // Mock ResizeObserver since jsdom doesn't have it
  dom.window.ResizeObserver = class MockResizeObserver {
    constructor(callback) { this._callback = callback; }
    observe()    {}
    unobserve()  {}
    disconnect() {}
    _trigger()   { this._callback([]); }
  };

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
//   - The real module needing browser globals at import time
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class HeroChatView extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            overflow: hidden;
          }
          .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: var(--spacing-sm, 8px);
            scroll-behavior: smooth;
          }
          .interaction-stream {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-sm, 8px);
            min-height: 100%;
          }
        </style>
        <div class="chat-container">
          <div class="interaction-stream">
            <slot></slot>
          </div>
        </div>
      `;

      this._chatContainer     = this.shadowRoot.querySelector('.chat-container');
      this._interactionStream = this.shadowRoot.querySelector('.interaction-stream');
      this._isAnchoredToBottom = true;
      this._resizeObserver     = null;

      this._onScroll = this._onScroll.bind(this);
    }

    get isAnchoredToBottom() { return this._isAnchoredToBottom; }

    connectedCallback() {
      this._chatContainer.addEventListener('scroll', this._onScroll);
      this._resizeObserver = new dom.window.ResizeObserver(() => this._onContentResize());
      this._resizeObserver.observe(this._interactionStream);
    }

    disconnectedCallback() {
      this._chatContainer.removeEventListener('scroll', this._onScroll);

      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
    }

    _onScroll() {
      let container        = this._chatContainer;
      let distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      let anchored         = distanceFromBottom <= ANCHOR_THRESHOLD;

      if (anchored !== this._isAnchoredToBottom) {
        this._isAnchoredToBottom = anchored;
        this.dispatchEvent(new dom.window.CustomEvent('anchored-change', {
          bubbles:  true,
          composed: true,
          detail:   { anchored },
        }));
      }
    }

    _onContentResize() {
      if (this._isAnchoredToBottom)
        this._scrollToBottomImmediate();
    }

    _scrollToBottomImmediate() {
      let container       = this._chatContainer;
      container.scrollTop = container.scrollHeight - container.clientHeight;
    }

    scrollToBottom() {
      this._isAnchoredToBottom = true;
      this._chatContainer.scrollTop = this._chatContainer.scrollHeight - this._chatContainer.clientHeight;

      this.dispatchEvent(new dom.window.CustomEvent('anchored-change', {
        bubbles:  true,
        composed: true,
        detail:   { anchored: true },
      }));
    }

    appendInteraction(element) {
      this._interactionStream.appendChild(element);
    }
  }

  dom.window.customElements.define('hero-chat-view', HeroChatView);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-chat-view', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-chat-view');
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
    let registered = dom.window.customElements.get('hero-chat-view');
    assert.ok(registered, 'hero-chat-view should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Contains .chat-container scroll area
  // -------------------------------------------------------------------------

  it('contains a .chat-container scroll area', () => {
    let chatContainer = element.shadowRoot.querySelector('.chat-container');
    assert.ok(chatContainer, 'should have a .chat-container element');
  });

  // -------------------------------------------------------------------------
  // 4. Contains .interaction-stream inside chat-container
  // -------------------------------------------------------------------------

  it('contains .interaction-stream inside chat-container', () => {
    let chatContainer     = element.shadowRoot.querySelector('.chat-container');
    let interactionStream = chatContainer.querySelector('.interaction-stream');
    assert.ok(interactionStream, 'should have a .interaction-stream inside .chat-container');
  });

  // -------------------------------------------------------------------------
  // 5. isAnchoredToBottom defaults to true
  // -------------------------------------------------------------------------

  it('isAnchoredToBottom defaults to true', () => {
    assert.equal(element.isAnchoredToBottom, true, 'isAnchoredToBottom should default to true');
  });

  // -------------------------------------------------------------------------
  // 6. appendInteraction() adds element to interaction-stream
  // -------------------------------------------------------------------------

  it('appendInteraction() adds element to interaction-stream', () => {
    let child = dom.window.document.createElement('div');
    child.textContent = 'Hello world';
    element.appendInteraction(child);

    let interactionStream = element.shadowRoot.querySelector('.interaction-stream');
    let children          = interactionStream.querySelectorAll('div');

    assert.ok(children.length >= 1, 'interaction-stream should contain the appended element');
    assert.equal(children[children.length - 1].textContent, 'Hello world');
  });

  // -------------------------------------------------------------------------
  // 7. scrollToBottom() sets anchored to true and dispatches anchored-change
  // -------------------------------------------------------------------------

  it('scrollToBottom() sets anchored to true and dispatches anchored-change event', () => {
    // First unanchor by setting the internal state directly
    element._isAnchoredToBottom = false;

    let eventDetail = null;
    element.addEventListener('anchored-change', (event) => {
      eventDetail = event.detail;
    });

    element.scrollToBottom();

    assert.equal(element.isAnchoredToBottom, true, 'isAnchoredToBottom should be true after scrollToBottom');
    assert.ok(eventDetail, 'anchored-change event should have been dispatched');
    assert.equal(eventDetail.anchored, true, 'event detail should indicate anchored is true');
  });

  // -------------------------------------------------------------------------
  // 8. _onScroll sets anchored to false when far from bottom
  // -------------------------------------------------------------------------

  it('_onScroll sets anchored to false when far from bottom', () => {
    let chatContainer = element._chatContainer;

    // Mock scroll properties: container has lots of content, user scrolled to top
    Object.defineProperty(chatContainer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(chatContainer, 'scrollTop',    { value: 0, writable: true, configurable: true });
    Object.defineProperty(chatContainer, 'clientHeight', { value: 400, configurable: true });

    // Trigger scroll handler
    element._onScroll();

    assert.equal(element.isAnchoredToBottom, false, 'should not be anchored when 600px from bottom');
  });

  // -------------------------------------------------------------------------
  // 9. _onScroll sets anchored to true when near bottom
  // -------------------------------------------------------------------------

  it('_onScroll sets anchored to true when near bottom', () => {
    let chatContainer = element._chatContainer;

    // First set to unanchored state
    element._isAnchoredToBottom = false;

    // Mock scroll properties: user is within ANCHOR_THRESHOLD of the bottom
    Object.defineProperty(chatContainer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(chatContainer, 'scrollTop',    { value: 570, writable: true, configurable: true });
    Object.defineProperty(chatContainer, 'clientHeight', { value: 400, configurable: true });
    // distanceFromBottom = 1000 - 570 - 400 = 30 (<= 50)

    element._onScroll();

    assert.equal(element.isAnchoredToBottom, true, 'should be anchored when 30px from bottom');
  });

  // -------------------------------------------------------------------------
  // 10. Dispatches anchored-change event when anchor state changes
  // -------------------------------------------------------------------------

  it('dispatches anchored-change event when anchor state changes', () => {
    let chatContainer = element._chatContainer;
    let events        = [];

    element.addEventListener('anchored-change', (event) => {
      events.push(event.detail);
    });

    // Mock scroll far from bottom to trigger unanchor
    Object.defineProperty(chatContainer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(chatContainer, 'scrollTop',    { value: 0, writable: true, configurable: true });
    Object.defineProperty(chatContainer, 'clientHeight', { value: 400, configurable: true });

    element._onScroll();

    assert.equal(events.length, 1, 'should have dispatched one anchored-change event');
    assert.equal(events[0].anchored, false, 'event should report anchored = false');

    // Now scroll back near bottom
    Object.defineProperty(chatContainer, 'scrollTop', { value: 580, writable: true, configurable: true });

    element._onScroll();

    assert.equal(events.length, 2, 'should have dispatched two anchored-change events');
    assert.equal(events[1].anchored, true, 'event should report anchored = true');
  });

  // -------------------------------------------------------------------------
  // 11. Has a slot for light DOM children
  // -------------------------------------------------------------------------

  it('has a slot for light DOM children', () => {
    let slot = element.shadowRoot.querySelector('slot');
    assert.ok(slot, 'should have a <slot> element in shadow DOM');
  });

  // -------------------------------------------------------------------------
  // 12. Uses ResizeObserver (observer is created in connectedCallback)
  // -------------------------------------------------------------------------

  it('creates a ResizeObserver in connectedCallback', () => {
    assert.ok(element._resizeObserver, 'should have a ResizeObserver after being connected');
    assert.ok(
      element._resizeObserver instanceof dom.window.ResizeObserver,
      'should be an instance of ResizeObserver'
    );
  });

  // -------------------------------------------------------------------------
  // 13. disconnectedCallback cleans up ResizeObserver
  // -------------------------------------------------------------------------

  it('disconnectedCallback cleans up ResizeObserver', () => {
    element.parentNode.removeChild(element);

    assert.equal(element._resizeObserver, null, 'ResizeObserver should be null after disconnect');
  });

  // -------------------------------------------------------------------------
  // 14. _onContentResize scrolls to bottom when anchored
  // -------------------------------------------------------------------------

  it('_onContentResize scrolls to bottom when anchored', () => {
    let chatContainer = element._chatContainer;

    Object.defineProperty(chatContainer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(chatContainer, 'scrollTop',    { value: 0, writable: true, configurable: true });
    Object.defineProperty(chatContainer, 'clientHeight', { value: 400, configurable: true });

    // Element starts anchored (default), so resize should scroll
    element._onContentResize();

    assert.equal(chatContainer.scrollTop, 600, 'scrollTop should be set to scrollHeight - clientHeight');
  });

  // -------------------------------------------------------------------------
  // 15. _onContentResize does NOT scroll when not anchored
  // -------------------------------------------------------------------------

  it('_onContentResize does not scroll when not anchored', () => {
    let chatContainer = element._chatContainer;

    Object.defineProperty(chatContainer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(chatContainer, 'scrollTop',    { value: 100, writable: true, configurable: true });
    Object.defineProperty(chatContainer, 'clientHeight', { value: 400, configurable: true });

    element._isAnchoredToBottom = false;
    element._onContentResize();

    assert.equal(chatContainer.scrollTop, 100, 'scrollTop should not have changed');
  });

  // -------------------------------------------------------------------------
  // 16. Does not dispatch anchored-change when state doesn't change
  // -------------------------------------------------------------------------

  it('does not dispatch anchored-change when state does not change', () => {
    let chatContainer = element._chatContainer;
    let eventCount    = 0;

    element.addEventListener('anchored-change', () => {
      eventCount++;
    });

    // Element starts anchored. Mock being near bottom (still anchored).
    Object.defineProperty(chatContainer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(chatContainer, 'scrollTop',    { value: 580, writable: true, configurable: true });
    Object.defineProperty(chatContainer, 'clientHeight', { value: 400, configurable: true });
    // distanceFromBottom = 1000 - 580 - 400 = 20 (<= 50, still anchored)

    element._onScroll();

    assert.equal(eventCount, 0, 'should not dispatch event when anchor state has not changed');
  });

  // -------------------------------------------------------------------------
  // 17. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;
    globalThis.CustomEvent    = dom.window.CustomEvent;
    globalThis.ResizeObserver = dom.window.ResizeObserver;

    try {
      let mod = await import('../../components/hero-chat-view/hero-chat-view.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
      delete globalThis.ResizeObserver;
    }
  });
});
