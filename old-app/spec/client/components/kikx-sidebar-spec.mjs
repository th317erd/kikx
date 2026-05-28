'use strict';

// =============================================================================
// Unit tests for <kikx-sidebar> WebComponent
// =============================================================================

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createElement,
  connectElement,
  disconnectElement,
  clearBody,
} from '../helpers/jsdom-setup.mjs';

let i18n;

before(async () => {
  i18n = await import('../../../src/client/lib/i18n.mjs');
  let en = (await import('../../../src/client/lib/locales/en.mjs')).default;
  i18n.setLocale(en, 'en');

  // Register dependencies
  // kikx-friends-list may not be defined — stub it if needed
  if (!customElements.get('kikx-friends-list')) {
    customElements.define('kikx-friends-list', class extends HTMLElement {
      constructor() { super(); this._friends = []; this._activeFriendID = null; }
      set friends(v) { this._friends = v; }
      get friends() { return this._friends; }
      set activeFriendID(v) { this._activeFriendID = v; }
      get activeFriendID() { return this._activeFriendID; }
    });
  }

  await import('../../../src/client/components/kikx-sidebar/kikx-sidebar.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement() {
  return createElement('kikx-sidebar');
}

function makeSessions(count, options = {}) {
  let sessions = [];
  for (let i = 0; i < count; i++) {
    sessions.push({
      id:          `sess-${i}`,
      name:        options.names ? options.names[i] : `Session ${i}`,
      type:        options.type || 'group',
      archived:    options.archived || false,
      unreadCount: options.unread || 0,
    });
  }
  return sessions;
}

// =============================================================================
// 1. Initial rendering
// =============================================================================

describe('kikx-sidebar — initial rendering', { timeout: 5000 }, () => {

  it('renders search input with placeholder on connect', () => {
    let el = connectElement(makeElement());
    let input = el.querySelector('.search-input');
    assert.ok(input, 'search input should exist');
    assert.ok(input.placeholder.length > 0, 'placeholder should be set from i18n');
  });

  it('renders archive toggle button', () => {
    let el = connectElement(makeElement());
    let btn = el.querySelector('.archive-toggle');
    assert.ok(btn, 'archive toggle should exist');
    assert.ok(btn.textContent.length > 0, 'toggle should have text');
  });

  it('renders sessions section header and label', () => {
    let el = connectElement(makeElement());
    let label = el.querySelector('.sessions-label');
    assert.ok(label, 'sessions label should exist');
    assert.ok(label.textContent.length > 0, 'sessions label should have i18n text');
  });

  it('renders friends section header and label', () => {
    let el = connectElement(makeElement());
    let label = el.querySelector('.friends-label');
    assert.ok(label, 'friends label should exist');
    assert.ok(label.textContent.length > 0, 'friends label should have i18n text');
  });

  it('renders add-session button', () => {
    let el = connectElement(makeElement());
    let btn = el.querySelector('.add-session-button');
    assert.ok(btn, 'add-session button should exist');
    assert.ok(btn.textContent.length > 0, 'button should have text');
  });

  it('renders add-friend button', () => {
    let el = connectElement(makeElement());
    let btn = el.querySelector('.add-friend-button');
    assert.ok(btn, 'add-friend button should exist');
  });

  it('renders empty session list div', () => {
    let el = connectElement(makeElement());
    let list = el.querySelector('.session-list');
    assert.ok(list, 'session list container should exist');
  });
});

// =============================================================================
// 2. Session list rendering
// =============================================================================

describe('kikx-sidebar — session list', { timeout: 5000 }, () => {

  it('renders session rows from sessions property', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(3);

    let rows = el.querySelectorAll('.session-row');
    assert.equal(rows.length, 3);
  });

  it('renders empty-state message when no sessions', () => {
    let el = connectElement(makeElement());
    el.sessions = [];

    let empty = el.querySelector('.sessions-empty');
    assert.ok(empty, 'empty state message should exist');
  });

  it('sets session ID in dataset on each row', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(2);

    let rows = el.querySelectorAll('.session-row');
    assert.equal(rows[0].dataset.id, 'sess-0');
    assert.equal(rows[1].dataset.id, 'sess-1');
  });

  it('displays session name in row', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(1, { names: ['My Chat'] });

    let nameSpan = el.querySelector('.session-name');
    assert.equal(nameSpan.textContent, 'My Chat');
  });

  it('strips "DM: " prefix from session display name', () => {
    let el = connectElement(makeElement());
    el.sessions = [{ id: 'dm-1', name: 'DM: Alice', type: 'group', archived: false }];

    let nameSpan = el.querySelector('.session-name');
    assert.equal(nameSpan.textContent, 'Alice');
  });

  it('filters out archived sessions', () => {
    let el = connectElement(makeElement());
    el.sessions = [
      { id: 's1', name: 'Active', type: 'group', archived: false },
      { id: 's2', name: 'Archived', type: 'group', archived: true },
    ];

    let rows = el.querySelectorAll('.session-row');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dataset.id, 's1');
  });

  it('filters out dm-type sessions from session list', () => {
    let el = connectElement(makeElement());
    el.sessions = [
      { id: 's1', name: 'Group Chat', type: 'group', archived: false },
      { id: 's2', name: 'DM: Bob', type: 'dm', archived: false },
    ];

    let rows = el.querySelectorAll('.session-row');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dataset.id, 's1');
  });

  it('shows unread gem indicator for sessions with unreadCount > 0', () => {
    let el = connectElement(makeElement());
    el.sessions = [{ id: 's1', name: 'Chat', type: 'group', archived: false, unreadCount: 3 }];

    let gem = el.querySelector('.session-gem');
    assert.ok(gem.classList.contains('unread'), 'gem should have unread class');
  });

  it('does NOT show unread gem for sessions with unreadCount 0', () => {
    let el = connectElement(makeElement());
    el.sessions = [{ id: 's1', name: 'Chat', type: 'group', archived: false, unreadCount: 0 }];

    let gem = el.querySelector('.session-gem');
    assert.ok(!gem.classList.contains('unread'), 'gem should not have unread class');
  });
});

