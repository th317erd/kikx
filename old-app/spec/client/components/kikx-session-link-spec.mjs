'use strict';

// =============================================================================
// Unit tests for <kikx-session-link> WebComponent
// =============================================================================

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createElement,
  connectElement,
  disconnectElement,
  clearBody,
} from '../helpers/jsdom-setup.mjs';

before(async () => {
  await import('../../../src/client/components/kikx-session-link/kikx-session-link.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement(attrs = {}) {
  let el = createElement('kikx-session-link');

  for (let [key, value] of Object.entries(attrs))
    el.setAttribute(key, value);

  return el;
}

// =============================================================================
// 1. Rendering
// =============================================================================

describe('kikx-session-link — rendering', { timeout: 5000 }, () => {
  it('renders link-card, link-title, and link-meta on connect', () => {
    let el = connectElement(makeElement());
    assert.ok(el.querySelector('.link-card'));
    assert.ok(el.querySelector('.link-title'));
    assert.ok(el.querySelector('.link-meta'));
  });

  it('displays session-title attribute as title', () => {
    let el = connectElement(makeElement({ 'session-title': 'My Session' }));
    assert.equal(el.querySelector('.link-title').textContent, 'My Session');
  });

  it('defaults title to "Sub-session" when no session-title', () => {
    let el = connectElement(makeElement());
    assert.equal(el.querySelector('.link-title').textContent, 'Sub-session');
  });

  it('shows participant count with correct pluralization (singular)', () => {
    let el = connectElement(makeElement({ 'participant-count': '1' }));
    assert.equal(el.querySelector('.link-meta').textContent, '1 participant');
  });

  it('shows participant count with correct pluralization (plural)', () => {
    let el = connectElement(makeElement({ 'participant-count': '5' }));
    assert.equal(el.querySelector('.link-meta').textContent, '5 participants');
  });

  it('shows "Session" when participant-count is 0 or absent', () => {
    let el = connectElement(makeElement());
    assert.equal(el.querySelector('.link-meta').textContent, 'Session');

    let el2 = connectElement(makeElement({ 'participant-count': '0' }));
    assert.equal(el2.querySelector('.link-meta').textContent, 'Session');
  });
});

// =============================================================================
// 2. Events
// =============================================================================

describe('kikx-session-link — events', { timeout: 5000 }, () => {
  it('dispatches select-session event on card click with target session ID', () => {
    let el = connectElement(makeElement({ 'target-session-id': 'sess-42' }));
    let received = null;
    el.addEventListener('select-session', (e) => { received = e.detail; });

    el.querySelector('.link-card').click();

    assert.ok(received);
    assert.equal(received.id, 'sess-42');
  });

  it('does not dispatch event when target-session-id is absent', () => {
    let el = connectElement(makeElement());
    let dispatched = false;
    el.addEventListener('select-session', () => { dispatched = true; });

    el.querySelector('.link-card').click();
    assert.equal(dispatched, false);
  });

  it('event bubbles and is composed', () => {
    let el = connectElement(makeElement({ 'target-session-id': 'sess-1' }));
    let event = null;
    document.body.addEventListener('select-session', (e) => { event = e; });

    el.querySelector('.link-card').click();

    assert.ok(event);
    assert.equal(event.bubbles, true);
    assert.equal(event.composed, true);
  });
});

// =============================================================================
// 3. Attribute changes
// =============================================================================

describe('kikx-session-link — attribute changes', { timeout: 5000 }, () => {
  it('re-renders when session-title changes after connect', () => {
    let el = connectElement(makeElement({ 'session-title': 'Old' }));
    el.setAttribute('session-title', 'New');
    assert.equal(el.querySelector('.link-title').textContent, 'New');
  });

  it('re-renders when participant-count changes after connect', () => {
    let el = connectElement(makeElement({ 'participant-count': '1' }));
    el.setAttribute('participant-count', '3');
    assert.equal(el.querySelector('.link-meta').textContent, '3 participants');
  });
});

// =============================================================================
// 4. Edge cases
// =============================================================================

describe('kikx-session-link — edge cases', { timeout: 5000 }, () => {
  it('disconnect removes click listener without error', () => {
    let el = connectElement(makeElement({ 'target-session-id': 'sess-1' }));
    disconnectElement(el);
    assert.ok(true);
  });

  it('stores target-session-id in attribute', () => {
    let el = makeElement({ 'target-session-id': 'sess-99' });
    assert.equal(el.getAttribute('target-session-id'), 'sess-99');
  });
});
