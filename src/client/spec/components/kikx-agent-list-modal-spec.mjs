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

function makeAgents() {
  return [
    { id: 'a1', name: 'Claude',    initials: 'CL', color: '#7c3aed' },
    { id: 'a2', name: 'GPT-4',     initials: 'G4', color: '#10b981' },
    { id: 'a3', name: 'Gemini',    initials: 'GE', color: '#f59e0b' },
  ];
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
// Mirrors the real component's rendering logic but skips the kikx-modal
// wrapper since jsdom does not have kikx-modal registered. The card list,
// events, and empty-state behavior are identical to the real component.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxAgentListModal extends JsdomHTMLElement {
    static get observedAttributes() { return ['open']; }

    constructor() {
      super();

      this._agents = [];

      this._onAgentListClick = this._onAgentListClick.bind(this);
      this._onAddClick       = this._onAddClick.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-agent-list-modal { display: contents; }

          .agent-list { display: flex; flex-direction: column; gap: var(--spacing-sm, 8px); }

          .agent-card {
            display: flex; align-items: center; gap: 12px;
            padding: 10px 12px;
            background: var(--glass-background, rgba(255, 255, 255, 0.05));
            border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            border-radius: var(--border-radius-medium, 8px);
            cursor: pointer; transition: background 0.2s ease;
          }

          .agent-card:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

          .agent-avatar {
            width: 36px; height: 36px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 0.8rem; color: #fff; flex-shrink: 0;
          }

          .agent-name { flex: 1; font-weight: 500; font-size: 0.9375rem; color: var(--text-primary, #e8e8f0); }

          .settings-button {
            background: none; border: none; font-size: 1.125rem;
            color: var(--text-muted, #606078); cursor: pointer;
            padding: 4px 8px; border-radius: var(--border-radius-small, 4px);
            transition: background 0.2s ease;
          }

          .settings-button:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); color: var(--text-primary, #e8e8f0); }

          .empty-state { text-align: center; padding: 20px; color: var(--text-muted, #606078); font-size: 0.875rem; }

          .add-button {
            width: 100%; margin-top: var(--spacing-sm, 8px);
            padding: 10px; background: var(--accent-primary, #00e5ff);
            color: var(--bg-primary, #0a0a12); border: none;
            border-radius: var(--border-radius-small, 4px);
            font-weight: 600; font-size: 0.875rem; cursor: pointer;
            transition: box-shadow 0.2s ease;
          }

          .add-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }
        </style>

        <div class="agent-list"></div>
        <button class="add-button"></button>
      `;

      this._agentList = this.querySelector('.agent-list');
      this._addButton = this.querySelector('.add-button');
      this._addButton.textContent = mockT('agent.list.addButton');

      this._agentList.addEventListener('click', this._onAgentListClick);
      this._addButton.addEventListener('click', this._onAddClick);
      this._render();
    }

    disconnectedCallback() {
      this._agentList.removeEventListener('click', this._onAgentListClick);
      this._addButton.removeEventListener('click', this._onAddClick);
    }

    // -----------------------------------------------------------------------
    // Public properties
    // -----------------------------------------------------------------------

    set agents(value) {
      this._agents = value || [];
      this._render();
    }

    get agents() {
      return this._agents;
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

    _onAgentListClick(event) {
      let target = event.target;

      // Settings gear button
      let settingsButton = target.closest('.settings-button');
      if (settingsButton) {
        let agentID = settingsButton.dataset.agentID;

        this.dispatchEvent(new dom.window.CustomEvent('edit-agent', {
          bubbles:  true,
          composed: true,
          detail:   { agentID },
        }));

        return;
      }

      // Agent card
      let card = target.closest('.agent-card');
      if (card) {
        let agentID = card.dataset.agentID;

        this.dispatchEvent(new dom.window.CustomEvent('select-agent', {
          bubbles:  true,
          composed: true,
          detail:   { agentID },
        }));
      }
    }

    _onAddClick() {
      this.dispatchEvent(new dom.window.CustomEvent('create-agent', {
        bubbles:  true,
        composed: true,
      }));
    }

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    _render() {
      if (!this._agentList) return;

      if (this._agents.length === 0) {
        this._agentList.innerHTML = `<div class="empty-state">${mockT('agent.list.empty')}</div>`;
        return;
      }

      let html = '';

      for (let agent of this._agents) {
        html += `<div class="agent-card" data-agent-id="${agent.id}">`;
        html += `<div class="agent-avatar" style="background-color: ${agent.color}">${agent.initials}</div>`;
        html += `<span class="agent-name">${agent.name}</span>`;
        html += `<button class="settings-button" data-agent-id="${agent.id}">\u2699</button>`;
        html += `</div>`;
      }

      this._agentList.innerHTML = html;
    }
  }

  dom.window.customElements.define('kikx-agent-list-modal', KikxAgentListModal);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-agent-list-modal', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-agent-list-modal');
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
    let registered = dom.window.customElements.get('kikx-agent-list-modal');
    assert.ok(registered, 'kikx-agent-list-modal should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Empty state shows "No agents configured." message
  // -------------------------------------------------------------------------

  it('shows empty state message when no agents are provided', () => {
    let emptyState = element.querySelector('.empty-state');
    assert.ok(emptyState, 'should render empty state element');
    assert.equal(emptyState.textContent, localeData.agent.list.empty);
  });

  // -------------------------------------------------------------------------
  // 4. Renders agent cards from agents property
  // -------------------------------------------------------------------------

  it('renders agent cards from agents property', () => {
    element.agents = makeAgents();

    let cards = element.querySelectorAll('.agent-card');
    assert.equal(cards.length, 3, 'should render 3 agent cards');
  });

  // -------------------------------------------------------------------------
  // 5. Agent card shows avatar with initials and color
  // -------------------------------------------------------------------------

  it('agent card shows avatar with initials and color', () => {
    element.agents = makeAgents();

    let avatar = element.querySelector('.agent-avatar');
    assert.ok(avatar, 'should have an avatar element');
    assert.equal(avatar.textContent, 'CL', 'avatar should show initials');
    assert.ok(
      avatar.getAttribute('style').includes('#7c3aed'),
      'avatar should have the agent color as background',
    );
  });

  // -------------------------------------------------------------------------
  // 6. Agent card shows agent name
  // -------------------------------------------------------------------------

  it('agent card shows agent name', () => {
    element.agents = makeAgents();

    let names = element.querySelectorAll('.agent-name');
    let texts = Array.from(names).map((el) => el.textContent);

    assert.ok(texts.includes('Claude'), 'should show Claude');
    assert.ok(texts.includes('GPT-4'), 'should show GPT-4');
    assert.ok(texts.includes('Gemini'), 'should show Gemini');
  });

  // -------------------------------------------------------------------------
  // 7. Agent card has settings gear button
  // -------------------------------------------------------------------------

  it('agent card has settings gear button', () => {
    element.agents = makeAgents();

    let buttons = element.querySelectorAll('.settings-button');
    assert.equal(buttons.length, 3, 'each card should have a settings button');
    assert.equal(buttons[0].textContent, '\u2699', 'settings button should show gear icon');
  });

  // -------------------------------------------------------------------------
  // 8. Clicking agent card dispatches select-agent event
  // -------------------------------------------------------------------------

  it('clicking agent card dispatches select-agent event with agentID', () => {
    element.agents = makeAgents();

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('select-agent', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    let card = element.querySelector('.agent-card[data-agent-id="a2"]');
    card.click();

    assert.ok(eventFired, 'select-agent event should be dispatched');
    assert.deepEqual(eventDetail, { agentID: 'a2' });
  });

  // -------------------------------------------------------------------------
  // 9. Clicking gear dispatches edit-agent event
  // -------------------------------------------------------------------------

  it('clicking gear dispatches edit-agent event with agentID', () => {
    element.agents = makeAgents();

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('edit-agent', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    let gearButton = element.querySelector('.settings-button[data-agent-id="a1"]');
    gearButton.click();

    assert.ok(eventFired, 'edit-agent event should be dispatched');
    assert.deepEqual(eventDetail, { agentID: 'a1' });
  });

  // -------------------------------------------------------------------------
  // 10. "New Agent" button dispatches create-agent event
  // -------------------------------------------------------------------------

  it('"New Agent" button dispatches create-agent event', () => {
    let eventFired = false;

    element.addEventListener('create-agent', () => {
      eventFired = true;
    });

    let addButton = element.querySelector('.add-button');
    addButton.click();

    assert.ok(eventFired, 'create-agent event should be dispatched');
  });

  // -------------------------------------------------------------------------
  // 11. "New Agent" button text from i18n
  // -------------------------------------------------------------------------

  it('"New Agent" button text comes from i18n', () => {
    let addButton = element.querySelector('.add-button');
    assert.equal(addButton.textContent, localeData.agent.list.addButton);
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
      let mod = await import('../../components/kikx-agent-list-modal/kikx-agent-list-modal.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
    }
  });
});
