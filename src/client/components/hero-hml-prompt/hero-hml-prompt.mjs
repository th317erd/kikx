'use strict';

const TEMPLATE_HTML = `
  <style>
    :host { display: block; padding: 4px 0; }

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

    :host([readonly]) .prompt-input,
    :host([readonly]) input { pointer-events: none; opacity: 0.7; }
  </style>

  <div class="prompt-container">
    <div class="prompt-label"></div>
    <div class="prompt-control"></div>
  </div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class HeroHmlPrompt extends HTMLElement {
  static get observedAttributes() {
    return ['readonly', 'prompt-id'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._label   = this.shadowRoot.querySelector('.prompt-label');
    this._control = this.shadowRoot.querySelector('.prompt-control');
    this._config  = null;

    this._onInputChange = this._onInputChange.bind(this);
  }

  get config() {
    return this._config;
  }

  set config(value) {
    this._config = value;
    this._renderControl();
  }

  connectedCallback() {
    if (this._config)
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
    let input       = document.createElement('input');
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
    let textarea       = document.createElement('textarea');
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
    let select       = document.createElement('select');
    select.className = 'prompt-input';
    select.name      = name;

    let options = cfg.options || [];
    for (let opt of options) {
      let option       = document.createElement('option');
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
    let row       = document.createElement('div');
    row.className = 'checkbox-row';

    let checkbox  = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = name;

    if (cfg.defaultValue)
      checkbox.checked = true;

    let label         = document.createElement('label');
    label.textContent = cfg.label || '';

    checkbox.addEventListener('change', this._onInputChange);

    row.appendChild(checkbox);
    row.appendChild(label);
    this._control.appendChild(row);
  }

  _renderRadio(cfg, name) {
    let options = cfg.options || [];

    for (let opt of options) {
      let row       = document.createElement('div');
      row.className = 'radio-row';

      let radio  = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;

      let label = (typeof opt === 'string') ? opt : (opt.label || opt.value);
      let value = (typeof opt === 'string') ? opt : opt.value;

      radio.value = value;
      if (cfg.defaultValue === value)
        radio.checked = true;

      let labelEl         = document.createElement('label');
      labelEl.textContent = label;

      radio.addEventListener('change', this._onInputChange);

      row.appendChild(radio);
      row.appendChild(labelEl);
      this._control.appendChild(row);
    }
  }

  _renderColorInput(cfg, name) {
    let input  = document.createElement('input');
    input.type = 'color';
    input.name = name;

    if (cfg.defaultValue)
      input.value = cfg.defaultValue;

    input.addEventListener('input', this._onInputChange);
    this._control.appendChild(input);
  }

  _renderRange(cfg, name) {
    let row       = document.createElement('div');
    row.className = 'range-row';

    let input  = document.createElement('input');
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

    let display       = document.createElement('span');
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

  _onInputChange(event) {
    let promptId = this.getAttribute('prompt-id') || '';
    let value    = this.getValue();

    this.dispatchEvent(new CustomEvent('prompt-change', {
      bubbles:  true,
      composed: true,
      detail:   { promptId, value },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('hero-hml-prompt', HeroHmlPrompt);

export default HeroHmlPrompt;
