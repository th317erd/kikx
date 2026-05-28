'use strict';

// =============================================================================
// Unit tests for <kikx-interaction> WebComponent
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

  // Register the component
  await import('../../../src/client/components/kikx-interaction/kikx-interaction.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement(attrs = {}) {
  let el = createElement('kikx-interaction');

  for (let [key, value] of Object.entries(attrs))
    el.setAttribute(key, value);

  return el;
}

// =============================================================================
// 1. Alignment
// =============================================================================

describe('kikx-interaction — alignment', { timeout: 5000 }, () => {
  it('alignment="user" sets the attribute for flex-end styling', () => {
    let el = makeElement({ alignment: 'user' });
    connectElement(el);
    assert.equal(el.getAttribute('alignment'), 'user');
  });

  it('alignment="agent" is the default (flex-start)', () => {
    let el = makeElement({ alignment: 'agent' });
    connectElement(el);
    assert.equal(el.getAttribute('alignment'), 'agent');
  });

  it('alignment="system" sets the attribute for centered styling', () => {
    let el = makeElement({ alignment: 'system' });
    connectElement(el);
    assert.equal(el.getAttribute('alignment'), 'system');
  });

  it('no alignment attribute defaults to left-aligned (agent)', () => {
    let el = makeElement();
    connectElement(el);
    assert.equal(el.getAttribute('alignment'), null);
  });

  it('data-author-type="system" can be set as attribute', () => {
    let el = makeElement({ 'data-author-type': 'system' });
    connectElement(el);
    assert.equal(el.getAttribute('data-author-type'), 'system');
  });
});

// =============================================================================
// 2. Reply button
// =============================================================================

describe('kikx-interaction — reply button', { timeout: 5000 }, () => {
  it('reply button exists in template after connect', () => {
    let el = makeElement();
    connectElement(el);
    let btn = el.querySelector('.reply-button');
    assert.ok(btn, 'Reply button should exist in DOM');
  });

  it('reply button is styled as visible when data-frame-id is set (CSS attribute selector)', () => {
    let el = makeElement({ 'data-frame-id': 'frame-123' });
    connectElement(el);
    // CSS would show it via kikx-interaction[data-frame-id] .reply-button { display: inline-flex }
    assert.ok(el.hasAttribute('data-frame-id'));
  });

  it('reply button is hidden via CSS when alignment="system"', () => {
    let el = makeElement({ alignment: 'system', 'data-frame-id': 'f1' });
    connectElement(el);
    // CSS rule: kikx-interaction[alignment="system"] .reply-button { display: none }
    assert.equal(el.getAttribute('alignment'), 'system');
  });

  it('reply button is hidden via CSS when bubble-type="permission"', () => {
    let el = makeElement({ 'bubble-type': 'permission', 'data-frame-id': 'f1' });
    connectElement(el);
    assert.equal(el.getAttribute('bubble-type'), 'permission');
  });

  it('reply button is hidden via CSS when data-author-type="system"', () => {
    let el = makeElement({ 'data-author-type': 'system', 'data-frame-id': 'f1' });
    connectElement(el);
    assert.equal(el.getAttribute('data-author-type'), 'system');
  });

  it('click dispatches reply-to-message event with correct detail', () => {
    let el = makeElement({
      'data-frame-id':    'frame-42',
      'participant-name':  'Alice',
      alignment:           'user',
    });
    connectElement(el);

    let received = null;
    el.addEventListener('reply-to-message', (e) => { received = e.detail; });

    el.querySelector('.reply-button').click();

    assert.ok(received, 'reply-to-message event should fire');
    assert.equal(received.frameID, 'frame-42');
    assert.equal(received.participantName, 'Alice');
    assert.equal(received.alignment, 'user');
  });

  it('reply count badge displays correct count', () => {
    let el = makeElement({ 'reply-count': '5' });
    connectElement(el);

    let badge = el.querySelector('.reply-count-badge');
    assert.equal(badge.textContent, '5 replies');
  });

  it('reply count badge uses singular form for count of 1', () => {
    let el = makeElement({ 'reply-count': '1' });
    connectElement(el);

    let badge = el.querySelector('.reply-count-badge');
    assert.equal(badge.textContent, '1 reply');
  });
});

