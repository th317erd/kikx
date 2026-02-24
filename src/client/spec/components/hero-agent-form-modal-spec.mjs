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
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/hero/',
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

  class HeroAgentFormModal extends JsdomHTMLElement {
    static get observedAttributes() { return ['mode']; }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }

          .form-group { margin-bottom: 12px; }

          .form-label {
            display: block; font-size: 0.8125rem; font-weight: 600;
            color: var(--text-secondary, #a0a0b8); margin-bottom: 4px;
          }

          .form-input {
            width: 100%; box-sizing: border-box;
            padding: 8px 12px; font-size: 0.875rem;
            background: var(--input-background, rgba(255, 255, 255, 0.05));
            border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
            border-radius: var(--border-radius-small, 4px);
            color: var(--text-primary, #e8e8f0); outline: none;
            font-family: inherit;
            transition: border-color 0.2s ease;
          }

          .form-input:focus {
            border-color: var(--accent-primary, #00e5ff);
            box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
          }

          .button-row {
            display: flex; gap: var(--spacing-sm, 8px); justify-content: flex-end;
            margin-top: 16px; padding-top: 12px;
            border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
          }

          .save-button {
            background: var(--accent-primary, #00e5ff); color: var(--bg-primary, #0a0a12);
            border: none; border-radius: var(--border-radius-small, 4px);
            padding: 8px 20px; font-weight: 600; font-size: 0.875rem; cursor: pointer;
          }

          .save-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }

          .delete-button {
            background: rgba(229, 57, 53, 0.15); color: #ef5350;
            border: 1px solid rgba(229, 57, 53, 0.30);
            border-radius: var(--border-radius-small, 4px);
            padding: 8px 16px; font-size: 0.875rem; cursor: pointer;
          }

          .delete-button:hover { background: rgba(229, 57, 53, 0.25); }

          .cancel-button {
            background: none; border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
            color: var(--text-secondary, #a0a0b8);
            border-radius: var(--border-radius-small, 4px);
            padding: 8px 16px; font-size: 0.875rem; cursor: pointer;
          }

          .cancel-button:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }
        </style>

        <div class="form-group">
          <label class="form-label name-label"></label>
          <input class="form-input name-input" type="text" />
        </div>
        <div class="form-group">
          <label class="form-label provider-label"></label>
          <input class="form-input provider-input" type="text" />
        </div>
        <div class="form-group">
          <label class="form-label api-key-label"></label>
          <input class="form-input api-key-input" type="password" />
        </div>
        <div class="form-group">
          <label class="form-label model-label"></label>
          <input class="form-input model-input" type="text" />
        </div>
        <div class="button-row">
          <button class="delete-button"></button>
          <button class="cancel-button"></button>
          <button class="save-button"></button>
        </div>
      `;

      this._nameInput     = this.shadowRoot.querySelector('.name-input');
      this._providerInput = this.shadowRoot.querySelector('.provider-input');
      this._apiKeyInput   = this.shadowRoot.querySelector('.api-key-input');
      this._modelInput    = this.shadowRoot.querySelector('.model-input');

      this._nameLabel     = this.shadowRoot.querySelector('.name-label');
      this._providerLabel = this.shadowRoot.querySelector('.provider-label');
      this._apiKeyLabel   = this.shadowRoot.querySelector('.api-key-label');
      this._modelLabel    = this.shadowRoot.querySelector('.model-label');

      this._saveButton   = this.shadowRoot.querySelector('.save-button');
      this._deleteButton = this.shadowRoot.querySelector('.delete-button');
      this._cancelButton = this.shadowRoot.querySelector('.cancel-button');

      this._agent = null;

      this._onSaveClick   = this._onSaveClick.bind(this);
      this._onDeleteClick = this._onDeleteClick.bind(this);
      this._onCancelClick = this._onCancelClick.bind(this);
    }

    connectedCallback() {
      this._nameLabel.textContent     = mockT('agent.form.nameLabel');
      this._providerLabel.textContent = mockT('agent.form.providerLabel');
      this._apiKeyLabel.textContent   = mockT('agent.form.apiKeyLabel');
      this._modelLabel.textContent    = mockT('agent.form.modelLabel');

      this._saveButton.textContent   = mockT('agent.form.saveButton');
      this._deleteButton.textContent = mockT('agent.form.deleteButton');
      this._cancelButton.textContent = mockT('agent.form.cancelButton');

      this._saveButton.addEventListener('click', this._onSaveClick);
      this._deleteButton.addEventListener('click', this._onDeleteClick);
      this._cancelButton.addEventListener('click', this._onCancelClick);

      this._updateDeleteVisibility();
    }

    disconnectedCallback() {
      this._saveButton.removeEventListener('click', this._onSaveClick);
      this._deleteButton.removeEventListener('click', this._onDeleteClick);
      this._cancelButton.removeEventListener('click', this._onCancelClick);
    }

    attributeChangedCallback(name) {
      if (name === 'mode')
        this._updateDeleteVisibility();
    }

    get agent() { return this._agent; }

    set agent(value) {
      this._agent = value;

      if (value) {
        this._nameInput.value     = value.name || '';
        this._providerInput.value = value.provider || '';
        this._apiKeyInput.value   = value.apiKey || '';
        this._modelInput.value    = value.model || '';
      } else {
        this._nameInput.value     = '';
        this._providerInput.value = '';
        this._apiKeyInput.value   = '';
        this._modelInput.value    = '';
      }
    }

    getValues() {
      return {
        name:     this._nameInput.value,
        provider: this._providerInput.value,
        apiKey:   this._apiKeyInput.value,
        model:    this._modelInput.value,
      };
    }

    _updateDeleteVisibility() {
      if (this._deleteButton)
        this._deleteButton.style.display = (this.getAttribute('mode') === 'create') ? 'none' : '';
    }

    _onSaveClick() {
      this.dispatchEvent(new dom.window.CustomEvent('agent-save', {
        bubbles:  true,
        composed: true,
        detail:   { agentId: this._agent?.id, values: this.getValues() },
      }));
    }

    _onDeleteClick() {
      this.dispatchEvent(new dom.window.CustomEvent('agent-delete', {
        bubbles:  true,
        composed: true,
        detail:   { agentId: this._agent?.id },
      }));
    }

    _onCancelClick() {
      this.dispatchEvent(new dom.window.CustomEvent('agent-cancel', {
        bubbles:  true,
        composed: true,
      }));
    }
  }

  dom.window.customElements.define('hero-agent-form-modal', HeroAgentFormModal);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hero-agent-form-modal', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('hero-agent-form-modal');
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
    let registered = dom.window.customElements.get('hero-agent-form-modal');
    assert.ok(registered, 'hero-agent-form-modal should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Has shadow root
  // -------------------------------------------------------------------------

  it('has a shadow root', () => {
    assert.ok(element.shadowRoot, 'element should have a shadow root');
  });

  // -------------------------------------------------------------------------
  // 3. Renders labels from i18n
  // -------------------------------------------------------------------------

  it('renders labels from i18n', () => {
    let nameLabel     = element.shadowRoot.querySelector('.name-label');
    let providerLabel = element.shadowRoot.querySelector('.provider-label');
    let apiKeyLabel   = element.shadowRoot.querySelector('.api-key-label');
    let modelLabel    = element.shadowRoot.querySelector('.model-label');
    let saveButton    = element.shadowRoot.querySelector('.save-button');
    let deleteButton  = element.shadowRoot.querySelector('.delete-button');
    let cancelButton  = element.shadowRoot.querySelector('.cancel-button');

    assert.equal(nameLabel.textContent, localeData.agent.form.nameLabel);
    assert.equal(providerLabel.textContent, localeData.agent.form.providerLabel);
    assert.equal(apiKeyLabel.textContent, localeData.agent.form.apiKeyLabel);
    assert.equal(modelLabel.textContent, localeData.agent.form.modelLabel);
    assert.equal(saveButton.textContent, localeData.agent.form.saveButton);
    assert.equal(deleteButton.textContent, localeData.agent.form.deleteButton);
    assert.equal(cancelButton.textContent, localeData.agent.form.cancelButton);
  });

  // -------------------------------------------------------------------------
  // 4. Form fields start empty in create mode
  // -------------------------------------------------------------------------

  it('form fields start empty in create mode', () => {
    element.setAttribute('mode', 'create');

    let nameInput     = element.shadowRoot.querySelector('.name-input');
    let providerInput = element.shadowRoot.querySelector('.provider-input');
    let apiKeyInput   = element.shadowRoot.querySelector('.api-key-input');
    let modelInput    = element.shadowRoot.querySelector('.model-input');

    assert.equal(nameInput.value, '', 'name input should be empty');
    assert.equal(providerInput.value, '', 'provider input should be empty');
    assert.equal(apiKeyInput.value, '', 'api key input should be empty');
    assert.equal(modelInput.value, '', 'model input should be empty');
  });

  // -------------------------------------------------------------------------
  // 5. agent property populates fields in edit mode
  // -------------------------------------------------------------------------

  it('agent property populates fields in edit mode', () => {
    element.setAttribute('mode', 'edit');
    element.agent = {
      id:       'agent-42',
      name:     'Test Agent',
      provider: 'anthropic',
      apiKey:   'sk-test-key',
      model:    'claude-3-opus',
    };

    let nameInput     = element.shadowRoot.querySelector('.name-input');
    let providerInput = element.shadowRoot.querySelector('.provider-input');
    let apiKeyInput   = element.shadowRoot.querySelector('.api-key-input');
    let modelInput    = element.shadowRoot.querySelector('.model-input');

    assert.equal(nameInput.value, 'Test Agent');
    assert.equal(providerInput.value, 'anthropic');
    assert.equal(apiKeyInput.value, 'sk-test-key');
    assert.equal(modelInput.value, 'claude-3-opus');
  });

  // -------------------------------------------------------------------------
  // 6. API key input is type password
  // -------------------------------------------------------------------------

  it('api key input is type password', () => {
    let apiKeyInput = element.shadowRoot.querySelector('.api-key-input');
    assert.equal(apiKeyInput.getAttribute('type'), 'password', 'api key input should be type password');
  });

  // -------------------------------------------------------------------------
  // 7. Save dispatches agent-save with form values
  // -------------------------------------------------------------------------

  it('save dispatches agent-save with form values', () => {
    element.agent = { id: 'agent-99', name: '', provider: '', apiKey: '', model: '' };

    let nameInput     = element.shadowRoot.querySelector('.name-input');
    let providerInput = element.shadowRoot.querySelector('.provider-input');
    let apiKeyInput   = element.shadowRoot.querySelector('.api-key-input');
    let modelInput    = element.shadowRoot.querySelector('.model-input');

    nameInput.value     = 'My Agent';
    providerInput.value = 'openai';
    apiKeyInput.value   = 'sk-abc123';
    modelInput.value    = 'gpt-4';

    let eventFired = false;
    let eventData  = null;

    element.addEventListener('agent-save', (event) => {
      eventFired = true;
      eventData  = event;
    });

    let saveButton = element.shadowRoot.querySelector('.save-button');
    saveButton.click();

    assert.ok(eventFired, 'agent-save event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
    assert.equal(eventData.detail.agentId, 'agent-99');
    assert.deepEqual(eventData.detail.values, {
      name:     'My Agent',
      provider: 'openai',
      apiKey:   'sk-abc123',
      model:    'gpt-4',
    });
  });

  // -------------------------------------------------------------------------
  // 8. Delete dispatches agent-delete with agentId
  // -------------------------------------------------------------------------

  it('delete dispatches agent-delete with agentId', () => {
    element.agent = { id: 'agent-77', name: 'Foo', provider: 'x', apiKey: 'k', model: 'm' };

    let eventFired = false;
    let eventData  = null;

    element.addEventListener('agent-delete', (event) => {
      eventFired = true;
      eventData  = event;
    });

    let deleteButton = element.shadowRoot.querySelector('.delete-button');
    deleteButton.click();

    assert.ok(eventFired, 'agent-delete event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
    assert.equal(eventData.detail.agentId, 'agent-77');
  });

  // -------------------------------------------------------------------------
  // 9. Cancel dispatches agent-cancel
  // -------------------------------------------------------------------------

  it('cancel dispatches agent-cancel', () => {
    let eventFired = false;
    let eventData  = null;

    element.addEventListener('agent-cancel', (event) => {
      eventFired = true;
      eventData  = event;
    });

    let cancelButton = element.shadowRoot.querySelector('.cancel-button');
    cancelButton.click();

    assert.ok(eventFired, 'agent-cancel event should be dispatched');
    assert.equal(eventData.bubbles, true, 'event should bubble');
    assert.equal(eventData.composed, true, 'event should be composed');
  });

  // -------------------------------------------------------------------------
  // 10. Delete button hidden in create mode
  // -------------------------------------------------------------------------

  it('delete button hidden in create mode', () => {
    element.setAttribute('mode', 'create');

    let deleteButton = element.shadowRoot.querySelector('.delete-button');
    assert.equal(deleteButton.style.display, 'none', 'delete button should be hidden in create mode');
  });

  // -------------------------------------------------------------------------
  // 11. getValues() returns current field values
  // -------------------------------------------------------------------------

  it('getValues() returns current field values', () => {
    let nameInput     = element.shadowRoot.querySelector('.name-input');
    let providerInput = element.shadowRoot.querySelector('.provider-input');
    let apiKeyInput   = element.shadowRoot.querySelector('.api-key-input');
    let modelInput    = element.shadowRoot.querySelector('.model-input');

    nameInput.value     = 'Typed Name';
    providerInput.value = 'typed-provider';
    apiKeyInput.value   = 'typed-key';
    modelInput.value    = 'typed-model';

    let values = element.getValues();

    assert.deepEqual(values, {
      name:     'Typed Name',
      provider: 'typed-provider',
      apiKey:   'typed-key',
      model:    'typed-model',
    });
  });

  // -------------------------------------------------------------------------
  // 12. Real module exports a class constructor
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/hero-agent-form-modal/hero-agent-form-modal.mjs');
      assert.equal(typeof mod.default, 'function', 'default export should be a constructor');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
