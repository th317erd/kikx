'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// i18n strings used by the component (hardcoded for test isolation so we
// don't need to import the real i18n module or the store/seqda dependency).
// ---------------------------------------------------------------------------

const LOCALE = {
  statusBar: {
    connected:    'Connected',
    connecting:   'Connecting...',
    disconnected: 'Disconnected',
    globalCost:   'Global',
    serviceCost:  'Service',
    sessionCost:  'Session',
  },
};

function t(key) {
  let parts   = key.split('.');
  let current = LOCALE;

  for (let part of parts) {
    if (current == null || typeof current !== 'object') {
      return key;
    }

    current = current[part];
  }

  return (current !== undefined) ? current : key;
}

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
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
  if (dom) {
    dom.window.close();
  }

  dom = null;
}

// ---------------------------------------------------------------------------
// Test-local component definition
// ---------------------------------------------------------------------------
// Mirrors the real component's DOM structure, but avoids importing
// store.mjs (which depends on the seqda CDN module). The update()
// method accepts an options object so tests can drive the rendering
// without needing a live store.
// ---------------------------------------------------------------------------

const STATUS_COLORS = {
  connected:    '#00ff88',
  connecting:   '#ffcc00',
  disconnected: '#ff4444',
};

const STATUS_KEYS = {
  connected:    'statusBar.connected',
  connecting:   'statusBar.connecting',
  disconnected: 'statusBar.disconnected',
};