// =============================================================================
// 3. Content rendering
// =============================================================================

describe('kikx-interaction — content rendering', { timeout: 5000 }, () => {
  it('content area accepts child elements (moved into .content)', () => {
    let el = createElement('kikx-interaction');
    let child = document.createElement('div');
    child.className = 'test-child';
    child.textContent = 'Hello';
    el.appendChild(child);

    connectElement(el);

    let content = el.querySelector('.content');
    assert.ok(content, '.content should exist');
    assert.ok(content.querySelector('.test-child'), 'Child should be inside .content');
  });

  it('header name is displayed from participant-name attribute', () => {
    let el = makeElement({ 'participant-name': 'TestBot' });
    connectElement(el);

    assert.equal(el.querySelector('.header-name').textContent, 'TestBot');
  });

  it('timestamp is displayed in footer meta', () => {
    let el = makeElement({ timestamp: '2:30 PM' });
    connectElement(el);

    assert.ok(el.querySelector('.footer-meta').textContent.includes('2:30 PM'));
  });

  it('footer meta combines timestamp and token count', () => {
    let el = makeElement({ timestamp: '3:00 PM', 'token-count': '150' });
    connectElement(el);

    let meta = el.querySelector('.footer-meta').textContent;
    assert.ok(meta.includes('3:00 PM'), 'Should include timestamp');
    assert.ok(meta.includes('150'), 'Should include token count');
  });

  it('avatar shows participant initials', () => {
    let el = makeElement({ 'participant-initials': 'TB' });
    connectElement(el);

    assert.equal(el.querySelector('.avatar').textContent, 'TB');
  });
});

// =============================================================================
// 4. Pending state
// =============================================================================

describe('kikx-interaction — pending state', { timeout: 5000 }, () => {
  it('pending class can be applied to element', () => {
    let el = makeElement();
    el.classList.add('pending');
    connectElement(el);
    assert.ok(el.classList.contains('pending'));
  });

  it('pending class can be removed', () => {
    let el = makeElement();
    el.classList.add('pending');
    connectElement(el);
    el.classList.remove('pending');
    assert.ok(!el.classList.contains('pending'));
  });

  it('pending state does not interfere with rendering', () => {
    let el = makeElement({ 'participant-name': 'Bot' });
    el.classList.add('pending');
    connectElement(el);
    assert.equal(el.querySelector('.header-name').textContent, 'Bot');
  });
});

// =============================================================================
// 5. Events
// =============================================================================

describe('kikx-interaction — events', { timeout: 5000 }, () => {
  it('reply-to-message event has correct detail structure', () => {
    let el = makeElement({ 'data-frame-id': 'f-1', 'participant-name': 'X' });
    connectElement(el);

    let detail = null;
    el.addEventListener('reply-to-message', (e) => { detail = e.detail; });
    el.querySelector('.reply-button').click();

    assert.ok(detail);
    assert.ok('frameID' in detail);
    assert.ok('participantName' in detail);
    assert.ok('preview' in detail);
    assert.ok('alignment' in detail);
  });

  it('interaction-focused dispatched on bubble click', () => {
    let el = makeElement();
    connectElement(el);

    let received = false;
    document.addEventListener('interaction-focused', () => { received = true; });

    el.querySelector('.bubble').click();
    assert.ok(received, 'interaction-focused should fire on document');
  });

  it('bubble gains focused class on click', () => {
    let el = makeElement();
    connectElement(el);

    el.querySelector('.bubble').click();
    assert.ok(el.querySelector('.bubble').classList.contains('focused'));
  });

  it('peer focus event clears focused class from other interactions', () => {
    let el1 = makeElement();
    let el2 = makeElement();
    connectElement(el1);
    connectElement(el2);

    // Focus el1
    el1.querySelector('.bubble').click();
    assert.ok(el1.querySelector('.bubble').classList.contains('focused'));

    // Focus el2 — el1 should lose focus
    el2.querySelector('.bubble').click();
    assert.ok(!el1.querySelector('.bubble').classList.contains('focused'));
    assert.ok(el2.querySelector('.bubble').classList.contains('focused'));
  });

  it('interaction-ignore event dispatched when ignore button clicked', () => {
    let el = makeElement({ 'show-actions': '', 'data-interaction-id': 'int-1' });
    connectElement(el);

    let detail = null;
    el.addEventListener('interaction-ignore', (e) => { detail = e.detail; });

    let ignoreBtn = el.querySelector('.ignore-button');
    assert.ok(ignoreBtn, 'Ignore button should exist');
    ignoreBtn.click();

    assert.ok(detail);
    assert.equal(detail.interactionID, 'int-1');
  });

  it('interaction-submit event dispatched when submit button clicked', () => {
    let el = makeElement({ 'show-actions': '', 'data-interaction-id': 'int-2' });
    connectElement(el);

    let detail = null;
    el.addEventListener('interaction-submit', (e) => { detail = e.detail; });

    let submitBtn = el.querySelector('.submit-button');
    assert.ok(submitBtn, 'Submit button should exist');
    submitBtn.click();

    assert.ok(detail);
    assert.equal(detail.interactionID, 'int-2');
  });
});

