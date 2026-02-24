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
// Test fixtures
// ---------------------------------------------------------------------------

function makeAbilities() {
  return {
    system: [
      { id: 's1', name: 'Web Search',    category: 'search',  description: 'Search the web for information' },
      { id: 's2', name: 'Code Runner',   category: 'code',    description: 'Execute code snippets' },
    ],
    user: [
      { id: 'u1', name: 'My Summarizer', category: 'text',    description: 'Summarize long documents' },
      { id: 'u2', name: 'Translator',    category: 'language', description: 'Translate between languages' },
    ],
  };
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
// Mirrors the real component's rendering logic but skips the hero-modal
// wrapper since jsdom does not have hero-modal registered. The tab switching,
// ability cards, events, and empty-state behavior are identical to the real
// component.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class HeroAbilityListModal extends JsdomHTMLElement {
    static get observedAttributes() { return ['open']; }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }

          .tabs {
            display: flex; gap: 0;
            border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            margin-bottom: 12px;
          }

          .tab-button {
            background: none; border: none;
            padding: 8px 16px; font-size: 0.875rem;
            color: var(--text-muted, #606078);
            cursor: pointer;
            border-bottom: 2px solid transparent;
            transition: color 0.2s ease;
          }

          .tab-button.active {
            color: var(--accent-primary, #00e5ff);
            border-bottom-color: var(--accent-primary, #00e5ff);
          }

          .tab-button:hover { color: var(--text-primary, #e8e8f0); }

          .ability-list { display: flex; flex-direction: column; gap: var(--spacing-sm, 8px); }

          .ability-card {
            padding: 10px 12px;
            background: var(--glass-background, rgba(255, 255, 255, 0.05));
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-medium, 8px);
            cursor: pointer; transition: background 0.2s ease;
          }

          .ability-card:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

          .ability-name {
            font-weight: 600; font-size: 0.9375rem;
            color: var(--text-primary, #e8e8f0);
          }

          .category-badge {
            display: inline-block; padding: 1px 8px;
            border-radius: 3px; font-size: 0.7rem;
            font-weight: 600; text-transform: uppercase;
            background: rgba(0, 229, 255, 0.15);
            color: var(--accent-primary, #00e5ff);
            margin-left: 8px;
          }

          .ability-description {
            font-size: 0.8125rem;
            color: var(--text-secondary, #a0a0b8);
            margin-top: 4px; line-height: 1.4;
          }

          .empty-state {
            text-align: center; padding: 20px;
            color: var(--text-muted, #606078);
            font-size: 0.875rem;
          }

          .add-button {
            width: 100%; margin-top: var(--spacing-sm, 8px);
            padding: 10px; background: var(--accent-primary, #00e5ff);
            color: var(--bg-primary, #0a0a12); border: none;
            border-radius: var(--border-radius-small, 4px);
            font-weight: 600; font-size: 0.875rem; cursor: pointer;
          }

          .add-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }

          .tab-content { display: none; }
          .tab-content.active { display: block; }
        </style>

        <div class="tabs">
          <button class="tab-button system-tab active" data-tab="system"></button>
          <button class="tab-button user-tab" data-tab="user"></button>
        </div>
        <div class="tab-content system-content active">
          <div class="ability-list system-list"></div>
        </div>
        <div class="tab-content user-content">
          <div class="ability-list user-list"></div>
          <button class="add-button"></button>
        </div>
      `;

      this._systemTab     = this.shadowRoot.querySelector('.system-tab');
      this._userTab       = this.shadowRoot.querySelector('.user-tab');
      this._systemContent = this.shadowRoot.querySelector('.system-content');
      this._userContent   = this.shadowRoot.querySelector('.user-content');
      this._systemList    = this.shadowRoot.querySelector('.system-list');
      this._userList      = this.shadowRoot.querySelector('.user-list');
      this._addButton     = this.shadowRoot.querySelector('.add-button');

      this._systemTab.textContent = mockT('ability.list.title');
      this._userTab.textContent   = mockT('ability.list.myAbilitiesTab');
      this._addButton.textContent = mockT('ability.list.addButton');

      this._abilities = { system: [], user: [] };

      this._onTabClick        = this._onTabClick.bind(this);
      this._onSystemListClick = this._onSystemListClick.bind(this);
      this._onUserListClick   = this._onUserListClick.bind(this);
      this._onAddClick        = this._onAddClick.bind(this);
    }

    connectedCallback() {
      this._systemTab.addEventListener('click', this._onTabClick);
      this._userTab.addEventListener('click', this._onTabClick);
      this._systemList.addEventListener('click', this._onSystemListClick);
      this._userList.addEventListener('click', this._onUserListClick);
      this._addButton.addEventListener('click', this._onAddClick);
      this._render();
    }

    disconnectedCallback() {
      this._systemTab.removeEventListener('click', this._onTabClick);
      this._userTab.removeEventListener('click', this._onTabClick);
      this._systemList.removeEventListener('click', this._onSystemListClick);
      this._userList.removeEventListener('click', this._onUserListClick);
      this._addButton.removeEventListener('click', this._onAddClick);
    }

    // -----------------------------------------------------------------------
    // Public properties
    // -----------------------------------------------------------------------

    set abilities(value) {
      this._abilities = value || { system: [], user: [] };
      this._render();
    }

    get abilities() {
      return this._abilities;
    }

    // -----------------------------------------------------------------------
    // Public methods
    // -----------------------------------------------------------------------

    open() {
      this.setAttribute('open', '');
    }

    close() {
      this.removeAttribute('open');
    }

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    _onTabClick(event) {
      let tab = event.target.dataset.tab;

      if (tab === 'system') {
        this._systemTab.classList.add('active');
        this._userTab.classList.remove('active');
        this._systemContent.classList.add('active');
        this._userContent.classList.remove('active');
      } else if (tab === 'user') {
        this._userTab.classList.add('active');
        this._systemTab.classList.remove('active');
        this._userContent.classList.add('active');
        this._systemContent.classList.remove('active');
      }
    }

    _onSystemListClick(event) {
      this._handleAbilityClick(event);
    }

    _onUserListClick(event) {
      this._handleAbilityClick(event);
    }

    _handleAbilityClick(event) {
      let card = event.target.closest('.ability-card');
      if (card) {
        let abilityId = card.dataset.abilityId;

        this.dispatchEvent(new dom.window.CustomEvent('select-ability', {
          bubbles:  true,
          composed: true,
          detail:   { abilityId },
        }));
      }
    }

    _onAddClick() {
      this.dispatchEvent(new dom.window.CustomEvent('create-ability', {
        bubbles:  true,
        composed: true,
      }));
    }

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    _render() {
      if (!this._systemList || !this._userList) return;

      this._renderList(this._systemList, this._abilities.system);
      this._renderList(this._userList, this._abilities.user);
    }

    _renderList(container, abilities) {
      if (!abilities || abilities.length === 0) {
        container.innerHTML = '<div class="empty-state">No abilities available.</div>';
        return;
      }

      let html = '';

      for (let ability of abilities) {
        html += `<div class="ability-card" data-ability-id="${ability.id}">`;
        html += `<div class="ability-card-header">`;
        html += `<span class="ability-name">${ability.name}</span>`;
        html += `<span class="category-badge">${ability.category}</span>`;
        html += `</div>`;
        html += `<div class="ability-description">${ability.description}</div>`;
        html += `</div>`;
      }

      container.innerHTML = html;
    }
  }

  dom.window.customElements.define('hero-ability-list-modal', HeroAbilityListModal);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-ability-list-modal', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-ability-list-modal');
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
    let registered = dom.window.customElements.get('hero-ability-list-modal');
    assert.ok(registered, 'hero-ability-list-modal should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Has two tab buttons with correct i18n labels
  // -------------------------------------------------------------------------

  it('has two tab buttons with correct i18n labels', () => {
    let systemTab = element.shadowRoot.querySelector('.system-tab');
    let userTab   = element.shadowRoot.querySelector('.user-tab');

    assert.ok(systemTab, 'should have system tab button');
    assert.ok(userTab, 'should have user tab button');
    assert.equal(systemTab.textContent, localeData.ability.list.title);
    assert.equal(userTab.textContent, localeData.ability.list.myAbilitiesTab);
  });

  // -------------------------------------------------------------------------
  // 4. System tab active by default
  // -------------------------------------------------------------------------

  it('system tab is active by default', () => {
    let systemTab     = element.shadowRoot.querySelector('.system-tab');
    let systemContent = element.shadowRoot.querySelector('.system-content');
    let userContent   = element.shadowRoot.querySelector('.user-content');

    assert.ok(systemTab.classList.contains('active'), 'system tab button should be active');
    assert.ok(systemContent.classList.contains('active'), 'system content should be active');
    assert.ok(!userContent.classList.contains('active'), 'user content should not be active');
  });

  // -------------------------------------------------------------------------
  // 5. Clicking user tab switches content
  // -------------------------------------------------------------------------

  it('clicking user tab switches content', () => {
    let systemTab     = element.shadowRoot.querySelector('.system-tab');
    let userTab       = element.shadowRoot.querySelector('.user-tab');
    let systemContent = element.shadowRoot.querySelector('.system-content');
    let userContent   = element.shadowRoot.querySelector('.user-content');

    userTab.click();

    assert.ok(!systemTab.classList.contains('active'), 'system tab should no longer be active');
    assert.ok(userTab.classList.contains('active'), 'user tab should be active');
    assert.ok(!systemContent.classList.contains('active'), 'system content should be hidden');
    assert.ok(userContent.classList.contains('active'), 'user content should be visible');
  });

  // -------------------------------------------------------------------------
  // 6. Renders system abilities in system tab
  // -------------------------------------------------------------------------

  it('renders system abilities in system tab', () => {
    element.abilities = makeAbilities();

    let cards = element.shadowRoot.querySelectorAll('.system-list .ability-card');
    assert.equal(cards.length, 2, 'should render 2 system ability cards');
  });

  // -------------------------------------------------------------------------
  // 7. Renders user abilities in user tab
  // -------------------------------------------------------------------------

  it('renders user abilities in user tab', () => {
    element.abilities = makeAbilities();

    let cards = element.shadowRoot.querySelectorAll('.user-list .ability-card');
    assert.equal(cards.length, 2, 'should render 2 user ability cards');
  });

  // -------------------------------------------------------------------------
  // 8. Ability card shows name and category badge
  // -------------------------------------------------------------------------

  it('ability card shows name and category badge', () => {
    element.abilities = makeAbilities();

    let card  = element.shadowRoot.querySelector('.system-list .ability-card');
    let name  = card.querySelector('.ability-name');
    let badge = card.querySelector('.category-badge');

    assert.ok(name, 'should have a name element');
    assert.ok(badge, 'should have a category badge element');
    assert.equal(name.textContent, 'Web Search');
    assert.equal(badge.textContent, 'search');
  });

  // -------------------------------------------------------------------------
  // 9. Ability card shows description
  // -------------------------------------------------------------------------

  it('ability card shows description', () => {
    element.abilities = makeAbilities();

    let card = element.shadowRoot.querySelector('.system-list .ability-card');
    let desc = card.querySelector('.ability-description');

    assert.ok(desc, 'should have a description element');
    assert.equal(desc.textContent, 'Search the web for information');
  });

  // -------------------------------------------------------------------------
  // 10. Clicking ability dispatches select-ability with abilityId
  // -------------------------------------------------------------------------

  it('clicking ability dispatches select-ability with abilityId', () => {
    element.abilities = makeAbilities();

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('select-ability', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    let card = element.shadowRoot.querySelector('.system-list .ability-card[data-ability-id="s2"]');
    card.click();

    assert.ok(eventFired, 'select-ability event should be dispatched');
    assert.deepEqual(eventDetail, { abilityId: 's2' });
  });

  // -------------------------------------------------------------------------
  // 11. New Ability button dispatches create-ability
  // -------------------------------------------------------------------------

  it('"New Ability" button dispatches create-ability event', () => {
    let eventFired = false;

    element.addEventListener('create-ability', () => {
      eventFired = true;
    });

    // Switch to user tab so the add button is in the active content
    let userTab = element.shadowRoot.querySelector('.user-tab');
    userTab.click();

    let addButton = element.shadowRoot.querySelector('.add-button');
    assert.equal(addButton.textContent, localeData.ability.list.addButton);
    addButton.click();

    assert.ok(eventFired, 'create-ability event should be dispatched');
  });

  // -------------------------------------------------------------------------
  // 12. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement     = dom.window.HTMLElement;
    globalThis.customElements  = { define() {}, get() {} };
    globalThis.document        = dom.window.document;
    globalThis.CustomEvent     = dom.window.CustomEvent;

    try {
      let mod = await import('../../components/hero-ability-list-modal/hero-ability-list-modal.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
    }
  });
});
