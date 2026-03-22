'use strict';

// =============================================================================
// Unit tests for <kikx-login-page> WebComponent
// =============================================================================
// NOTE: kikx-login-page imports store, api, router, and config. These all
// resolve in our jsdom environment thanks to the kikx import map. We load i18n
// with real English locale so t() calls inside the component work.
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

  await import('../../../src/client/components/kikx-login-page/kikx-login-page.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement() {
  return createElement('kikx-login-page');
}

// =============================================================================
// 1. Rendering
// =============================================================================

describe('kikx-login-page — rendering', { timeout: 5000 }, () => {
  it('renders login card with title, subtitle, form, and status', () => {
    let el = connectElement(makeElement());
    assert.ok(el.querySelector('.login-card'));
    assert.ok(el.querySelector('.title'));
    assert.ok(el.querySelector('.subtitle'));
    assert.ok(el.querySelector('form'));
    assert.ok(el.querySelector('.status-message'));
  });

  it('has email input with type=email', () => {
    let el = connectElement(makeElement());
    let input = el.querySelector('.email-input');
    assert.ok(input);
    assert.equal(input.type, 'email');
  });

  it('has password input with type=password', () => {
    let el = connectElement(makeElement());
    let input = el.querySelector('.password-input');
    assert.ok(input);
    assert.equal(input.type, 'password');
  });

  it('has submit button', () => {
    let el = connectElement(makeElement());
    let btn = el.querySelector('.submit-button');
    assert.ok(btn);
    assert.equal(btn.type, 'submit');
  });

  it('title displays application.title from i18n', () => {
    let el = connectElement(makeElement());
    assert.equal(el.querySelector('.title').textContent, 'Kikx');
  });

  it('subtitle displays login.subtitle from i18n', () => {
    let el = connectElement(makeElement());
    assert.equal(el.querySelector('.subtitle').textContent, 'AI-powered collaborative channels');
  });

  it('submit button text is login.submitButton from i18n', () => {
    let el = connectElement(makeElement());
    assert.equal(el.querySelector('.submit-button').textContent, 'Sign In');
  });

  it('email placeholder is set from i18n', () => {
    let el = connectElement(makeElement());
    assert.equal(el.querySelector('.email-input').placeholder, 'Enter your email');
  });
});

// =============================================================================
// 2. Status message
// =============================================================================

describe('kikx-login-page — status messages', { timeout: 5000 }, () => {
  it('status message is hidden by default', () => {
    let el = connectElement(makeElement());
    let status = el.querySelector('.status-message');
    assert.ok(!status.classList.contains('visible'));
  });

  it('_showError displays error message with correct classes', () => {
    let el = connectElement(makeElement());
    el._showError('Bad credentials');
    let status = el.querySelector('.status-message');
    assert.equal(status.textContent, 'Bad credentials');
    assert.ok(status.classList.contains('visible'));
    assert.ok(status.classList.contains('error'));
  });

  it('_showSuccess displays success message with correct classes', () => {
    let el = connectElement(makeElement());
    el._showSuccess('Logged in!');
    let status = el.querySelector('.status-message');
    assert.equal(status.textContent, 'Logged in!');
    assert.ok(status.classList.contains('visible'));
    assert.ok(status.classList.contains('success'));
  });

  it('_hideStatus clears and hides the status message', () => {
    let el = connectElement(makeElement());
    el._showError('Error');
    el._hideStatus();
    let status = el.querySelector('.status-message');
    assert.equal(status.textContent, '');
    assert.ok(!status.classList.contains('visible'));
  });
});

// =============================================================================
// 3. Loading state
// =============================================================================

describe('kikx-login-page — loading state', { timeout: 5000 }, () => {
  it('_setLoading(true) disables button and changes text', () => {
    let el = connectElement(makeElement());
    el._setLoading(true);
    let btn = el.querySelector('.submit-button');
    assert.equal(btn.disabled, true);
    assert.equal(btn.textContent, 'Signing in...');
  });

  it('_setLoading(false) re-enables button and restores text', () => {
    let el = connectElement(makeElement());
    el._setLoading(true);
    el._setLoading(false);
    let btn = el.querySelector('.submit-button');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Sign In');
  });
});

// =============================================================================
// 4. Edge cases
// =============================================================================

describe('kikx-login-page — edge cases', { timeout: 5000 }, () => {
  it('disconnect removes submit listener without error', () => {
    let el = connectElement(makeElement());
    disconnectElement(el);
    assert.ok(true);
  });

  it('re-connect re-initializes without duplicating DOM', () => {
    let el = connectElement(makeElement());
    disconnectElement(el);
    connectElement(el);
    // Should still only have one form
    let forms = el.querySelectorAll('form');
    assert.equal(forms.length, 1);
  });
});
