'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup -- fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/kikx/session/abc',
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
// Mirrors the real component's DOM structure and logic. Uses JSDOM's
// HTMLElement and CustomEvent to avoid ESM module caching issues.
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;
  let JsdomCustomEvent = dom.window.CustomEvent;
  let doc              = dom.window.document;

  class KikxHmlPrompt extends JsdomHTMLElement {
    static get observedAttributes() {
      return ['readonly', 'prompt-id'];
    }

    constructor() {
      super();

      this._config  = null;
      this._onInputChange = this._onInputChange.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <style>
          kikx-hml-prompt { display: block; padding: 4px 0; }

          .prompt-label {
            font-size: 0.8125rem; font-weight: 600;
            color: var(--text-secondary, #a0a0b8); margin-bottom: 4px;
          }

          .prompt-input {
            width: 100%; box-sizing: border-box;
            padding: 6px 10px; font-size: 0.875rem;
            background: var(--input-background, rgba(255, 255, 255, 0.05));
            border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
            border-radius: var(--border-radius-small, 4px);
            color: var(--text-primary, #e8e8f0); outline: none;
            transition: border-color 0.2s ease;
            font-family: inherit;
          }

          .prompt-input:focus {
            border-color: var(--accent-primary, #00e5ff);
            box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
          }

          textarea.prompt-input { resize: vertical; min-height: 60px; }

          select.prompt-input { cursor: pointer; }

          .checkbox-row, .radio-row {
            display: flex; align-items: center; gap: var(--spacing-xs, 4px);
            padding: 2px 0; font-size: 0.875rem; cursor: pointer;
            color: var(--text-primary, #e8e8f0);
          }

          .range-row {
            display: flex; align-items: center; gap: var(--spacing-sm, 8px);
          }

          .range-value {
            font-size: 0.8125rem; font-weight: 600; min-width: 40px; text-align: right;
            color: var(--accent-primary, #00e5ff);
          }

          input[type="range"] {
            flex: 1; accent-color: var(--accent-primary, #00e5ff);
          }

          input[type="color"] {
            width: 48px; height: 32px; padding: 2px; cursor: pointer;
            border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
            border-radius: var(--border-radius-small, 4px);
            background: transparent;
          }

          kikx-hml-prompt[readonly] .prompt-input,
          kikx-hml-prompt[readonly] input { pointer-events: none; opacity: 0.7; }
        </style>

        <div class="prompt-container">
          <div class="prompt-label"></div>
          <div class="prompt-control"></div>
        </div>
      `;

      this._label   = this.querySelector('.prompt-label');
      this._control = this.querySelector('.prompt-control');

      if (this._config)
        this._renderControl();
    }

    get config() {
      return this._config;
    }

    set config(value) {
      this._config = value;
      this._renderControl();
    }

    disconnectedCallback() {
      this._removeListeners();
    }

    attributeChangedCallback(name) {
      if (name === 'readonly')
        this._applyReadonly();
    }

    getValue() {
      let input = this._getInputElement();
      if (!input)
        return undefined;

      if (input.type === 'checkbox')
        return input.checked;

      if (this._config && this._config.inputType === 'radio') {
        let checked = this._control.querySelector('input[type="radio"]:checked');
        return checked ? checked.value : '';
      }

      return input.value;
    }

    setValue(value) {
      let input = this._getInputElement();
      if (!input)
        return;

      if (input.type === 'checkbox') {
        input.checked = !!value;
      } else if (this._config && this._config.inputType === 'radio') {
        let radios = this._control.querySelectorAll('input[type="radio"]');
        for (let radio of radios)
          radio.checked = (radio.value === value);
      } else {
        input.value = value;
      }

      // Update range display if applicable
      if (this._config && this._config.inputType === 'range') {
        let display = this._control.querySelector('.range-value');
        if (display)
          display.textContent = value;
      }
    }

    _getInputElement() {
      if (!this._control)
        return null;

      return this._control.querySelector('input, textarea, select');
    }

    _removeListeners() {
      let inputs = this._control ? this._control.querySelectorAll('input, textarea, select') : [];

      for (let input of inputs) {
        input.removeEventListener('input', this._onInputChange);
        input.removeEventListener('change', this._onInputChange);
      }
    }

    _renderControl() {
      this._removeListeners();
      this._control.innerHTML = '';

      if (!this._config)
        return;

      let cfg  = this._config;
      let name = this.getAttribute('prompt-id') || '';

      // Label
      this._label.textContent = cfg.label || '';

      let inputType = cfg.inputType || 'text';

      switch (inputType) {
        case 'text':
        case 'date':
        case 'time':
        case 'number':
          this._renderSimpleInput(inputType, cfg, name);
          break;
        case 'textarea':
          this._renderTextarea(cfg, name);
          break;
        case 'select':
          this._renderSelect(cfg, name);
          break;
        case 'checkbox':
          this._renderCheckbox(cfg, name);
          break;
        case 'radio':
          this._renderRadio(cfg, name);
          break;
        case 'color':
          this._renderColorInput(cfg, name);
          break;
        case 'range':
          this._renderRange(cfg, name);
          break;
        default:
          this._renderSimpleInput('text', cfg, name);
          break;
      }

      this._applyReadonly();
    }

    _renderSimpleInput(type, cfg, name) {
      let input       = doc.createElement('input');
      input.type      = type;
      input.className = 'prompt-input';
      input.name      = name;

      if (cfg.placeholder)
        input.placeholder = cfg.placeholder;
      if (cfg.defaultValue !== undefined)
        input.value = cfg.defaultValue;
      if (cfg.min !== undefined)
        input.min = cfg.min;
      if (cfg.max !== undefined)
        input.max = cfg.max;
      if (cfg.step !== undefined)
        input.step = cfg.step;

      input.addEventListener('input', this._onInputChange);
      this._control.appendChild(input);
    }

    _renderTextarea(cfg, name) {
      let textarea       = doc.createElement('textarea');
      textarea.className = 'prompt-input';
      textarea.name      = name;

      if (cfg.placeholder)
        textarea.placeholder = cfg.placeholder;
      if (cfg.defaultValue !== undefined)
        textarea.value = cfg.defaultValue;

      textarea.addEventListener('input', this._onInputChange);
      this._control.appendChild(textarea);
    }

    _renderSelect(cfg, name) {
      let select       = doc.createElement('select');
      select.className = 'prompt-input';
      select.name      = name;

      let options = cfg.options || [];
      for (let opt of options) {
        let option       = doc.createElement('option');
        let label        = (typeof opt === 'string') ? opt : (opt.label || opt.value);
        let value        = (typeof opt === 'string') ? opt : opt.value;
        option.value     = value;
        option.textContent = label;
        select.appendChild(option);
      }

      if (cfg.defaultValue !== undefined)
        select.value = cfg.defaultValue;

      select.addEventListener('change', this._onInputChange);
      this._control.appendChild(select);
    }

    _renderCheckbox(cfg, name) {
      let row       = doc.createElement('div');
      row.className = 'checkbox-row';

      let checkbox  = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = name;

      if (cfg.defaultValue)
        checkbox.checked = true;

      let label         = doc.createElement('label');
      label.textContent = cfg.label || '';

      checkbox.addEventListener('change', this._onInputChange);

      row.appendChild(checkbox);
      row.appendChild(label);
      this._control.appendChild(row);
    }

    _renderRadio(cfg, name) {
      let options = cfg.options || [];

      for (let opt of options) {
        let row       = doc.createElement('div');
        row.className = 'radio-row';

        let radio  = doc.createElement('input');
        radio.type = 'radio';
        radio.name = name;

        let label = (typeof opt === 'string') ? opt : (opt.label || opt.value);
        let value = (typeof opt === 'string') ? opt : opt.value;

        radio.value = value;
        if (cfg.defaultValue === value)
          radio.checked = true;

        let labelEl         = doc.createElement('label');
        labelEl.textContent = label;

        radio.addEventListener('change', this._onInputChange);

        row.appendChild(radio);
        row.appendChild(labelEl);
        this._control.appendChild(row);
      }
    }

    _renderColorInput(cfg, name) {
      let input  = doc.createElement('input');
      input.type = 'color';
      input.name = name;

      if (cfg.defaultValue)
        input.value = cfg.defaultValue;

      input.addEventListener('input', this._onInputChange);
      this._control.appendChild(input);
    }

    _renderRange(cfg, name) {
      let row       = doc.createElement('div');
      row.className = 'range-row';

      let input  = doc.createElement('input');
      input.type = 'range';
      input.name = name;

      if (cfg.min !== undefined)
        input.min = cfg.min;
      if (cfg.max !== undefined)
        input.max = cfg.max;
      if (cfg.step !== undefined)
        input.step = cfg.step;

      let initialValue = (cfg.defaultValue !== undefined) ? cfg.defaultValue : input.value;
      input.value = initialValue;

      let display       = doc.createElement('span');
      display.className = 'range-value';
      display.textContent = initialValue;

      input.addEventListener('input', (event) => {
        display.textContent = event.target.value;
        this._onInputChange(event);
      });

      row.appendChild(input);
      row.appendChild(display);
      this._control.appendChild(row);
    }

    _applyReadonly() {
      let isReadonly = this.hasAttribute('readonly');
      let inputs     = this._control.querySelectorAll('input, textarea, select');

      for (let input of inputs)
        input.disabled = isReadonly;
    }

    _onInputChange(_event) {
      let promptID = this.getAttribute('prompt-id') || '';
      let value    = this.getValue();

      this.dispatchEvent(new JsdomCustomEvent('prompt-change', {
        bubbles:  true,
        composed: true,
        detail:   { promptID, value },
      }));
    }
  }

  dom.window.customElements.define('kikx-hml-prompt', KikxHmlPrompt);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-hml-prompt', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-hml-prompt');
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
    let registered = dom.window.customElements.get('kikx-hml-prompt');
    assert.ok(registered, 'kikx-hml-prompt should be registered as a custom element');
  });

  // -------------------------------------------------------------------------
  // 2. Renders template
  // -------------------------------------------------------------------------

  it('renders template', () => {
    assert.ok(element.innerHTML.length > 0, 'element should render its template');
  });

  // -------------------------------------------------------------------------
  // 3. Renders text input from config
  // -------------------------------------------------------------------------

  it('renders text input from config', () => {
    element.config = { inputType: 'text', label: 'Name' };

    let input = element.querySelector('input[type="text"]');
    assert.ok(input, 'should render an <input type="text">');
    assert.ok(input.classList.contains('prompt-input'), 'should have prompt-input class');
  });

  // -------------------------------------------------------------------------
  // 4. Renders textarea from config
  // -------------------------------------------------------------------------

  it('renders textarea from config', () => {
    element.config = { inputType: 'textarea', label: 'Description' };

    let textarea = element.querySelector('textarea');
    assert.ok(textarea, 'should render a <textarea>');
    assert.ok(textarea.classList.contains('prompt-input'), 'should have prompt-input class');
  });

  // -------------------------------------------------------------------------
  // 5. Renders select with options from config
  // -------------------------------------------------------------------------

  it('renders select with options from config', () => {
    element.config = {
      inputType: 'select',
      label: 'Color',
      options: ['Red', 'Green', 'Blue'],
    };

    let select  = element.querySelector('select');
    let options = select.querySelectorAll('option');

    assert.ok(select, 'should render a <select>');
    assert.equal(options.length, 3, 'should have 3 options');
    assert.equal(options[0].value, 'Red');
    assert.equal(options[1].value, 'Green');
    assert.equal(options[2].value, 'Blue');
  });

  // -------------------------------------------------------------------------
  // 6. Renders checkbox from config
  // -------------------------------------------------------------------------

  it('renders checkbox from config', () => {
    element.config = { inputType: 'checkbox', label: 'Agree' };

    let row      = element.querySelector('.checkbox-row');
    let checkbox = row.querySelector('input[type="checkbox"]');
    let label    = row.querySelector('label');

    assert.ok(row, 'should render a .checkbox-row');
    assert.ok(checkbox, 'should contain a checkbox input');
    assert.equal(label.textContent, 'Agree');
  });

  // -------------------------------------------------------------------------
  // 7. Renders radio buttons from config
  // -------------------------------------------------------------------------

  it('renders radio buttons from config', () => {
    element.config = {
      inputType: 'radio',
      label: 'Size',
      options: ['Small', 'Medium', 'Large'],
    };

    let rows = element.querySelectorAll('.radio-row');
    assert.equal(rows.length, 3, 'should render 3 radio rows');

    let radios = element.querySelectorAll('input[type="radio"]');
    assert.equal(radios.length, 3, 'should have 3 radio inputs');
    assert.equal(radios[0].value, 'Small');
    assert.equal(radios[1].value, 'Medium');
    assert.equal(radios[2].value, 'Large');
  });

  // -------------------------------------------------------------------------
  // 8. Renders color input from config
  // -------------------------------------------------------------------------

  it('renders color input from config', () => {
    element.config = { inputType: 'color', label: 'Pick a color', defaultValue: '#ff0000' };

    let input = element.querySelector('input[type="color"]');
    assert.ok(input, 'should render an <input type="color">');
    assert.equal(input.value, '#ff0000');
  });

  // -------------------------------------------------------------------------
  // 9. Renders range with value display from config
  // -------------------------------------------------------------------------

  it('renders range with value display from config', () => {
    element.config = {
      inputType: 'range',
      label: 'Volume',
      min: 0,
      max: 100,
      defaultValue: '50',
    };

    let row     = element.querySelector('.range-row');
    let input   = row.querySelector('input[type="range"]');
    let display = row.querySelector('.range-value');

    assert.ok(row, 'should render a .range-row');
    assert.ok(input, 'should contain a range input');
    assert.equal(display.textContent, '50', 'should display the current value');
  });

  // -------------------------------------------------------------------------
  // 10. Label displays from config.label
  // -------------------------------------------------------------------------

  it('displays label from config.label', () => {
    element.config = { inputType: 'text', label: 'Your Name' };

    let label = element.querySelector('.prompt-label');
    assert.equal(label.textContent, 'Your Name');
  });

  // -------------------------------------------------------------------------
  // 11. Placeholder applies to text input
  // -------------------------------------------------------------------------

  it('applies placeholder to text input', () => {
    element.config = { inputType: 'text', label: 'Name', placeholder: 'Enter name...' };

    let input = element.querySelector('input[type="text"]');
    assert.equal(input.placeholder, 'Enter name...');
  });

  // -------------------------------------------------------------------------
  // 12. getValue() returns current value for text input
  // -------------------------------------------------------------------------

  it('getValue() returns current value for text input', () => {
    element.config = { inputType: 'text', label: 'Name', defaultValue: 'Alice' };

    assert.equal(element.getValue(), 'Alice');
  });

  // -------------------------------------------------------------------------
  // 13. setValue() sets value
  // -------------------------------------------------------------------------

  it('setValue() sets value on the input', () => {
    element.config = { inputType: 'text', label: 'Name' };

    element.setValue('Bob');
    let input = element.querySelector('input[type="text"]');
    assert.equal(input.value, 'Bob');
    assert.equal(element.getValue(), 'Bob');
  });

  // -------------------------------------------------------------------------
  // 14. readonly attribute disables input
  // -------------------------------------------------------------------------

  it('readonly attribute disables the input', () => {
    element.config = { inputType: 'text', label: 'Name' };
    element.setAttribute('readonly', '');

    let input = element.querySelector('input[type="text"]');
    assert.equal(input.disabled, true, 'input should be disabled when readonly');
  });

  // -------------------------------------------------------------------------
  // 15. Dispatches prompt-change event on input change
  // -------------------------------------------------------------------------

  it('dispatches prompt-change event on input change', () => {
    element.setAttribute('prompt-id', 'user-name');
    element.config = { inputType: 'text', label: 'Name' };

    let receivedEvent = null;
    element.addEventListener('prompt-change', (event) => {
      receivedEvent = event;
    });

    let input    = element.querySelector('input[type="text"]');
    input.value  = 'Charlie';

    let inputEvent = new dom.window.Event('input', { bubbles: true });
    input.dispatchEvent(inputEvent);

    assert.ok(receivedEvent, 'prompt-change event should have been dispatched');
    assert.equal(receivedEvent.detail.promptID, 'user-name');
    assert.equal(receivedEvent.detail.value, 'Charlie');
  });
});
