'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host { display: block; }

    .form-group { margin-bottom: 12px; }

    .form-label {
      display: block; font-size: 1rem; font-weight: 600;
      color: var(--text-secondary, #a0a0b8); margin-bottom: 4px;
    }

    .form-input {
      width: 100%; box-sizing: border-box;
      padding: 8px 12px; font-size: 1rem;
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
      background: var(--accent-primary, #00e5ff); color: #fff;
      border: none; border-radius: var(--border-radius-small, 4px);
      padding: 8px 20px; font-weight: 600; font-size: 1rem; cursor: pointer;
    }

    .save-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }

    .delete-button {
      background: rgba(229, 57, 53, 0.15); color: #ef5350;
      border: 1px solid rgba(229, 57, 53, 0.30);
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-size: 1rem; cursor: pointer;
    }

    .delete-button:hover { background: rgba(229, 57, 53, 0.25); }

    .cancel-button {
      background: none; border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      color: var(--text-secondary, #a0a0b8);
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-size: 1rem; cursor: pointer;
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

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxAgentFormModal extends HTMLElement {
  static get observedAttributes() { return ['mode']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

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
    this._nameLabel.textContent     = t('agent.form.nameLabel');
    this._providerLabel.textContent = t('agent.form.providerLabel');
    this._apiKeyLabel.textContent   = t('agent.form.apiKeyLabel');
    this._modelLabel.textContent    = t('agent.form.modelLabel');

    this._saveButton.textContent   = t('agent.form.saveButton');
    this._deleteButton.textContent = t('agent.form.deleteButton');
    this._cancelButton.textContent = t('agent.form.cancelButton');

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
    this.dispatchEvent(new CustomEvent('agent-save', {
      bubbles:  true,
      composed: true,
      detail:   { agentId: this._agent?.id, values: this.getValues() },
    }));
  }

  _onDeleteClick() {
    this.dispatchEvent(new CustomEvent('agent-delete', {
      bubbles:  true,
      composed: true,
      detail:   { agentId: this._agent?.id },
    }));
  }

  _onCancelClick() {
    this.dispatchEvent(new CustomEvent('agent-cancel', {
      bubbles:  true,
      composed: true,
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-agent-form-modal', KikxAgentFormModal);

export default KikxAgentFormModal;
