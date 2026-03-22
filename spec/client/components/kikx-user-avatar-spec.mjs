'use strict';

// =============================================================================
// Unit tests for <kikx-user-avatar> WebComponent
// =============================================================================

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createElement,
  connectElement,
  disconnectElement,
  clearBody,
} from '../helpers/jsdom-setup.mjs';

let md5;

before(async () => {
  let mod = await import('../../../src/client/components/kikx-user-avatar/kikx-user-avatar.mjs');
  md5 = mod.md5;
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement(attrs = {}) {
  let el = createElement('kikx-user-avatar');

  for (let [key, value] of Object.entries(attrs))
    el.setAttribute(key, value);

  return el;
}

// =============================================================================
// 1. Initials logic
// =============================================================================

describe('kikx-user-avatar — initials', { timeout: 5000 }, () => {
  it('displays first + last initials from first-name and last-name', () => {
    let el = connectElement(makeElement({ 'first-name': 'Alice', 'last-name': 'Baker' }));
    let initials = el.querySelector('.initials');
    assert.equal(initials.textContent, 'AB');
  });

  it('displays first two chars of first-name when last-name is absent', () => {
    let el = connectElement(makeElement({ 'first-name': 'Charlie' }));
    let initials = el.querySelector('.initials');
    assert.equal(initials.textContent, 'CH');
  });

  it('single-character first-name with no last-name shows single char padded', () => {
    let el = connectElement(makeElement({ 'first-name': 'X' }));
    let initials = el.querySelector('.initials');
    assert.equal(initials.textContent, 'X');
  });

  it('displays first two chars of email when no name attributes', () => {
    let el = connectElement(makeElement({ email: 'zoe@example.com' }));
    let initials = el.querySelector('.initials');
    assert.equal(initials.textContent, 'ZO');
  });

  it('displays ?? when no name or email is provided', () => {
    let el = connectElement(makeElement());
    let initials = el.querySelector('.initials');
    assert.equal(initials.textContent, '??');
  });

  it('initials are uppercased', () => {
    let el = connectElement(makeElement({ 'first-name': 'alice', 'last-name': 'baker' }));
    let initials = el.querySelector('.initials');
    assert.equal(initials.textContent, 'AB');
  });
});

// =============================================================================
// 2. Size attribute
// =============================================================================

describe('kikx-user-avatar — size', { timeout: 5000 }, () => {
  it('defaults to 32px when no size attribute', () => {
    let el = connectElement(makeElement({ 'first-name': 'Test' }));
    let container = el.querySelector('.avatar');
    assert.equal(container.style.width, '32px');
    assert.equal(container.style.height, '32px');
  });

  it('applies custom size from attribute', () => {
    let el = connectElement(makeElement({ 'first-name': 'Test', size: '64' }));
    let container = el.querySelector('.avatar');
    assert.equal(container.style.width, '64px');
    assert.equal(container.style.height, '64px');
  });

  it('font size scales with avatar size', () => {
    let el = connectElement(makeElement({ 'first-name': 'Test', size: '100' }));
    let initials = el.querySelector('.initials');
    // fontSize = Math.max(10, Math.round(100 * 0.4)) = 40
    assert.equal(initials.style.fontSize, '40px');
  });
});

// =============================================================================
// 3. Avatar image priority
// =============================================================================

describe('kikx-user-avatar — avatar-data / gravatar', { timeout: 5000 }, () => {
  it('shows avatar-data image when avatar-data is set (base64)', () => {
    let el = connectElement(makeElement({ 'avatar-data': 'abc123==' }));
    let img = el.querySelector('.avatar-image');
    assert.equal(img.style.display, 'block');
    assert.ok(img.src.includes('data:image/png;base64,abc123=='));
    assert.equal(el.querySelector('.initials').style.display, 'none');
  });

  it('avatar-data starting with data: is used as-is', () => {
    let el = connectElement(makeElement({ 'avatar-data': 'data:image/jpeg;base64,XYZ' }));
    let img = el.querySelector('.avatar-image');
    assert.ok(img.src.includes('data:image/jpeg;base64,XYZ'));
  });

  it('shows gravatar when email is set and no avatar-data', () => {
    let el = connectElement(makeElement({ email: 'test@example.com' }));
    let img = el.querySelector('.avatar-image');
    assert.equal(img.style.display, 'block');
    assert.ok(img.src.includes('gravatar.com/avatar/'));
    assert.equal(el.querySelector('.initials').style.display, 'none');
  });

  it('gravatar URL uses MD5 of lowercased trimmed email', () => {
    let email = '  Test@EXAMPLE.COM  ';
    let el = connectElement(makeElement({ email }));
    let img = el.querySelector('.avatar-image');
    let expectedHash = md5('test@example.com');
    assert.ok(img.src.includes(expectedHash));
  });

  it('hides image and shows initials when no avatar-data and no email', () => {
    let el = connectElement(makeElement({ 'first-name': 'Test' }));
    let img = el.querySelector('.avatar-image');
    assert.equal(img.style.display, 'none');
    assert.notEqual(el.querySelector('.initials').style.display, 'none');
  });
});

// =============================================================================
// 4. md5 exported function
// =============================================================================

describe('kikx-user-avatar — md5 export', { timeout: 5000 }, () => {
  it('returns 32-hex-char string', () => {
    let hash = md5('hello');
    assert.equal(hash.length, 32);
    assert.match(hash, /^[0-9a-f]{32}$/);
  });

  it('produces known hash for empty string', () => {
    assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  });

  it('produces known hash for "hello"', () => {
    assert.equal(md5('hello'), '5d41402abc4b2a76b9719d911017c592');
  });
});

// =============================================================================
// 5. Edge cases
// =============================================================================

describe('kikx-user-avatar — edge cases', { timeout: 5000 }, () => {
  it('re-renders on attribute change after connect', () => {
    let el = connectElement(makeElement({ 'first-name': 'Alice', 'last-name': 'Baker' }));
    assert.equal(el.querySelector('.initials').textContent, 'AB');

    el.setAttribute('first-name', 'Charlie');
    el.setAttribute('last-name', 'Doe');
    assert.equal(el.querySelector('.initials').textContent, 'CD');
  });

  it('disconnect removes image error listener without error', () => {
    let el = connectElement(makeElement({ email: 'test@example.com' }));
    disconnectElement(el);
    assert.ok(true);
  });

  it('image error handler falls back to initials', () => {
    let el = connectElement(makeElement({ email: 'test@example.com', 'first-name': 'T' }));
    let img = el.querySelector('.avatar-image');
    // Simulate image load error
    img.dispatchEvent(new Event('error'));
    assert.equal(img.style.display, 'none');
    assert.notEqual(el.querySelector('.initials').style.display, 'none');
  });
});
