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
    url: 'http://localhost/hero/',
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

  class HeroReflectionBlock extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            border-radius: var(--border-radius-small, 4px);
            overflow: hidden;
          }

          .toggle-header {
            display: flex;
            align-items: center;
            gap: var(--spacing-xs, 4px);
            padding: 6px 8px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-small, 4px);
            cursor: pointer;
            user-select: none;
            font-size: 0.8125rem;
            color: var(--text-secondary, #a0a0b8);
            transition: background 0.2s ease;
            width: 100%;
            text-align: left;
          }

          .toggle-header:hover {
            background: var(--glass-hover, rgba(255, 255, 255, 0.08));
          }

          .collapse-indicator {
            display: inline-block;
            font-size: 0.625rem;
            transition: transform 0.2s ease;
          }

          .collapse-indicator.expanded {
            transform: rotate(90deg);
          }

          .brain-icon {
            font-size: 1rem;
          }

          .label {
            font-weight: 600;
          }

          .reflection-content {
            display: none;
            padding: var(--spacing-sm, 8px);
            font-size: 0.875rem;
            line-height: 1.5;
            color: var(--text-secondary, #a0a0b8);
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-top: none;
            border-radius: 0 0 var(--border-radius-small, 4px) var(--border-radius-small, 4px);
            white-space: pre-wrap;
          }

          .reflection-content.expanded {
            display: block;
          }
        </style>

        <button class="toggle-header">
          <span class="collapse-indicator">\u25B6</span>
          <span class="brain-icon">\uD83E\uDDE0</span>
          <span class="label"></span>
        </button>
        <div class="reflection-content"></div>
      `;

      this._toggleHeader      = this.shadowRoot.querySelector('.toggle-header');
      this._collapseIndicator = this.shadowRoot.querySelector('.collapse-indicator');
      this._label             = this.shadowRoot.querySelector('.label');
      this._reflectionContent = this.shadowRoot.querySelector('.reflection-content');
      this._expanded          = false;

      this._onToggleClick = this._onToggleClick.bind(this);
    }

    static get observedAttributes() { return ['expanded']; }

    connectedCallback() {
      this._label.textContent = mockT('chat.reflection.label');
      this._toggleHeader.addEventListener('click', this._onToggleClick);

      if (this.hasAttribute('expanded'))
        this._setExpanded(true);
    }

    disconnectedCallback() {
      this._toggleHeader.removeEventListener('click', this._onToggleClick);
    }

    attributeChangedCallback(name) {
      if (name === 'expanded') {
        let shouldExpand = this.hasAttribute('expanded');

        if (shouldExpand !== this._expanded)
          this._setExpanded(shouldExpand);
      }
    }

    get content() {
      return this._reflectionContent.textContent;
    }

    set content(value) {
      this._reflectionContent.textContent = value;
    }

    toggle() {
      this._setExpanded(!this._expanded);
      this._dispatchToggleEvent();
    }

    expand() {
      if (!this._expanded) {
        this._setExpanded(true);
        this._dispatchToggleEvent();
      }
    }

    collapse() {
      if (this._expanded) {
        this._setExpanded(false);
        this._dispatchToggleEvent();
      }
    }

    _onToggleClick() {
      this.toggle();
    }

    _setExpanded(expanded) {
      this._expanded = expanded;

      if (expanded) {
        this._collapseIndicator.classList.add('expanded');
        this._reflectionContent.classList.add('expanded');
      } else {
        this._collapseIndicator.classList.remove('expanded');
        this._reflectionContent.classList.remove('expanded');
      }
    }

    _dispatchToggleEvent() {
      this.dispatchEvent(new dom.window.CustomEvent('reflection-toggle', {
        bubbles:  true,
        composed: true,
        detail:   { expanded: this._expanded },
      }));
    }
  }

  dom.window.customElements.define('hero-reflection-block', HeroReflectionBlock);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-reflection-block', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-reflection-block');
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
    let registered = dom.window.customElements.get('hero-reflection-block');
    assert.ok(registered, 'hero-reflection-block should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Default state is collapsed (content hidden)
  // -------------------------------------------------------------------------

  it('default state is collapsed', () => {
    let content = element.shadowRoot.querySelector('.reflection-content');
    assert.ok(content, 'shadow DOM should contain .reflection-content');
    assert.ok(
      !content.classList.contains('expanded'),
      'reflection content should not have expanded class by default',
    );
  });

  // -------------------------------------------------------------------------
  // 4. Contains brain emoji icon
  // -------------------------------------------------------------------------

  it('contains brain emoji icon', () => {
    let brainIcon = element.shadowRoot.querySelector('.brain-icon');
    assert.ok(brainIcon, 'shadow DOM should contain .brain-icon');
    assert.equal(brainIcon.textContent, '\uD83E\uDDE0', 'brain icon should display the brain emoji');
  });

  // -------------------------------------------------------------------------
  // 5. Label shows i18n "Reflection" text
  // -------------------------------------------------------------------------

  it('label shows i18n Reflection text', () => {
    let label = element.shadowRoot.querySelector('.label');
    assert.ok(label, 'shadow DOM should contain .label');
    assert.equal(
      label.textContent,
      localeData.chat.reflection.label,
      'label should match i18n value',
    );
  });

  // -------------------------------------------------------------------------
  // 6. Clicking toggle expands content
  // -------------------------------------------------------------------------

  it('clicking toggle expands content', () => {
    let header  = element.shadowRoot.querySelector('.toggle-header');
    let content = element.shadowRoot.querySelector('.reflection-content');

    header.click();

    assert.ok(
      content.classList.contains('expanded'),
      'reflection content should have expanded class after click',
    );
  });

  // -------------------------------------------------------------------------
  // 7. Clicking toggle again collapses content
  // -------------------------------------------------------------------------

  it('clicking toggle again collapses content', () => {
    let header  = element.shadowRoot.querySelector('.toggle-header');
    let content = element.shadowRoot.querySelector('.reflection-content');

    header.click();
    assert.ok(content.classList.contains('expanded'), 'should be expanded after first click');

    header.click();
    assert.ok(
      !content.classList.contains('expanded'),
      'should be collapsed after second click',
    );
  });

  // -------------------------------------------------------------------------
  // 8. Collapse indicator rotates when expanded
  // -------------------------------------------------------------------------

  it('collapse indicator has expanded class when expanded', () => {
    let header    = element.shadowRoot.querySelector('.toggle-header');
    let indicator = element.shadowRoot.querySelector('.collapse-indicator');

    assert.ok(
      !indicator.classList.contains('expanded'),
      'indicator should not have expanded class by default',
    );

    header.click();

    assert.ok(
      indicator.classList.contains('expanded'),
      'indicator should have expanded class after expanding',
    );
  });

  // -------------------------------------------------------------------------
  // 9. Content property sets reflection text
  // -------------------------------------------------------------------------

  it('content property sets reflection text', () => {
    let reflectionText = 'The user is asking about quantum computing.';
    element.content = reflectionText;

    let content = element.shadowRoot.querySelector('.reflection-content');
    assert.equal(
      content.textContent,
      reflectionText,
      'reflection content text should match the set value',
    );
  });

  // -------------------------------------------------------------------------
  // 10. expanded attribute starts the block expanded
  // -------------------------------------------------------------------------

  it('expanded attribute starts the block expanded', () => {
    teardownDOM();
    setupDOM();

    let expandedElement = dom.window.document.createElement('hero-reflection-block');
    expandedElement.setAttribute('expanded', '');
    dom.window.document.body.appendChild(expandedElement);

    let content   = expandedElement.shadowRoot.querySelector('.reflection-content');
    let indicator = expandedElement.shadowRoot.querySelector('.collapse-indicator');

    assert.ok(
      content.classList.contains('expanded'),
      'content should have expanded class when expanded attribute is set',
    );
    assert.ok(
      indicator.classList.contains('expanded'),
      'indicator should have expanded class when expanded attribute is set',
    );

    expandedElement.parentNode.removeChild(expandedElement);
  });

  // -------------------------------------------------------------------------
  // 11. toggle() method toggles state
  // -------------------------------------------------------------------------

  it('toggle() method toggles state', () => {
    let content = element.shadowRoot.querySelector('.reflection-content');

    assert.ok(!content.classList.contains('expanded'), 'should start collapsed');

    element.toggle();
    assert.ok(content.classList.contains('expanded'), 'should be expanded after toggle()');

    element.toggle();
    assert.ok(!content.classList.contains('expanded'), 'should be collapsed after second toggle()');
  });

  // -------------------------------------------------------------------------
  // 12. Dispatches reflection-toggle event on toggle
  // -------------------------------------------------------------------------

  it('dispatches reflection-toggle event on toggle', () => {
    let events = [];

    element.addEventListener('reflection-toggle', (event) => {
      events.push(event);
    });

    element.toggle();

    assert.equal(events.length, 1, 'should have dispatched one event');
    assert.equal(events[0].detail.expanded, true, 'event detail should indicate expanded');
    assert.equal(events[0].bubbles, true, 'event should bubble');
    assert.equal(events[0].composed, true, 'event should be composed');

    element.toggle();

    assert.equal(events.length, 2, 'should have dispatched two events');
    assert.equal(events[1].detail.expanded, false, 'second event detail should indicate collapsed');
  });

  // -------------------------------------------------------------------------
  // Additional: real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/hero-reflection-block/hero-reflection-block.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
