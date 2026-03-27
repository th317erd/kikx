'use strict';

// =============================================================================
// Unit tests for <kikx-add-friend-modal> WebComponent
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

  await import('../../../src/client/components/kikx-add-friend-modal/kikx-add-friend-modal.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement() {
  return connectElement(createElement('kikx-add-friend-modal'));
}

// =============================================================================
// 1. Wizard — type step (initial)
// =============================================================================

describe('kikx-add-friend-modal — type step', { timeout: 5000 }, () => {
  it('renders with type step active by default', () => {
    let el = makeElement();
    let typeStep = el.querySelector('.step-type');
    assert.ok(typeStep.classList.contains('active'));
  });

  it('agent and user type buttons exist', () => {
    let el = makeElement();
    assert.ok(el.querySelector('.agent-type-button'));
    assert.ok(el.querySelector('.user-type-button'));
  });

  it('type step title is set from i18n', () => {
    let el = makeElement();
    assert.equal(el.querySelector('.step-title').textContent, 'What kind of friend?');
  });

  it('agent button label is set from i18n', () => {
    let el = makeElement();
    assert.equal(el.querySelector('.agent-type-label').textContent, 'AI Agent');
  });

  it('user button label is set from i18n', () => {
    let el = makeElement();
    assert.equal(el.querySelector('.user-type-label').textContent, 'Human');
  });

  it('cancel button dispatches friend-cancel event', () => {
    let el = makeElement();
    let dispatched = false;
    el.addEventListener('friend-cancel', () => { dispatched = true; });

    el.querySelector('.type-cancel-button').click();
    assert.ok(dispatched);
  });
});

// =============================================================================
// 2. Wizard — navigation
// =============================================================================

describe('kikx-add-friend-modal — wizard navigation', { timeout: 5000 }, () => {
  it('clicking agent type button shows agent step', () => {
    let el = makeElement();
    el.querySelector('.agent-type-button').click();
    assert.ok(el.querySelector('.step-agent').classList.contains('active'));
    assert.ok(!el.querySelector('.step-type').classList.contains('active'));
  });

  it('clicking user type button shows user step', () => {
    let el = makeElement();
    el.querySelector('.user-type-button').click();
    assert.ok(el.querySelector('.step-user').classList.contains('active'));
    assert.ok(!el.querySelector('.step-type').classList.contains('active'));
  });

  it('back button returns to type step from agent step', () => {
    let el = makeElement();
    el.querySelector('.agent-type-button').click();
    assert.ok(el.querySelector('.step-agent').classList.contains('active'));

    el.querySelector('.step-agent .back-button').click();
    assert.ok(el.querySelector('.step-type').classList.contains('active'));
  });

  it('back button returns to type step from user step', () => {
    let el = makeElement();
    el.querySelector('.user-type-button').click();
    el.querySelector('.step-user .back-button').click();
    assert.ok(el.querySelector('.step-type').classList.contains('active'));
  });
});

// =============================================================================
// 3. Agent step — form and events
// =============================================================================

describe('kikx-add-friend-modal — agent step', { timeout: 5000 }, () => {
  it('has plugin select, api-key input, name input, and model select', () => {
    let el = makeElement();
    el.querySelector('.agent-type-button').click();
    assert.ok(el.querySelector('.plugin-select'));
    assert.ok(el.querySelector('.api-key-input'));
    assert.ok(el.querySelector('.name-input'));
    assert.ok(el.querySelector('.model-select'));
  });

  it('save button dispatches friend-save with agent details', () => {
    let el = makeElement();
    el.querySelector('.agent-type-button').click();

    // Populate dropdowns (normally loaded from API)
    let pluginSel = el.querySelector('.plugin-select');
    pluginSel.innerHTML = '<option value="claude">Claude</option>';
    pluginSel.value = 'claude';

    let modelSel = el.querySelector('.model-select');
    modelSel.innerHTML = '<option value="claude-opus-4-6">Claude Opus 4.6</option>';
    modelSel.value = 'claude-opus-4-6';

    el.querySelector('.api-key-input').value = 'sk-test-key';
    el.querySelector('.name-input').value = 'test-bot';

    let received = null;
    el.addEventListener('friend-save', (e) => { received = e.detail; });

    el.querySelector('.save-button').click();

    assert.ok(received);
    assert.equal(received.type, 'agent');
    assert.equal(received.apiKey, 'sk-test-key');
    assert.equal(received.name, 'test-bot');
    assert.equal(received.model, 'claude-opus-4-6');
    assert.equal(received.pluginID, 'claude');
  });

  it('cancel button in agent step dispatches friend-cancel', () => {
    let el = makeElement();
    el.querySelector('.agent-type-button').click();

    let dispatched = false;
    el.addEventListener('friend-cancel', () => { dispatched = true; });

    el.querySelector('.step-agent .cancel-button').click();
    assert.ok(dispatched);
  });
});

// =============================================================================
// 4. User step — form and events
// =============================================================================

describe('kikx-add-friend-modal — user step', { timeout: 5000 }, () => {
  it('has email input and name input', () => {
    let el = makeElement();
    el.querySelector('.user-type-button').click();
    assert.ok(el.querySelector('.user-email-input'));
    assert.ok(el.querySelector('.user-name-input'));
  });

  it('invite button dispatches friend-save with user details', () => {
    let el = makeElement();
    el.querySelector('.user-type-button').click();

    el.querySelector('.user-email-input').value = 'friend@example.com';
    el.querySelector('.user-name-input').value = 'A Friend';

    let received = null;
    el.addEventListener('friend-save', (e) => { received = e.detail; });

    el.querySelector('.invite-button').click();

    assert.ok(received);
    assert.equal(received.type, 'user');
    assert.equal(received.email, 'friend@example.com');
    assert.equal(received.name, 'A Friend');
  });
});

// =============================================================================
// 5. Reset
// =============================================================================

describe('kikx-add-friend-modal — reset', { timeout: 5000 }, () => {
  it('reset() returns to type step and clears inputs', () => {
    let el = makeElement();

    // Navigate to agent step and fill in data
    el.querySelector('.agent-type-button').click();
    el.querySelector('.api-key-input').value = 'some-key';
    el.querySelector('.name-input').value = 'some-name';

    el.reset();

    assert.ok(el.querySelector('.step-type').classList.contains('active'));
    assert.equal(el.querySelector('.api-key-input').value, '');
    assert.equal(el.querySelector('.name-input').value, '');
  });
});

// =============================================================================
// 6. Edge cases
// =============================================================================

describe('kikx-add-friend-modal — edge cases', { timeout: 5000 }, () => {
  it('disconnect removes event listeners without error', () => {
    let el = makeElement();
    disconnectElement(el);
    assert.ok(true);
  });

  it('friend-cancel event bubbles', () => {
    let el = makeElement();
    let received = false;
    document.body.addEventListener('friend-cancel', () => { received = true; });
    el.querySelector('.type-cancel-button').click();
    assert.ok(received);
  });
});