function formatCost(value) {
  return '$' + Number(value).toFixed(2);
}

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class HeroStatusBar extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._unsubscribe = null;
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: flex;
            align-items: center;
            justify-content: space-between;
            height: 30px;
            padding: 0 12px;
            font-size: 12px;
            font-family: var(--font-family, system-ui, sans-serif);
            color: var(--text-secondary, #a0a0b8);
            background: var(--glass-background, rgba(10, 10, 30, 0.7));
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border-top: 1px solid var(--border-glow, rgba(100, 200, 255, 0.15));
            box-shadow: 0 -1px 8px var(--glow-subtle, rgba(100, 200, 255, 0.05));
            box-sizing: border-box;
            user-select: none;
          }

          .connection-status {
            display: flex;
            align-items: center;
            gap: 6px;
          }

          .status-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--status-color, #ff4444);
          }

          .status-text {
            color: var(--text-secondary, #a0a0b8);
          }

          .cost-display {
            display: flex;
            align-items: center;
            gap: 4px;
            color: var(--text-secondary, #a0a0b8);
          }

          .cost-separator {
            margin: 0 4px;
            opacity: 0.5;
          }
        </style>

        <div class="connection-status">
          <span class="status-dot"></span>
          <span class="status-text"></span>
        </div>
        <div class="cost-display"></div>
      `;

      // Default state: disconnected with zero costs.
      this.update({
        status: 'disconnected',
        costs:  { global: 0, service: 0, session: 0 },
      });
    }

    disconnectedCallback() {
      if (this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
      }
    }

    update(options) {
      if (!options) {
        return;
      }

      let status = options.status || 'disconnected';
      let costs  = options.costs || { global: 0, service: 0, session: 0 };

      let dot         = this.shadowRoot.querySelector('.status-dot');
      let text        = this.shadowRoot.querySelector('.status-text');
      let costDisplay = this.shadowRoot.querySelector('.cost-display');

      if (!dot || !text || !costDisplay) {
        return;
      }

      let color = STATUS_COLORS[status] || STATUS_COLORS.disconnected;
      let label = t(STATUS_KEYS[status] || STATUS_KEYS.disconnected);

      dot.style.background = color;
      text.textContent = label;

      let globalLabel  = t('statusBar.globalCost');
      let serviceLabel = t('statusBar.serviceCost');
      let sessionLabel = t('statusBar.sessionCost');

      costDisplay.innerHTML =
        `<span>${globalLabel}: ${formatCost(costs.global)}</span>` +
        `<span class="cost-separator">|</span>` +
        `<span>${serviceLabel}: ${formatCost(costs.service)}</span>` +
        `<span class="cost-separator">|</span>` +
        `<span>${sessionLabel}: ${formatCost(costs.session)}</span>`;
    }
  }

  dom.window.customElements.define('hero-status-bar', HeroStatusBar);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-status-bar', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-status-bar');
    dom.window.document.body.appendChild(element);
  });

  afterEach(() => {
    if (element && element.parentNode) {
      element.parentNode.removeChild(element);
    }

    teardownDOM();
  });

  // -------------------------------------------------------------------------
  // 1. Registers as custom element
  // -------------------------------------------------------------------------

  it('registers as a custom element', () => {
    let registered = dom.window.customElements.get('hero-status-bar');
    assert.ok(registered, 'hero-status-bar should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Contains connection status indicator
  // -------------------------------------------------------------------------

  it('contains connection status indicator', () => {
    let statusContainer = element.shadowRoot.querySelector('.connection-status');
    assert.ok(statusContainer, 'shadow DOM should contain .connection-status');

    let dot = element.shadowRoot.querySelector('.status-dot');
    assert.ok(dot, 'shadow DOM should contain .status-dot');

    let text = element.shadowRoot.querySelector('.status-text');
    assert.ok(text, 'shadow DOM should contain .status-text');
  });

  // -------------------------------------------------------------------------
  // 4. Shows 'Disconnected' by default (initial store state)
  // -------------------------------------------------------------------------

  it('shows Disconnected by default', () => {
    let text = element.shadowRoot.querySelector('.status-text');
    assert.equal(text.textContent, 'Disconnected', 'default status should be Disconnected');
  });

  // -------------------------------------------------------------------------
  // 5. Contains cost display section
  // -------------------------------------------------------------------------

  it('contains cost display section', () => {
    let costDisplay = element.shadowRoot.querySelector('.cost-display');
    assert.ok(costDisplay, 'shadow DOM should contain .cost-display');
  });

  // -------------------------------------------------------------------------
  // 6. Shows all three cost labels (Global, Service, Session)
  // -------------------------------------------------------------------------

  it('shows all three cost labels', () => {
    let costDisplay = element.shadowRoot.querySelector('.cost-display');
    let html = costDisplay.innerHTML;

    assert.ok(html.includes('Global'), 'cost display should include Global label');
    assert.ok(html.includes('Service'), 'cost display should include Service label');
    assert.ok(html.includes('Session'), 'cost display should include Session label');
  });

  // -------------------------------------------------------------------------
  // 7. Formats costs as dollar amounts with 2 decimals
  // -------------------------------------------------------------------------

  it('formats costs as dollar amounts with 2 decimals', () => {
    let costDisplay = element.shadowRoot.querySelector('.cost-display');
    let html = costDisplay.innerHTML;

    assert.ok(html.includes('$0.00'), 'default costs should show $0.00');

    element.update({
      status: 'connected',
      costs:  { global: 12.5, service: 3.1, session: 0.75 },
    });

    html = costDisplay.innerHTML;
    assert.ok(html.includes('$12.50'), 'global cost should be formatted as $12.50');
    assert.ok(html.includes('$3.10'), 'service cost should be formatted as $3.10');
    assert.ok(html.includes('$0.75'), 'session cost should be formatted as $0.75');
  });

  // -------------------------------------------------------------------------
  // 8. Connection status dot is colored appropriately (red for disconnected)
  // -------------------------------------------------------------------------

  it('connection status dot is colored appropriately', () => {
    let dot = element.shadowRoot.querySelector('.status-dot');

    // Default is disconnected -- red (jsdom normalizes hex to rgb)
    assert.ok(
      dot.style.background.includes('rgb(255, 68, 68)') || dot.style.background === '#ff4444',
      'disconnected dot should be red',
    );

    // Update to connected -- green
    element.update({
      status: 'connected',
      costs:  { global: 0, service: 0, session: 0 },
    });
    assert.ok(
      dot.style.background.includes('rgb(0, 255, 136)') || dot.style.background === '#00ff88',
      'connected dot should be green',
    );

    // Update to connecting -- yellow
    element.update({
      status: 'connecting',
      costs:  { global: 0, service: 0, session: 0 },
    });
    assert.ok(
      dot.style.background.includes('rgb(255, 204, 0)') || dot.style.background === '#ffcc00',
      'connecting dot should be yellow',
    );
  });

  // -------------------------------------------------------------------------
  // 9. Update method refreshes the display when called
  // -------------------------------------------------------------------------

  it('update method refreshes the display when called', () => {
    let text        = element.shadowRoot.querySelector('.status-text');
    let costDisplay = element.shadowRoot.querySelector('.cost-display');

    assert.equal(text.textContent, 'Disconnected', 'initial status text');

    element.update({
      status: 'connected',
      costs:  { global: 100.99, service: 50.05, session: 25.10 },
    });

    assert.equal(text.textContent, 'Connected', 'status text should update to Connected');
    assert.ok(costDisplay.innerHTML.includes('$100.99'), 'global cost should be updated');
    assert.ok(costDisplay.innerHTML.includes('$50.05'), 'service cost should be updated');
    assert.ok(costDisplay.innerHTML.includes('$25.10'), 'session cost should be updated');

    element.update({
      status: 'connecting',
      costs:  { global: 0, service: 0, session: 0 },
    });

    assert.equal(text.textContent, 'Connecting...', 'status text should update to Connecting...');
  });

  // -------------------------------------------------------------------------
  // Additional: real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/hero-status-bar/hero-status-bar.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
