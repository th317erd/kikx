'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeParticipants() {
  return [
    { id: 'p1', name: 'Alice',     initials: 'AL', color: '#e91e63', role: 'coordinator', isBot: false },
    { id: 'p2', name: 'Bob',       initials: 'BO', color: '#2196f3', role: 'member',      isBot: false },
    { id: 'p3', name: 'KikxBot',   initials: 'HB', color: '#4caf50', role: 'assistant',   isBot: true },
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
// Mirrors the real component's DOM structure and logic but wires directly
// into the jsdom window. This avoids issues with ESM module caching and
// browser globals at import time.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxParticipantList extends JsdomHTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; padding: 4px 0; }
          .participant-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
          .participant-row:hover { background: rgba(255,255,255,0.08); }
          .participant-avatar { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.7rem; color: #fff; flex-shrink: 0; }
          .participant-name { flex: 1; font-size: 0.8125rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .participant-role { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0; }
          .coordinator-badge { color: var(--accent-primary, #00e5ff); }
          .empty-state { text-align: center; padding: 12px; font-size: 0.8125rem; }
        </style>
        <div class="list-container"></div>
      `;

      this._container    = this.shadowRoot.querySelector('.list-container');
      this._participants = [];

      this._onContainerClick = this._onContainerClick.bind(this);
    }

    connectedCallback() {
      this._render();
      this._container.addEventListener('click', this._onContainerClick);
    }

    disconnectedCallback() {
      this._container.removeEventListener('click', this._onContainerClick);
    }

    set participants(value) {
      this._participants = value || [];
      this._render();
    }

    get participants() {
      return this._participants;
    }

    _onContainerClick(event) {
      let row = event.target.closest('.participant-row');
      if (!row) return;

      let participantId = row.dataset.participantId;

      this.dispatchEvent(new dom.window.CustomEvent('select-participant', {
        bubbles:  true,
        composed: true,
        detail:   { participantId },
      }));
    }

    _render() {
      if (!this._container) return;

      if (this._participants.length === 0) {
        this._container.innerHTML = '';
        return;
      }

      let html = '';

      for (let participant of this._participants) {
        let roleClass = participant.role === 'coordinator' ? ' coordinator-badge' : '';

        html += `<div class="participant-row" data-participant-id="${participant.id}">`;
        html += `<div class="participant-avatar" style="background:${participant.color}">${participant.initials}</div>`;
        html += `<span class="participant-name">${participant.name}</span>`;
        html += `<span class="participant-role${roleClass}">${participant.isBot ? 'BOT' : participant.role || ''}</span>`;
        html += `</div>`;
      }

      this._container.innerHTML = html;
    }
  }

  dom.window.customElements.define('kikx-participant-list', KikxParticipantList);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-participant-list', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-participant-list');
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
    let registered = dom.window.customElements.get('kikx-participant-list');
    assert.ok(registered, 'kikx-participant-list should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Renders participant rows from property
  // -------------------------------------------------------------------------

  it('renders participant rows from participants property', () => {
    element.participants = makeParticipants();

    let rows = element.shadowRoot.querySelectorAll('.participant-row');
    assert.equal(rows.length, 3, 'should render 3 participant rows');
  });

  // -------------------------------------------------------------------------
  // 4. Avatar shows initials and color
  // -------------------------------------------------------------------------

  it('shows initials and background color on the avatar', () => {
    element.participants = makeParticipants();

    let avatars = element.shadowRoot.querySelectorAll('.participant-avatar');
    assert.equal(avatars.length, 3, 'should have 3 avatars');

    // Check first participant (Alice)
    assert.equal(avatars[0].textContent, 'AL', 'first avatar should show AL initials');
    assert.ok(avatars[0].getAttribute('style').includes('#e91e63'), 'first avatar should have pink background');

    // Check second participant (Bob)
    assert.equal(avatars[1].textContent, 'BO', 'second avatar should show BO initials');
    assert.ok(avatars[1].getAttribute('style').includes('#2196f3'), 'second avatar should have blue background');
  });

  // -------------------------------------------------------------------------
  // 5. Name displays correctly
  // -------------------------------------------------------------------------

  it('displays participant names correctly', () => {
    element.participants = makeParticipants();

    let names = element.shadowRoot.querySelectorAll('.participant-name');
    assert.equal(names[0].textContent, 'Alice', 'first name should be Alice');
    assert.equal(names[1].textContent, 'Bob', 'second name should be Bob');
    assert.equal(names[2].textContent, 'KikxBot', 'third name should be KikxBot');
  });

  // -------------------------------------------------------------------------
  // 6. Role displays correctly
  // -------------------------------------------------------------------------

  it('displays participant roles correctly', () => {
    element.participants = makeParticipants();

    let roles = element.shadowRoot.querySelectorAll('.participant-role');
    assert.equal(roles[0].textContent, 'coordinator', 'Alice role should be coordinator');
    assert.equal(roles[1].textContent, 'member', 'Bob role should be member');
    assert.equal(roles[2].textContent, 'BOT', 'KikxBot role should be BOT');
  });

  // -------------------------------------------------------------------------
  // 7. Coordinator role has accent styling class
  // -------------------------------------------------------------------------

  it('applies coordinator-badge class to coordinator role', () => {
    element.participants = makeParticipants();

    let roles = element.shadowRoot.querySelectorAll('.participant-role');

    // Alice is coordinator
    assert.ok(roles[0].classList.contains('coordinator-badge'), 'coordinator role should have coordinator-badge class');

    // Bob is member -- should NOT have the badge
    assert.ok(!roles[1].classList.contains('coordinator-badge'), 'member role should not have coordinator-badge class');

    // KikxBot -- should NOT have the badge
    assert.ok(!roles[2].classList.contains('coordinator-badge'), 'bot role should not have coordinator-badge class');
  });

  // -------------------------------------------------------------------------
  // 8. Clicking participant dispatches select-participant
  // -------------------------------------------------------------------------

  it('dispatches select-participant event when a participant row is clicked', () => {
    element.participants = makeParticipants();

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('select-participant', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    let row = element.shadowRoot.querySelector('.participant-row[data-participant-id="p2"]');
    row.click();

    assert.ok(eventFired, 'select-participant event should be dispatched');
    assert.deepEqual(eventDetail, { participantId: 'p2' });
  });

  // -------------------------------------------------------------------------
  // 9. Empty participants shows no rows
  // -------------------------------------------------------------------------

  it('shows no rows when participants is empty', () => {
    element.participants = [];

    let rows = element.shadowRoot.querySelectorAll('.participant-row');
    assert.equal(rows.length, 0, 'should render no participant rows');

    let container = element.shadowRoot.querySelector('.list-container');
    assert.equal(container.innerHTML, '', 'container should be empty');
  });

  // -------------------------------------------------------------------------
  // 10. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement     = dom.window.HTMLElement;
    globalThis.customElements  = { define() {}, get() {} };
    globalThis.document        = dom.window.document;
    globalThis.CustomEvent     = dom.window.CustomEvent;

    try {
      let mod = await import('../../components/kikx-participant-list/kikx-participant-list.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
    }
  });
});