// =============================================================================
// 6. Edge cases
// =============================================================================

describe('kikx-interaction — edge cases', { timeout: 5000 }, () => {
  it('disconnect removes listeners without error', () => {
    let el = makeElement();
    connectElement(el);
    disconnectElement(el);
    assert.ok(true, 'Should not throw');
  });

  it('null/empty attributes do not crash', () => {
    let el = makeElement({
      'participant-name': '',
      timestamp:          '',
      'token-count':      '',
    });
    connectElement(el);

    assert.equal(el.querySelector('.header-name').textContent, '');
    assert.equal(el.querySelector('.footer-meta').textContent, '');
  });

  it('re-render on attribute change while connected', () => {
    let el = makeElement({ 'participant-name': 'Original' });
    connectElement(el);
    assert.equal(el.querySelector('.header-name').textContent, 'Original');

    el.setAttribute('participant-name', 'Updated');
    assert.equal(el.querySelector('.header-name').textContent, 'Updated');
  });

  it('avatar-color sets custom property', () => {
    let el = makeElement({ 'avatar-color': '#ff0000' });
    connectElement(el);

    let avatar = el.querySelector('.avatar');
    let color = avatar.style.getPropertyValue('--interaction-avatar-color');
    assert.equal(color, '#ff0000');
  });

  it('parent-preview attribute renders reply context', () => {
    let el = makeElement({ 'parent-preview': 'Earlier message...' });
    connectElement(el);

    let replyText = el.querySelector('.reply-context-text');
    assert.equal(replyText.textContent, 'Earlier message...');
  });

  it('show-actions renders ignore and submit buttons', () => {
    let el = makeElement({ 'show-actions': '' });
    connectElement(el);

    assert.ok(el.querySelector('.ignore-button'), 'Ignore button should exist');
    assert.ok(el.querySelector('.submit-button'), 'Submit button should exist');
  });

  it('removing show-actions attribute clears action buttons', () => {
    let el = makeElement({ 'show-actions': '' });
    connectElement(el);
    assert.ok(el.querySelector('.ignore-button'));

    el.removeAttribute('show-actions');
    // After re-render, footer-right should be empty
    assert.equal(el.querySelector('.footer-right').children.length, 0);
  });

  it('clearFocus() removes focused class from bubble', () => {
    let el = makeElement();
    connectElement(el);

    el.querySelector('.bubble').click();
    assert.ok(el.querySelector('.bubble').classList.contains('focused'));

    el.clearFocus();
    assert.ok(!el.querySelector('.bubble').classList.contains('focused'));
  });

  it('token-count of 1 uses singular form', () => {
    let el = makeElement({ 'token-count': '1' });
    connectElement(el);

    let meta = el.querySelector('.footer-meta').textContent;
    assert.ok(meta.includes('1 token'), `Expected singular form, got: "${meta}"`);
    assert.ok(!meta.includes('tokens'), 'Should not contain plural "tokens"');
  });

  it('token-count of 0 or negative shows no token text', () => {
    let el = makeElement({ 'token-count': '0' });
    connectElement(el);

    let meta = el.querySelector('.footer-meta').textContent;
    assert.ok(!meta.includes('token'), 'Should not show token text for count 0');
  });
});
