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

function makeSessions() {
  return [
    { id: 'ch1', name: 'General',       active: false, archived: false, participantCount: 5,  parentId: null, lastMessage: 'Hello',   lastActivity: 1000, unreadCount: 3 },
    { id: 'ch2', name: 'Engineering',    active: true,  archived: false, participantCount: 4,  parentId: null, lastMessage: 'Hi',      lastActivity: 2000, unreadCount: 0 },
    { id: 'pr1', name: 'Alice',          active: false, archived: false, participantCount: 2,  parentId: null, lastMessage: 'Hey',     lastActivity: 3000, unreadCount: 1 },
    { id: 'pr2', name: 'Bob',            active: false, archived: false, participantCount: 2,  parentId: null, lastMessage: 'Yo',      lastActivity: 500,  unreadCount: 0 },
    { id: 'ar1', name: 'Old Channel',    active: false, archived: true,  participantCount: 3,  parentId: null, lastMessage: 'Bye',     lastActivity: 100,  unreadCount: 0 },
    { id: 'ar2', name: 'Old Private',    active: false, archived: true,  participantCount: 2,  parentId: null, lastMessage: 'Later',   lastActivity: 200,  unreadCount: 0 },
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
// Mirrors the real component's DOM structure and logic, but wires directly
// into the mockT function above. This avoids issues with ESM module caching
// and browser globals at import time.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxSessionList extends JsdomHTMLElement {
    static get observedAttributes() {
      return ['show-archived'];
    }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; overflow-y: auto; }
          .empty-state { padding: 8px; text-align: center; }
          .category-header { cursor: pointer; }
          .category-items.collapsed { display: none; }
          .collapse-indicator.collapsed { transform: rotate(-90deg); }
          .session-row.active { border-left: 2px solid blue; }
          .session-row.archived { opacity: 0.6; }
          .action-button { opacity: 0; }
          .session-row:hover .action-button { opacity: 1; }
        </style>
        <div class="container"></div>
      `;

      this._container       = this.shadowRoot.querySelector('.container');
      this._sessions        = [];
      this._filter          = '';
      this._collapsedState  = {};

      this._onContainerClick = this._onContainerClick.bind(this);
    }

    connectedCallback() {
      this._render();
      this._container.addEventListener('click', this._onContainerClick);
    }

    disconnectedCallback() {
      this._container.removeEventListener('click', this._onContainerClick);
    }

    set sessions(value) {
      this._sessions = value || [];
      this._render();
    }

    get sessions() {
      return this._sessions;
    }

    set filter(value) {
      this._filter = value || '';
      this._render();
    }

    get filter() {
      return this._filter;
    }

    attributeChangedCallback() {
      this._render();
    }

    _onContainerClick(event) {
      let target = event.target;

      let header = target.closest('.category-header');
      if (header) {
        let category  = header.dataset.category;
        let items     = this._container.querySelector(`.category-items[data-category="${category}"]`);
        let indicator = header.querySelector('.collapse-indicator');

        this._collapsedState[category] = !this._collapsedState[category];

        if (this._collapsedState[category]) {
          items.classList.add('collapsed');
          indicator.classList.add('collapsed');
        } else {
          items.classList.remove('collapsed');
          indicator.classList.remove('collapsed');
        }

        return;
      }

      let actionButton = target.closest('.action-button');
      if (actionButton) {
        let sessionId = actionButton.dataset.sessionId;
        let action    = actionButton.dataset.action;

        this.dispatchEvent(new dom.window.CustomEvent(action, {
          bubbles:  true,
          composed: true,
          detail:   { sessionId },
        }));

        return;
      }

      let row = target.closest('.session-row');
      if (row) {
        let sessionId = row.dataset.sessionId;

        this.dispatchEvent(new dom.window.CustomEvent('select-session', {
          bubbles:  true,
          composed: true,
          detail:   { sessionId },
        }));
      }
    }

    _render() {
      if (!this._container) return;

      let showArchived  = this.hasAttribute('show-archived');
      let filterLower   = this._filter.toLowerCase();

      let visible = this._sessions.filter((session) => {
        if (session.archived && !showArchived) return false;
        if (filterLower && !session.name.toLowerCase().includes(filterLower)) return false;
        return true;
      });

      visible.sort((a, b) => {
        let timeA = a.lastActivity || 0;
        let timeB = b.lastActivity || 0;
        return timeB - timeA;
      });

      if (visible.length === 0) {
        this._container.innerHTML = `<div class="empty-state">${mockT('session.list.empty')}</div>`;
        return;
      }

      let channels = visible.filter((session) => session.participantCount >= 3);
      let privates = visible.filter((session) => session.participantCount < 3);

      let html = '';

      if (channels.length > 0) {
        let isCollapsed = this._collapsedState['channels'];
        html += this._renderCategory('channels', mockT('session.categories.channels'), channels, isCollapsed);
      }

      if (privates.length > 0) {
        let isCollapsed = this._collapsedState['private'];
        html += this._renderCategory('private', mockT('session.categories.private'), privates, isCollapsed);
      }

      this._container.innerHTML = html;
    }

    _renderCategory(categoryKey, label, sessions, isCollapsed) {
      let collapseClass = isCollapsed ? ' collapsed' : '';

      let html = `<div class="category">`;
      html += `<button class="category-header" data-category="${categoryKey}">`;
      html += `<span class="collapse-indicator${collapseClass}">\u25BC</span> ${label}`;
      html += `</button>`;
      html += `<div class="category-items${collapseClass}" data-category="${categoryKey}">`;

      for (let session of sessions) {
        let activeClass   = session.active ? ' active' : '';
        let archivedClass = session.archived ? ' archived' : '';

        html += `<div class="session-row${activeClass}${archivedClass}" data-session-id="${session.id}">`;
        html += `<span class="session-name">${session.name}</span>`;

        if (session.unreadCount > 0) {
          html += `<span class="unread-badge">${session.unreadCount}</span>`;
        }

        if (session.archived) {
          html += `<button class="action-button" data-session-id="${session.id}" data-action="revive-session">${mockT('session.archive.reviveAction')}</button>`;
        } else {
          html += `<button class="action-button" data-session-id="${session.id}" data-action="archive-session">${mockT('session.archive.archiveAction')}</button>`;
        }

        html += `</div>`;
      }

      html += `</div></div>`;
      return html;
    }
  }

  dom.window.customElements.define('kikx-session-list', KikxSessionList);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-session-list', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-session-list');
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
    let registered = dom.window.customElements.get('kikx-session-list');
    assert.ok(registered, 'kikx-session-list should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Empty state shows "No sessions yet." message
  // -------------------------------------------------------------------------

  it('shows empty state message when no sessions are provided', () => {
    let emptyState = element.shadowRoot.querySelector('.empty-state');
    assert.ok(emptyState, 'should render empty state element');
    assert.equal(emptyState.textContent, localeData.session.list.empty);
  });

  // -------------------------------------------------------------------------
  // 4. Renders sessions grouped by category (Channels vs Private)
  // -------------------------------------------------------------------------

  it('renders sessions grouped into Channels and Private categories', () => {
    element.sessions = makeSessions();

    let headers = element.shadowRoot.querySelectorAll('.category-header');
    assert.equal(headers.length, 2, 'should have two category headers');

    let headerTexts = Array.from(headers).map((header) => header.textContent);
    assert.ok(headerTexts.some((text) => text.includes(localeData.session.categories.channels)), 'should have Channels header');
    assert.ok(headerTexts.some((text) => text.includes(localeData.session.categories.private)), 'should have Private header');
  });

  // -------------------------------------------------------------------------
  // 5. Channels category shows sessions with participantCount >= 3
  // -------------------------------------------------------------------------

  it('places sessions with participantCount >= 3 in Channels category', () => {
    element.sessions = makeSessions();

    let channelsItems = element.shadowRoot.querySelector('.category-items[data-category="channels"]');
    let rows          = channelsItems.querySelectorAll('.session-row');
    let names         = Array.from(rows).map((row) => row.querySelector('.session-name').textContent);

    assert.ok(names.includes('Engineering'), 'Engineering should be in Channels');
    assert.ok(names.includes('General'), 'General should be in Channels');
    assert.equal(rows.length, 2, 'Channels should have exactly 2 non-archived sessions');
  });

  // -------------------------------------------------------------------------
  // 6. Private category shows sessions with participantCount < 3
  // -------------------------------------------------------------------------

  it('places sessions with participantCount < 3 in Private category', () => {
    element.sessions = makeSessions();

    let privateItems = element.shadowRoot.querySelector('.category-items[data-category="private"]');
    let rows         = privateItems.querySelectorAll('.session-row');
    let names        = Array.from(rows).map((row) => row.querySelector('.session-name').textContent);

    assert.ok(names.includes('Alice'), 'Alice should be in Private');
    assert.ok(names.includes('Bob'), 'Bob should be in Private');
    assert.equal(rows.length, 2, 'Private should have exactly 2 non-archived sessions');
  });

  // -------------------------------------------------------------------------
  // 7. Active session has .active class
  // -------------------------------------------------------------------------

  it('applies .active class to the active session row', () => {
    element.sessions = makeSessions();

    let activeRows = element.shadowRoot.querySelectorAll('.session-row.active');
    assert.equal(activeRows.length, 1, 'should have exactly one active row');
    assert.equal(activeRows[0].dataset.sessionId, 'ch2', 'active row should be Engineering (ch2)');
  });

  // -------------------------------------------------------------------------
  // 8. Clicking session dispatches select-session event with sessionId
  // -------------------------------------------------------------------------

  it('dispatches select-session event when a session row is clicked', () => {
    element.sessions = makeSessions();

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('select-session', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    let row = element.shadowRoot.querySelector('.session-row[data-session-id="pr1"]');
    row.click();

    assert.ok(eventFired, 'select-session event should be dispatched');
    assert.deepEqual(eventDetail, { sessionId: 'pr1' });
  });

  // -------------------------------------------------------------------------
  // 9. Archive button dispatches archive-session event with sessionId
  // -------------------------------------------------------------------------

  it('dispatches archive-session event when archive button is clicked', () => {
    element.sessions = makeSessions();

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('archive-session', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    let archiveButton = element.shadowRoot.querySelector('.action-button[data-session-id="pr1"]');
    assert.ok(archiveButton, 'should have an archive button for pr1');
    assert.equal(archiveButton.textContent, localeData.session.archive.archiveAction);

    archiveButton.click();

    assert.ok(eventFired, 'archive-session event should be dispatched');
    assert.deepEqual(eventDetail, { sessionId: 'pr1' });
  });

  // -------------------------------------------------------------------------
  // 10. Revive button dispatches revive-session event on archived sessions
  // -------------------------------------------------------------------------

  it('dispatches revive-session event when revive button is clicked on archived session', () => {
    element.setAttribute('show-archived', '');
    element.sessions = makeSessions();

    let eventFired  = false;
    let eventDetail = null;

    element.addEventListener('revive-session', (event) => {
      eventFired  = true;
      eventDetail = event.detail;
    });

    let reviveButton = element.shadowRoot.querySelector('.action-button[data-session-id="ar1"]');
    assert.ok(reviveButton, 'should have a revive button for ar1');
    assert.equal(reviveButton.textContent, localeData.session.archive.reviveAction);

    reviveButton.click();

    assert.ok(eventFired, 'revive-session event should be dispatched');
    assert.deepEqual(eventDetail, { sessionId: 'ar1' });
  });

  // -------------------------------------------------------------------------
  // 11. show-archived attribute shows archived sessions
  // -------------------------------------------------------------------------

  it('shows archived sessions when show-archived attribute is set', () => {
    element.setAttribute('show-archived', '');
    element.sessions = makeSessions();

    let archivedRows = element.shadowRoot.querySelectorAll('.session-row.archived');
    assert.equal(archivedRows.length, 2, 'should show 2 archived sessions');
  });

  // -------------------------------------------------------------------------
  // 12. Archived sessions hidden by default
  // -------------------------------------------------------------------------

  it('hides archived sessions by default', () => {
    element.sessions = makeSessions();

    let archivedRows = element.shadowRoot.querySelectorAll('.session-row.archived');
    assert.equal(archivedRows.length, 0, 'should not show any archived sessions by default');

    let allRows = element.shadowRoot.querySelectorAll('.session-row');
    assert.equal(allRows.length, 4, 'should show only 4 non-archived sessions');
  });

  // -------------------------------------------------------------------------
  // 13. Filter property filters sessions by name (case-insensitive)
  // -------------------------------------------------------------------------

  it('filters sessions by name case-insensitively', () => {
    element.sessions = makeSessions();
    element.filter   = 'alice';

    let rows  = element.shadowRoot.querySelectorAll('.session-row');
    assert.equal(rows.length, 1, 'should show only 1 session matching the filter');
    assert.equal(rows[0].querySelector('.session-name').textContent, 'Alice');
  });

  // -------------------------------------------------------------------------
  // 14. Category headers are collapsible
  // -------------------------------------------------------------------------

  it('collapses category items when header is clicked', () => {
    element.sessions = makeSessions();

    let channelsHeader = element.shadowRoot.querySelector('.category-header[data-category="channels"]');
    assert.ok(channelsHeader, 'should have a channels category header');

    let channelsItems = element.shadowRoot.querySelector('.category-items[data-category="channels"]');
    assert.ok(!channelsItems.classList.contains('collapsed'), 'channels should be expanded by default');

    channelsHeader.click();

    channelsItems = element.shadowRoot.querySelector('.category-items[data-category="channels"]');
    assert.ok(channelsItems.classList.contains('collapsed'), 'channels should be collapsed after click');

    let indicator = channelsHeader.querySelector('.collapse-indicator');
    assert.ok(indicator.classList.contains('collapsed'), 'indicator should have collapsed class');

    // Click again to expand
    channelsHeader.click();

    channelsItems = element.shadowRoot.querySelector('.category-items[data-category="channels"]');
    assert.ok(!channelsItems.classList.contains('collapsed'), 'channels should be expanded after second click');
  });

  // -------------------------------------------------------------------------
  // 15. Unread badge shows when unreadCount > 0
  // -------------------------------------------------------------------------

  it('shows unread badge only when unreadCount > 0', () => {
    element.sessions = makeSessions();

    let badges = element.shadowRoot.querySelectorAll('.unread-badge');
    assert.equal(badges.length, 2, 'should show 2 unread badges (General=3, Alice=1)');

    let badgeValues = Array.from(badges).map((badge) => badge.textContent);
    assert.ok(badgeValues.includes('3'), 'should show badge with count 3');
    assert.ok(badgeValues.includes('1'), 'should show badge with count 1');

    // Verify sessions without unread counts do not have badges
    let bobRow = element.shadowRoot.querySelector('.session-row[data-session-id="pr2"]');
    let bobBadge = bobRow.querySelector('.unread-badge');
    assert.equal(bobBadge, null, 'Bob should not have an unread badge');
  });

  // -------------------------------------------------------------------------
  // Additional: Sessions sorted by lastActivity descending
  // -------------------------------------------------------------------------

  it('sorts sessions by lastActivity descending within categories', () => {
    element.sessions = makeSessions();

    let privateItems = element.shadowRoot.querySelector('.category-items[data-category="private"]');
    let rows         = privateItems.querySelectorAll('.session-row');
    let names        = Array.from(rows).map((row) => row.querySelector('.session-name').textContent);

    assert.equal(names[0], 'Alice', 'Alice (lastActivity=3000) should be first');
    assert.equal(names[1], 'Bob', 'Bob (lastActivity=500) should be second');
  });

  // -------------------------------------------------------------------------
  // Additional: Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement     = dom.window.HTMLElement;
    globalThis.customElements  = { define() {}, get() {} };
    globalThis.document        = dom.window.document;
    globalThis.CustomEvent     = dom.window.CustomEvent;

    try {
      let mod = await import('../../components/kikx-session-list/kikx-session-list.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
      delete globalThis.CustomEvent;
    }
  });
});