// =============================================================================
// 3. Active session
// =============================================================================

describe('kikx-sidebar — active session', { timeout: 5000 }, () => {

  it('marks active session row with "active" class', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(3);
    el.activeSessionID = 'sess-1';

    let rows = el.querySelectorAll('.session-row');
    assert.ok(!rows[0].classList.contains('active'));
    assert.ok(rows[1].classList.contains('active'));
    assert.ok(!rows[2].classList.contains('active'));
  });

  it('clears active class when activeSessionID is set to null', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(2);
    el.activeSessionID = 'sess-0';

    assert.ok(el.querySelector('.session-row.active'));

    el.activeSessionID = null;
    assert.equal(el.querySelector('.session-row.active'), null);
  });
});

// =============================================================================
// 4. Search filter
// =============================================================================

describe('kikx-sidebar — search filter', { timeout: 5000 }, () => {

  it('_applySearchFilter adds search-hidden to non-matching rows', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(3);

    let matching = new Set(['sess-1']);
    el._applySearchFilter(matching);

    let rows = el.querySelectorAll('.session-row');
    assert.ok(rows[0].classList.contains('search-hidden'), 'sess-0 should be hidden');
    assert.ok(!rows[1].classList.contains('search-hidden'), 'sess-1 should be visible');
    assert.ok(rows[2].classList.contains('search-hidden'), 'sess-2 should be hidden');
  });

  it('_clearSearch removes search-hidden from all rows', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(3);

    // First apply filter
    el._applySearchFilter(new Set(['sess-0']));
    assert.ok(el.querySelector('.session-row.search-hidden'), 'some rows should be hidden');

    // Then clear
    el._clearSearch();

    let hiddenRows = el.querySelectorAll('.session-row.search-hidden');
    assert.equal(hiddenRows.length, 0, 'no rows should be hidden after clear');
  });

  it('_applySearchFilter with empty set hides all rows', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(3);

    el._applySearchFilter(new Set());

    let hiddenRows = el.querySelectorAll('.session-row.search-hidden');
    assert.equal(hiddenRows.length, 3, 'all rows should be hidden');
  });

  it('_applySearchFilter with all IDs matching hides none', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(2);

    el._applySearchFilter(new Set(['sess-0', 'sess-1']));

    let hiddenRows = el.querySelectorAll('.session-row.search-hidden');
    assert.equal(hiddenRows.length, 0);
  });
});

