'use strict';

const TEMPLATE_HTML = `
  <style>
    kikx-hml-prompt { display: block; padding: 4px 0; }

    kikx-hml-prompt .prompt-label {
      font-size: 1rem; font-weight: 600;
      color: var(--text-secondary, #a0a0b8); margin-bottom: 4px;
    }

    kikx-hml-prompt .prompt-input {
      width: 100%; box-sizing: border-box;
      padding: 6px 10px; font-size: 1rem;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-primary, #e8e8f0); outline: none;
      transition: border-color 0.2s ease;
      font-family: inherit;
    }

    kikx-hml-prompt .prompt-input:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-hml-prompt textarea.prompt-input { resize: vertical; min-height: 60px; }

    /* Custom select dropdown — native <select> options can't be styled */
    kikx-hml-prompt .custom-select {
      position: relative;
      width: 100%;
    }

    kikx-hml-prompt .select-trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      box-sizing: border-box;
      padding: 6px 10px;
      font-size: 1rem;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-primary, #e8e8f0);
      cursor: pointer;
      outline: none;
      transition: border-color 0.2s ease;
      font-family: inherit;
    }

    kikx-hml-prompt .select-trigger:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-hml-prompt .select-trigger .arrow {
      font-size: 0.65rem;
      margin-left: 8px;
      opacity: 0.6;
    }

    kikx-hml-prompt .select-options {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      z-index: 100;
      margin-top: 2px;
      max-height: 200px;
      overflow-y: auto;
      background: var(--surface-elevated, #1a1a2e);
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    kikx-hml-prompt .custom-select.open .select-options {
      display: block;
    }

    kikx-hml-prompt .select-option {
      padding: 6px 10px;
      font-size: 1rem;
      color: var(--text-primary, #e8e8f0);
      cursor: pointer;
      transition: background 0.15s ease;
    }

    kikx-hml-prompt .select-option:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    kikx-hml-prompt .select-option.selected {
      background: var(--accent-primary, #00e5ff);
      color: var(--background-base, #0a0a1a);
    }

    kikx-hml-prompt .checkbox-row, kikx-hml-prompt .radio-row {
      display: flex; align-items: center; gap: var(--spacing-xs, 4px);
      padding: 2px 0; font-size: 1rem; cursor: pointer;
      color: var(--text-primary, #e8e8f0);
    }

    kikx-hml-prompt .checkbox-row label, kikx-hml-prompt .radio-row label {
      cursor: pointer;
      user-select: none;
    }

    kikx-hml-prompt .range-row {
      display: flex; align-items: center; gap: var(--spacing-sm, 8px);
    }

    kikx-hml-prompt .range-value {
      font-size: 1rem; font-weight: 600; min-width: 40px; text-align: right;
      color: var(--accent-primary, #00e5ff);
    }

    kikx-hml-prompt input[type="range"] {
      flex: 1; accent-color: var(--accent-primary, #00e5ff);
    }

    /* Number spinner: hide default browser arrows, add custom styling */
    kikx-hml-prompt input[type="number"] {
      -moz-appearance: textfield;
    }

    kikx-hml-prompt input[type="number"]::-webkit-inner-spin-button,
    kikx-hml-prompt input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    /* Date/time picker: dark theme for picker indicator */
    kikx-hml-prompt input[type="date"],
    kikx-hml-prompt input[type="time"] {
      color-scheme: dark;
    }

    kikx-hml-prompt input[type="date"]::-webkit-calendar-picker-indicator,
    kikx-hml-prompt input[type="time"]::-webkit-calendar-picker-indicator {
      filter: invert(0.7);
      cursor: pointer;
    }

    kikx-hml-prompt input[type="color"] {
      width: 48px; height: 32px; padding: 2px; cursor: pointer;
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      background: transparent;
    }

    /* Scrollbar for select dropdown */
    kikx-hml-prompt .select-options::-webkit-scrollbar { width: 6px; }
    kikx-hml-prompt .select-options::-webkit-scrollbar-track { background: transparent; }
    kikx-hml-prompt .select-options::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    kikx-hml-prompt .select-options::-webkit-scrollbar-button { display: none; }

    /* ===== Answered/readonly: success green ===== */
    kikx-hml-prompt[readonly] {
      pointer-events: none;
    }

    kikx-hml-prompt[readonly] .prompt-label {
      color: #4caf50;
    }

    kikx-hml-prompt[readonly] .prompt-input {
      color: #81c784;
      border-color: rgba(76, 175, 80, 0.40);
      background: rgba(76, 175, 80, 0.08);
      box-shadow: 0 0 6px rgba(76, 175, 80, 0.15);
    }

    kikx-hml-prompt[readonly] textarea.prompt-input {
      color: #81c784;
    }

    kikx-hml-prompt[readonly] .select-trigger {
      color: #81c784;
      border-color: rgba(76, 175, 80, 0.40);
      background: rgba(76, 175, 80, 0.08);
      box-shadow: 0 0 6px rgba(76, 175, 80, 0.15);
      cursor: default;
    }

    kikx-hml-prompt[readonly] .select-trigger .arrow {
      color: #4caf50;
    }

    kikx-hml-prompt[readonly] .checkbox-row,
    kikx-hml-prompt[readonly] .radio-row {
      color: #81c784;
      cursor: default;
    }

    kikx-hml-prompt[readonly] input[type="checkbox"],
    kikx-hml-prompt[readonly] input[type="radio"] {
      accent-color: #4caf50;
    }

    kikx-hml-prompt[readonly] input[type="range"] {
      accent-color: #4caf50;
    }

    kikx-hml-prompt[readonly] .range-value {
      color: #4caf50;
    }

    kikx-hml-prompt[readonly] input[type="color"] {
      border-color: rgba(76, 175, 80, 0.40);
      box-shadow: 0 0 6px rgba(76, 175, 80, 0.15);
    }

    kikx-hml-prompt[readonly] input[type="date"]::-webkit-calendar-picker-indicator,
    kikx-hml-prompt[readonly] input[type="time"]::-webkit-calendar-picker-indicator {
      display: none;
    }
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

// Attributes that drive rendering — changes to any of these re-render the control
const RENDER_ATTRIBUTES = [
  'type', 'name', 'label', 'placeholder', 'value',
  'min', 'max', 'step', 'options', 'required', 'readonly',
  'prompt-id',
];

class KikxHmlPrompt extends HTMLElement {
  static get observedAttributes() {
    return RENDER_ATTRIBUTES;
  }

  constructor() {
    super();
    this._onInputChange = this._onInputChange.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._labelElement = this.querySelector('.prompt-label');
      this._control      = this.querySelector('.prompt-control');
    }

    this._renderControl();
    this._notifyInteractionAncestor();
  }

  disconnectedCallback() {
    this._removeListeners();

    if (this._selectCloseHandler) {
      document.removeEventListener('click', this._selectCloseHandler);
      this._selectCloseHandler = null;
    }
  }

  attributeChangedCallback() {
    if (this.isConnected && this._initialized)
      this._renderControl();
  }

  // ---------------------------------------------------------------------------
  // Backward-compat: config property setter
  // Converts a config object into individual attributes.
  // ---------------------------------------------------------------------------

  get config() {
    return this._readConfig();
  }

  set config(value) {
    if (!value)
      return;

    // Map config keys to attribute names
    if (value.inputType)
      this.setAttribute('type', value.inputType);

    if (value.label)
      this.setAttribute('label', value.label);

    if (value.placeholder)
      this.setAttribute('placeholder', value.placeholder);

    if (value.defaultValue !== undefined)
      this.setAttribute('value', String(value.defaultValue));

    if (value.min !== undefined)
      this.setAttribute('min', String(value.min));

    if (value.max !== undefined)
      this.setAttribute('max', String(value.max));

    if (value.step !== undefined)
      this.setAttribute('step', String(value.step));

    if (value.required)
      this.setAttribute('required', '');

    // Options: array → comma-separated string (for simple values)
    // or store as child <kikx-hml-option> elements
    if (value.options && Array.isArray(value.options)) {
      let hasObjects = value.options.some((opt) => typeof opt === 'object');
      if (hasObjects) {
        // Complex options: create child elements
        this._setChildOptions(value.options);
      } else {
        // Simple strings: comma-separated attribute
        this.setAttribute('options', value.options.join(','));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getName() {
    let name = this.getAttribute('name') || this.getAttribute('prompt-id');
    if (name)
      return name;

    // Fallback: derive a slug from the label so prompts without explicit
    // names still produce meaningful keys in the answers map.
    let label = this.getAttribute('label');
    if (label)
      return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    return '';
  }

  getValue() {
    let input = this._getInputElement();
    if (!input)
      return undefined;

    let inputType = this._getInputType();

    if (inputType === 'checkbox')
      return input.checked;

    if (inputType === 'radio') {
      let checked = this._control.querySelector('input[type="radio"]:checked');
      return (checked) ? checked.value : '';
    }

    return input.value;
  }

  setValue(value) {
    let input = this._getInputElement();
    if (!input)
      return;

    let inputType = this._getInputType();

    if (inputType === 'checkbox') {
      input.checked = !!value;
    } else if (inputType === 'radio') {
      let radios = this._control.querySelectorAll('input[type="radio"]');
      for (let radio of radios)
        radio.checked = (radio.value === value);
    } else {
      input.value = value;
    }

    // Update range display if applicable
    if (inputType === 'range') {
      let display = this._control.querySelector('.range-value');
      if (display)
        display.textContent = value;
    }

    // Update custom select display if applicable
    if (inputType === 'select') {
      let labelSpan = this._control.querySelector('.select-label');
      let options   = this._control.querySelectorAll('.select-option');

      for (let option of options) {
        if (option.dataset.value === String(value)) {
          option.classList.add('selected');
          if (labelSpan)
            labelSpan.textContent = option.textContent;
        } else {
          option.classList.remove('selected');
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: read config from attributes
  // ---------------------------------------------------------------------------

  _getInputType() {
    return this.getAttribute('type') || 'text';
  }

  _readConfig() {
    return {
      inputType:    this._getInputType(),
      label:        this.getAttribute('label') || '',
      placeholder:  this.getAttribute('placeholder') || '',
      defaultValue: this.getAttribute('value') ?? undefined,
      min:          this.getAttribute('min') ?? undefined,
      max:          this.getAttribute('max') ?? undefined,
      step:         this.getAttribute('step') ?? undefined,
      required:     this.hasAttribute('required'),
      options:      this._getOptions(),
    };
  }

  _getOptions() {
    // First: check for child <kikx-hml-option> elements
    let childOptions = this.querySelectorAll('kikx-hml-option');
    if (childOptions.length > 0) {
      let result = [];
      for (let child of childOptions) {
        let value = child.getAttribute('value') || child.textContent.trim();
        let label = child.getAttribute('label') || child.textContent.trim() || value;
        result.push({ label, value });
      }

      return result;
    }

    // Second: parse comma-separated options attribute
    let optionsAttribute = this.getAttribute('options');
    if (optionsAttribute)
      return optionsAttribute.split(',').map((option) => option.trim()).filter(Boolean);

    return [];
  }

  // ---------------------------------------------------------------------------
  // Internal: render
  // ---------------------------------------------------------------------------

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
    if (!this._control)
      return;

    this._removeListeners();
    this._control.innerHTML = '';

    let cfg       = this._readConfig();
    let name      = this.getName();
    let inputType = cfg.inputType;

    // Label
    this._labelElement.textContent = cfg.label || '';

    switch (inputType) {
      case 'text':
      case 'password':
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
    let wrapper       = document.createElement('div');
    wrapper.className = 'custom-select';

    // Hidden input holds the actual value for getValue()
    let hidden  = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = name;

    let trigger       = document.createElement('div');
    trigger.className = 'select-trigger';
    trigger.tabIndex  = 0;

    let labelSpan       = document.createElement('span');
    labelSpan.className = 'select-label';

    let arrow       = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '\u25BC';

    trigger.appendChild(labelSpan);
    trigger.appendChild(arrow);

    let optionsList       = document.createElement('div');
    optionsList.className = 'select-options';

    let options      = cfg.options || [];
    let initialValue = cfg.defaultValue;
    let initialLabel = '';

    for (let opt of options) {
      let label = (typeof opt === 'string') ? opt : (opt.label || opt.value);
      let value = (typeof opt === 'string') ? opt : opt.value;

      let optionElement       = document.createElement('div');
      optionElement.className = 'select-option';
      optionElement.textContent = label;
      optionElement.dataset.value = value;

      if (initialValue !== undefined && value === initialValue) {
        optionElement.classList.add('selected');
        initialLabel = label;
      }

      optionElement.addEventListener('click', () => {
        // Deselect previous
        let previous = optionsList.querySelector('.selected');
        if (previous)
          previous.classList.remove('selected');

        optionElement.classList.add('selected');
        hidden.value = value;
        labelSpan.textContent = label;
        wrapper.classList.remove('open');
        this._onInputChange();
      });

      optionsList.appendChild(optionElement);
    }

    // Set initial state
    if (initialValue !== undefined) {
      hidden.value = initialValue;
      labelSpan.textContent = initialLabel || initialValue;
    } else if (options.length > 0) {
      let firstOption = options[0];
      let firstValue  = (typeof firstOption === 'string') ? firstOption : firstOption.value;
      let firstLabel  = (typeof firstOption === 'string') ? firstOption : (firstOption.label || firstOption.value);
      hidden.value = firstValue;
      labelSpan.textContent = firstLabel;

      let firstElement = optionsList.querySelector('.select-option');
      if (firstElement)
        firstElement.classList.add('selected');
    }

    // Toggle open/close on trigger click
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      wrapper.classList.toggle('open');
    });

    // Close on Escape
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'Escape')
        wrapper.classList.remove('open');
    });

    // Close when clicking outside — use composedPath to cross shadow boundaries
    this._selectCloseHandler = (event) => {
      if (!event.composedPath().includes(wrapper))
        wrapper.classList.remove('open');
    };

    document.addEventListener('click', this._selectCloseHandler);

    wrapper.appendChild(hidden);
    wrapper.appendChild(trigger);
    wrapper.appendChild(optionsList);
    this._control.appendChild(wrapper);
  }

  _renderCheckbox(cfg, name) {
    let label       = document.createElement('label');
    label.className = 'checkbox-row';

    let checkbox  = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = name;

    if (cfg.defaultValue === 'true' || cfg.defaultValue === true)
      checkbox.checked = true;

    let labelText         = document.createElement('span');
    labelText.textContent = cfg.label || '';

    checkbox.addEventListener('change', this._onInputChange);

    label.appendChild(checkbox);
    label.appendChild(labelText);
    this._control.appendChild(label);
  }

  _renderRadio(cfg, name) {
    let options = cfg.options || [];

    for (let opt of options) {
      let labelWrapper       = document.createElement('label');
      labelWrapper.className = 'radio-row';

      let radio  = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;

      let label = (typeof opt === 'string') ? opt : (opt.label || opt.value);
      let value = (typeof opt === 'string') ? opt : opt.value;

      radio.value = value;
      if (cfg.defaultValue === value)
        radio.checked = true;

      let labelText         = document.createElement('span');
      labelText.textContent = label;

      radio.addEventListener('change', this._onInputChange);

      labelWrapper.appendChild(radio);
      labelWrapper.appendChild(labelText);
      this._control.appendChild(labelWrapper);
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

    for (let input of inputs) {
      if (isReadonly) {
        // Don't use disabled — it applies browser-level grey styling that
        // can't be overridden by CSS (especially radio/checkbox).
        // pointer-events:none on kikx-hml-prompt[readonly] blocks mouse interaction;
        // tabIndex=-1 blocks keyboard navigation.
        input.tabIndex = -1;
        input.setAttribute('aria-disabled', 'true');
      } else {
        input.removeAttribute('tabindex');
        input.removeAttribute('aria-disabled');
      }
    }
  }

  _setChildOptions(options) {
    // Remove existing child options
    let existing = this.querySelectorAll('kikx-hml-option');
    for (let child of existing)
      child.remove();

    // Create new child option elements
    for (let opt of options) {
      let child = document.createElement('kikx-hml-option');
      let label = (typeof opt === 'string') ? opt : (opt.label || opt.value);
      let value = (typeof opt === 'string') ? opt : opt.value;

      child.setAttribute('value', value);
      child.setAttribute('label', label);
      this.appendChild(child);
    }
  }

  _notifyInteractionAncestor() {
    // Already-answered prompts (readonly) should NOT show action buttons
    if (this.hasAttribute('readonly'))
      return;

    // Walk up to find the hosting kikx-interaction
    let node = this;

    while (node) {
      if (node.tagName && node.tagName.toLowerCase() === 'kikx-interaction') {
        node.setAttribute('show-actions', '');
        return;
      }

      if (node.parentNode) {
        node = node.parentNode;
      } else {
        break;
      }
    }
  }

  _onInputChange() {
    let name  = this.getName();
    let value = this.getValue();

    this.dispatchEvent(new CustomEvent('prompt-change', {
      bubbles:  true,
      composed: true,
      detail:   { promptID: name, name, value },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-hml-prompt', KikxHmlPrompt);

export default KikxHmlPrompt;
