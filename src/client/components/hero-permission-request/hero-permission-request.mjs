'use strict';

import { t } from '../../lib/i18n.mjs';

const OPTIONS = [
  { value: 'allow-once',    labelKey: 'permission.allowOnce' },
  { value: 'allow-session', labelKey: 'permission.allowSession' },
  { value: 'allow-always',  labelKey: 'permission.allowAlways' },
  { value: 'deny',          labelKey: 'permission.deny' },
];

const TEMPLATE_HTML = `
  <style>
    :host { display: block; padding: var(--spacing-sm, 8px); }

    .permission-header {
      display: flex; align-items: center; gap: var(--spacing-xs, 4px);
      margin-bottom: var(--spacing-sm, 8px);
      font-weight: 600; font-size: 0.9375rem;
      color: var(--text-primary, #e8e8f0);
    }

    .lightning-icon { font-size: 1.125rem; }

    .permission-description {
      font-size: 0.875rem; color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-sm, 8px); line-height: 1.4;
    }

    .options-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--spacing-sm, 8px); }

    .option-row {
      display: flex; align-items: center; gap: var(--spacing-xs, 4px);
      padding: 6px 8px; border-radius: var(--border-radius-small, 4px);
      cursor: pointer; font-size: 0.875rem; color: var(--text-primary, #e8e8f0);
      transition: background 0.2s ease;
    }

    .option-row:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

    .option-row input[type="radio"] { accent-color: var(--accent-primary, #00e5ff); }

    .submit-button {
      background: var(--accent-primary, #00e5ff); color: var(--bg-primary, #0a0a12);
      border: none; border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-weight: 600; font-size: 0.875rem;
      cursor: pointer; transition: box-shadow 0.2s ease;
    }

    .submit-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }
    .submit-button:disabled { opacity: 0.5; cursor: not-allowed; }

    :host([processed]) .options-list,
    :host([processed]) .submit-button { display: none; }

    .processed-badge {
      display: none; font-size: 0.8125rem; font-weight: 600;
      color: #66bb6a; padding: 4px 0;
    }

    :host([processed]) .processed-badge { display: block; }
  </style>

  <div class="permission-header">
    <span class="lightning-icon">\u26A1</span>
    <span class="title-text"></span>
  </div>
  <div class="permission-description"></div>
  <div class="options-list"></div>
  <button class="submit-button" disabled></button>
  <div class="processed-badge">\u2713 Processed</div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class HeroPermissionRequest extends HTMLElement {
  static get observedAttributes() { return ['processed', 'permission-id']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._titleText      = this.shadowRoot.querySelector('.title-text');
    this._descriptionEl  = this.shadowRoot.querySelector('.permission-description');
    this._optionsList    = this.shadowRoot.querySelector('.options-list');
    this._submitButton   = this.shadowRoot.querySelector('.submit-button');
    this._processedBadge = this.shadowRoot.querySelector('.processed-badge');
    this._selectedValue  = null;

    this._onSubmitClick  = this._onSubmitClick.bind(this);
    this._onOptionChange = this._onOptionChange.bind(this);
  }

  connectedCallback() {
    this._titleText.textContent    = t('permission.title');
    this._submitButton.textContent = t('chat.interaction.submitButton');

    this._renderOptions();
    this._submitButton.addEventListener('click', this._onSubmitClick);
  }

  disconnectedCallback() {
    this._submitButton.removeEventListener('click', this._onSubmitClick);
    this._optionsList.removeEventListener('change', this._onOptionChange);
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  get description() {
    return this._descriptionEl.textContent;
  }

  set description(value) {
    this._descriptionEl.textContent = value || '';
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  _renderOptions() {
    this._optionsList.innerHTML = '';

    for (let option of OPTIONS) {
      let row   = document.createElement('label');
      let radio = document.createElement('input');
      let span  = document.createElement('span');

      row.className  = 'option-row';
      radio.type     = 'radio';
      radio.name     = 'permission-decision';
      radio.value    = option.value;
      span.textContent = t(option.labelKey);

      row.appendChild(radio);
      row.appendChild(span);
      this._optionsList.appendChild(row);
    }

    this._optionsList.addEventListener('change', this._onOptionChange);
  }

  _onOptionChange(event) {
    this._selectedValue = event.target.value;
    this._submitButton.disabled = false;
  }

  _onSubmitClick() {
    if (!this._selectedValue)
      return;

    this.dispatchEvent(new CustomEvent('permission-response', {
      bubbles:  true,
      composed: true,
      detail: {
        permissionId: this.getAttribute('permission-id') || '',
        decision:     this._selectedValue,
      },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('hero-permission-request', HeroPermissionRequest);

export default HeroPermissionRequest;