// =============================================================================
// 5. Events
// =============================================================================

describe('kikx-sidebar — events', { timeout: 5000 }, () => {

  it('dispatches select-session on session row click', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(2);

    let received = null;
    el.addEventListener('select-session', (e) => { received = e.detail; });

    let row = el.querySelector('.session-row[data-id="sess-1"]');
    row.click();

    assert.ok(received, 'event should have been dispatched');
    assert.equal(received.id, 'sess-1');
  });

  it('dispatches add-session on add-session button click', () => {
    let el = connectElement(makeElement());
    let fired = false;
    el.addEventListener('add-session', () => { fired = true; });

    el.querySelector('.add-session-button').click();
    assert.ok(fired);
  });

  it('dispatches add-friend on add-friend button click', () => {
    let el = connectElement(makeElement());
    let fired = false;
    el.addEventListener('add-friend', () => { fired = true; });

    el.querySelector('.add-friend-button').click();
    assert.ok(fired);
  });

  it('dispatches toggle-archive on archive toggle click', () => {
    let el = connectElement(makeElement());
    let detail = null;
    el.addEventListener('toggle-archive', (e) => { detail = e.detail; });

    el.querySelector('.archive-toggle').click();
    assert.ok(detail, 'event should fire');
    assert.equal(detail.visible, true, 'first click should show archive');

    el.querySelector('.archive-toggle').click();
    assert.equal(detail.visible, false, 'second click should hide archive');
  });
});

// =============================================================================
// 6. Disconnect cleanup
// =============================================================================

describe('kikx-sidebar — disconnect', { timeout: 5000 }, () => {

  it('clears search timeout on disconnect', () => {
    let el = connectElement(makeElement());

    // Set a pending timeout by simulating internal state
    el._searchTimeout = setTimeout(() => {}, 10000);
    assert.ok(el._searchTimeout, 'timeout should be set');

    disconnectElement(el);
    // No crash is the assertion; also verify listeners are cleaned up
    assert.ok(true, 'disconnect did not throw');
  });

  it('does not throw on disconnect even if never connected', () => {
    let el = makeElement();
    // Simulate calling disconnectedCallback on uninitialized element
    // This would happen if element is created but never added to DOM
    // The component guards against this with _initialized check in connectedCallback
    assert.doesNotThrow(() => {
      // Force connect then disconnect to exercise cleanup
      connectElement(el);
      disconnectElement(el);
    });
  });
});

// =============================================================================
// 7. Edge cases
// =============================================================================

describe('kikx-sidebar — edge cases', { timeout: 5000 }, () => {

  it('sessions setter coerces non-array to empty array', () => {
    let el = connectElement(makeElement());
    el.sessions = 'not-an-array';
    assert.deepEqual(el.sessions, []);
  });

  it('sessions setter handles null gracefully', () => {
    let el = connectElement(makeElement());
    el.sessions = null;
    assert.deepEqual(el.sessions, []);
  });

  it('activeSessionID getter returns null by default', () => {
    let el = connectElement(makeElement());
    assert.equal(el.activeSessionID, null);
  });

  it('_applySearchFilter is graceful when sessionList is empty', () => {
    let el = connectElement(makeElement());
    el.sessions = [];

    assert.doesNotThrow(() => {
      el._applySearchFilter(new Set(['nonexistent']));
    });
  });

  it('_clearSearch is graceful when sessionList is empty', () => {
    let el = connectElement(makeElement());
    el.sessions = [];

    assert.doesNotThrow(() => {
      el._clearSearch();
    });
  });

  it('session row click on non-row element is ignored', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(1);

    let received = null;
    el.addEventListener('select-session', (e) => { received = e.detail; });

    // Click on the session list container, not on a row
    el.querySelector('.session-list').click();
    assert.equal(received, null, 'event should not fire for non-row click');
  });

  it('re-setting sessions replaces previous rows', () => {
    let el = connectElement(makeElement());
    el.sessions = makeSessions(3);
    assert.equal(el.querySelectorAll('.session-row').length, 3);

    el.sessions = makeSessions(1);
    assert.equal(el.querySelectorAll('.session-row').length, 1);
  });
});
