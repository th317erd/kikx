'use strict';

// =============================================================================
// Unit tests for <kikx-agent-form-modal> WebComponent
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

  await import('../../../src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement(attrs = {}) {
  let el = createElement('kikx-agent-form-modal');

  for (let [key, value] of Object.entries(attrs))
    el.setAttribute(key, value);

  return el;
}

// =============================================================================
// 1. Rendering
// =============================================================================

describe('kikx-agent-form-modal — rendering', { timeout: 5000 }, () => {
  it('renders form inputs on connect (name, api-key, model, risk-level)', () => {
    let el = connectElement(makeElement());
    assert.ok(el.querySelector('.name-input'));
    assert.ok(el.querySelector('.api-key-input'));
    assert.ok(el.querySelector('.model-input'));
    assert.ok(el.querySelector('.risk-level-select'));
  });

  it('labels are populated from i18n', () => {
    let el = connectElement(makeElement());
    assert.equal(el.querySelector('.name-label').textContent, 'Agent Name');
    assert.equal(el.querySelector('.api-key-label').textContent, 'API Key');
    assert.equal(el.querySelector('.model-label').textContent, 'Model');
    assert.equal(el.querySelector('.risk-level-label').textContent, 'Risk Level');
  });

  it('button labels are populated from i18n', () => {
    let el = connectElement(makeElement());
    assert.equal(el.querySelector('.save-button').textContent, 'Save');
    assert.equal(el.querySelector('.delete-button').textContent, 'Delete');
    assert.equal(el.querySelector('.cancel-button').textContent, 'Cancel');
  });

  it('risk-level select has correct options with YOLO', () => {
    let el = connectElement(makeElement());
    let options = el.querySelector('.risk-level-select').options;
    assert.equal(options.length, 4);
    assert.equal(options[0].textContent, 'Account Default');
    assert.equal(options[1].textContent, 'Strict');
    assert.equal(options[2].textContent, 'Normal');
    assert.equal(options[3].textContent, 'Permissive (YOLO)');
  });
});

// =============================================================================
// 2. Mode attribute — delete button visibility
// =============================================================================

describe('kikx-agent-form-modal — mode attribute', { timeout: 5000 }, () => {
  it('delete button is visible by default (edit mode)', () => {
    let el = connectElement(makeElement());
    assert.notEqual(el.querySelector('.delete-button').style.display, 'none');
  });

  it('delete button is hidden in create mode', () => {
    let el = connectElement(makeElement({ mode: 'create' }));
    assert.equal(el.querySelector('.delete-button').style.display, 'none');
  });
});

// =============================================================================
// 3. Agent setter / getValues
// =============================================================================

describe('kikx-agent-form-modal — agent property and getValues', { timeout: 5000 }, () => {
  it('setting agent populates name and shows API key placeholder', () => {
    let el = connectElement(makeElement());
    el.agent = {
      id:        'agt-1',
      name:      'test-bot',
      model:     'claude-opus-4-6',
      riskLevel: 'strict',
    };

    assert.equal(el.querySelector('.name-input').value, 'test-bot');
    assert.equal(el.querySelector('.api-key-input').value, '');
    assert.ok(el.querySelector('.api-key-input').placeholder.length > 0);
    assert.equal(el.querySelector('.risk-level-select').value, 'strict');
  });

  it('setting agent to null clears form fields', () => {
    let el = connectElement(makeElement());
    el.agent = { name: 'test-bot' };
    el.agent = null;

    assert.equal(el.querySelector('.name-input').value, '');
    assert.equal(el.querySelector('.api-key-input').value, '');
  });

  it('getValues returns name, model, riskLevel (no apiKey when empty)', () => {
    let el = connectElement(makeElement());
    el.querySelector('.name-input').value = 'test-agent';
    el.querySelector('.risk-level-select').value = 'normal';

    let values = el.getValues();
    assert.equal(values.name, 'test-agent');
    assert.equal(values.riskLevel, 'normal');
    assert.equal(values.apiKey, undefined);
  });

  it('getValues includes apiKey only when non-empty', () => {
    let el = connectElement(makeElement());
    el.querySelector('.name-input').value = 'test-agent';
    el.querySelector('.api-key-input').value = 'sk-123';

    let values = el.getValues();
    assert.equal(values.apiKey, 'sk-123');
  });
});

// =============================================================================
// 4. Events
// =============================================================================

describe('kikx-agent-form-modal — events', { timeout: 5000 }, () => {
  it('save button dispatches agent-save with agentID and values', () => {
    let el = connectElement(makeElement());
    el.agent = { id: 'agt-42', name: 'test-bot' };
    el.querySelector('.name-input').value = 'test-updated';

    let received = null;
    el.addEventListener('agent-save', (e) => { received = e.detail; });

    el.querySelector('.save-button').click();

    assert.ok(received);
    assert.equal(received.agentID, 'agt-42');
    assert.equal(received.values.name, 'test-updated');
  });

  it('delete button dispatches agent-delete with agentID', () => {
    let el = connectElement(makeElement());
    el.agent = { id: 'agt-99' };

    let received = null;
    el.addEventListener('agent-delete', (e) => { received = e.detail; });

    el.querySelector('.delete-button').click();

    assert.ok(received);
    assert.equal(received.agentID, 'agt-99');
  });

  it('cancel button dispatches agent-cancel', () => {
    let el = connectElement(makeElement());
    let dispatched = false;
    el.addEventListener('agent-cancel', () => { dispatched = true; });

    el.querySelector('.cancel-button').click();
    assert.ok(dispatched);
  });

  it('agent-save event bubbles and is composed', () => {
    let el = connectElement(makeElement());
    let event = null;
    document.body.addEventListener('agent-save', (e) => { event = e; });

    el.querySelector('.save-button').click();

    assert.ok(event);
    assert.equal(event.bubbles, true);
    assert.equal(event.composed, true);
  });
});

// =============================================================================
// 5. Edge cases
// =============================================================================

describe('kikx-agent-form-modal — edge cases', { timeout: 5000 }, () => {
  it('disconnect removes event listeners without error', () => {
    let el = connectElement(makeElement());
    disconnectElement(el);
    assert.ok(true);
  });

  it('setting agent before connect stores value (applied on connect)', () => {
    let el = makeElement();
    el.agent = { name: 'test-pre' };
    assert.equal(el.agent.name, 'test-pre');
  });
});
