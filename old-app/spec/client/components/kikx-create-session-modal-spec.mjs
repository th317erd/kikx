'use strict';

// =============================================================================
// Unit tests for <kikx-create-session-modal> WebComponent
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

  await import('../../../src/client/components/kikx-create-session-modal/kikx-create-session-modal.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement() {
  return connectElement(createElement('kikx-create-session-modal'));
}

// =============================================================================
// 1. Rendering
// =============================================================================

describe('kikx-create-session-modal — rendering', { timeout: 5000 }, () => {
  it('renders agent select, name input, create and cancel buttons', () => {
    let el = makeElement();
    assert.ok(el.querySelector('.agent-select'));
    assert.ok(el.querySelector('.session-name-input'));
    assert.ok(el.querySelector('.create-button'));
    assert.ok(el.querySelector('.cancel-button'));
  });

  it('create button text is from i18n', () => {
    let el = makeElement();
    assert.equal(el.querySelector('.create-button').textContent, 'Create');
  });

  it('cancel button text is from i18n', () => {
    let el = makeElement();
    assert.equal(el.querySelector('.cancel-button').textContent, 'Cancel');
  });

  it('name input placeholder is from i18n', () => {
    let el = makeElement();
    assert.equal(el.querySelector('.session-name-input').placeholder, 'Session name...');
  });
});

// =============================================================================
// 2. Agents property
// =============================================================================

describe('kikx-create-session-modal — agents property', { timeout: 5000 }, () => {
  it('setting agents populates agent select with options', () => {
    let el = makeElement();
    el.agents = [
      { id: 'agt-1', name: 'test-bot-1' },
      { id: 'agt-2', name: 'test-bot-2' },
    ];

    let options = el.querySelector('.agent-select').options;
    // "None" + 2 agents = 3 options
    assert.equal(options.length, 3);
    assert.equal(options[0].value, '');
    assert.equal(options[0].textContent, 'None');
    assert.equal(options[1].value, 'agt-1');
    assert.equal(options[1].textContent, 'test-bot-1');
  });

  it('empty agents array shows no-agents message', () => {
    let el = makeElement();
    el.agents = [];
    assert.equal(el.querySelector('.agent-select').style.display, 'none');
    assert.notEqual(el.querySelector('.no-agents-message').style.display, 'none');
  });

  it('non-array agents value is coerced to empty array', () => {
    let el = makeElement();
    el.agents = 'not-an-array';
    assert.deepEqual(el.agents, []);
  });

  it('agents getter returns current agents array', () => {
    let el = makeElement();
    let agents = [{ id: 'agt-1', name: 'test-bot' }];
    el.agents = agents;
    assert.equal(el.agents.length, 1);
    assert.equal(el.agents[0].id, 'agt-1');
  });
});

// =============================================================================
// 3. Events
// =============================================================================

describe('kikx-create-session-modal — events', { timeout: 5000 }, () => {
  it('create button dispatches session-create with name and agentID', () => {
    let el = makeElement();
    el.agents = [{ id: 'agt-1', name: 'test-bot' }];
    el.querySelector('.agent-select').value = 'agt-1';
    el.querySelector('.session-name-input').value = 'My Session';

    let received = null;
    el.addEventListener('session-create', (e) => { received = e.detail; });

    el.querySelector('.create-button').click();

    assert.ok(received);
    assert.equal(received.name, 'My Session');
    assert.equal(received.agentID, 'agt-1');
  });

  it('create with empty name sends null for name', () => {
    let el = makeElement();
    el.querySelector('.session-name-input').value = '';

    let received = null;
    el.addEventListener('session-create', (e) => { received = e.detail; });

    el.querySelector('.create-button').click();
    assert.equal(received.name, null);
  });

  it('create with no agent selected sends null for agentID', () => {
    let el = makeElement();
    el.agents = [{ id: 'agt-1', name: 'test-bot' }];
    el.querySelector('.agent-select').value = '';

    let received = null;
    el.addEventListener('session-create', (e) => { received = e.detail; });

    el.querySelector('.create-button').click();
    assert.equal(received.agentID, null);
  });

  it('cancel button dispatches session-cancel', () => {
    let el = makeElement();
    let dispatched = false;
    el.addEventListener('session-cancel', () => { dispatched = true; });

    el.querySelector('.cancel-button').click();
    assert.ok(dispatched);
  });

  it('session-create event bubbles and is composed', () => {
    let el = makeElement();
    let event = null;
    document.body.addEventListener('session-create', (e) => { event = e; });

    el.querySelector('.create-button').click();

    assert.ok(event);
    assert.equal(event.bubbles, true);
    assert.equal(event.composed, true);
  });

  it('Enter key in name input triggers create', () => {
    let el = makeElement();
    el.querySelector('.session-name-input').value = 'Enter Test';

    let received = null;
    el.addEventListener('session-create', (e) => { received = e.detail; });

    let input = el.querySelector('.session-name-input');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));

    assert.ok(received);
    assert.equal(received.name, 'Enter Test');
  });
});

// =============================================================================
// 4. Reset
// =============================================================================

describe('kikx-create-session-modal — reset', { timeout: 5000 }, () => {
  it('reset() clears name input and resets agent select', () => {
    let el = makeElement();
    el.agents = [{ id: 'agt-1', name: 'test-bot' }];
    el.querySelector('.session-name-input').value = 'Something';
    el.querySelector('.agent-select').value = 'agt-1';

    el.reset();

    assert.equal(el.querySelector('.session-name-input').value, '');
    assert.equal(el.querySelector('.agent-select').selectedIndex, 0);
  });
});

// =============================================================================
// 5. Edge cases
// =============================================================================

describe('kikx-create-session-modal — edge cases', { timeout: 5000 }, () => {
  it('disconnect removes event listeners without error', () => {
    let el = makeElement();
    disconnectElement(el);
    assert.ok(true);
  });

  it('create button is always enabled (agent is optional)', () => {
    let el = makeElement();
    assert.equal(el.querySelector('.create-button').disabled, false);
  });

  it('selecting an agent auto-fills name if name is empty', () => {
    let el = makeElement();
    el.agents = [{ id: 'agt-1', name: 'test-claude' }];

    // Simulate selecting agent
    let select = el.querySelector('.agent-select');
    select.value = 'agt-1';
    select.dispatchEvent(new Event('change'));

    assert.equal(el.querySelector('.session-name-input').value, 'test-claude');
  });

  it('selecting agent does NOT overwrite existing name', () => {
    let el = makeElement();
    el.agents = [{ id: 'agt-1', name: 'test-claude' }];
    el.querySelector('.session-name-input').value = 'My Custom Name';

    let select = el.querySelector('.agent-select');
    select.value = 'agt-1';
    select.dispatchEvent(new Event('change'));

    assert.equal(el.querySelector('.session-name-input').value, 'My Custom Name');
  });
});
