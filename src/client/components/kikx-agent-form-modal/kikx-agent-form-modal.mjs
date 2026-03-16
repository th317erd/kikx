'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-agent-form-modal { display: block; }

    kikx-agent-form-modal .form-group { margin-bottom: 12px; }

    kikx-agent-form-modal .form-label {
      display: block; font-size: 1rem; font-weight: 600;
      color: var(--text-secondary, #a0a0b8); margin-bottom: 4px;
    }

    kikx-agent-form-modal .form-input {
      width: 100%; box-sizing: border-box;
      padding: 8px 12px; font-size: 1rem;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-primary, #e8e8f0); outline: none;
      font-family: inherit;
      transition: border-color 0.2s ease;
    }

    kikx-agent-form-modal .form-input:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-agent-form-modal .form-select {
      width: 100%; box-sizing: border-box;
      padding: 8px 12px; font-size: 1rem;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-primary, #e8e8f0); outline: none;
      font-family: inherit;
      transition: border-color 0.2s ease;
      cursor: pointer;
    }

    kikx-agent-form-modal .form-select:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-agent-form-modal .form-select option {
      background: var(--bg-primary, #0a0a1a);
      color: var(--text-primary, #e8e8f0);
    }

    kikx-agent-form-modal .button-row {
      display: flex; gap: var(--spacing-sm, 8px); justify-content: flex-end;
      margin-top: 16px; padding-top: 12px;
      border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-agent-form-modal .save-button {
      background: var(--accent-primary, #00e5ff); color: #fff;
      border: none; border-radius: var(--border-radius-small, 4px);
      padding: 8px 20px; font-weight: 600; font-size: 1rem; cursor: pointer;
    }

    kikx-agent-form-modal .save-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }

    kikx-agent-form-modal .delete-button {
      background: rgba(229, 57, 53, 0.15); color: #ef5350;
      border: 1px solid rgba(229, 57, 53, 0.30);
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-size: 1rem; cursor: pointer;
    }

    kikx-agent-form-modal .delete-button:hover { background: rgba(229, 57, 53, 0.25); }

    kikx-agent-form-modal .cancel-button {
      background: none; border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      color: var(--text-secondary, #a0a0b8);
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-size: 1rem; cursor: pointer;
    }

    kikx-agent-form-modal .cancel-button:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }
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
  <div class="form-group">
    <label class="form-label risk-level-label"></label>
    <select class="form-select risk-level-select">
      <option value=""></option>
      <option value="strict"></option>
      <option value="normal"></option>
      <option value="permissive"></option>
    </select>
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
    this._agent = null;

    this._onSaveClick   = this._onSaveClick.bind(this);
    this._onDeleteClick = this._onDeleteClick.bind(this);
    this._onCancelClick = this._onCancelClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._nameInput        = this.querySelector('.name-input');
      this._providerInput    = this.querySelector('.provider-input');
      this._apiKeyInput      = this.querySelector('.api-key-input');
      this._modelInput       = this.querySelector('.model-input');
      this._riskLevelSelect  = this.querySelector('.risk-level-select');

      this._nameLabel        = this.querySelector('.name-label');
      this._providerLabel    = this.querySelector('.provider-label');
      this._apiKeyLabel      = this.querySelector('.api-key-label');
      this._modelLabel       = this.querySelector('.model-label');
      this._riskLevelLabel   = this.querySelector('.risk-level-label');

      this._saveButton   = this.querySelector('.save-button');
      this._deleteButton = this.querySelector('.delete-button');
      this._cancelButton = this.querySelector('.cancel-button');
    }

    this._nameLabel.textContent      = t('agent.form.nameLabel');
    this._providerLabel.textContent  = t('agent.form.providerLabel');
    this._apiKeyLabel.textContent    = t('agent.form.apiKeyLabel');
    this._modelLabel.textContent     = t('agent.form.modelLabel');
    this._riskLevelLabel.textContent = t('agent.form.riskLevel');

    let options = this._riskLevelSelect.options;
    options[0].textContent = t('agent.form.accountDefault');
    options[1].textContent = t('agent.form.strict');
    options[2].textContent = t('agent.form.normal');
    options[3].textContent = t('agent.form.permissive');

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

    if (!this._nameInput)
      return;

    if (value) {
      this._nameInput.value        = value.name || '';
      this._providerInput.value    = value.provider || '';
      this._apiKeyInput.value      = value.apiKey || '';
      this._modelInput.value       = value.model || '';
      this._riskLevelSelect.value  = value.riskLevel || '';
    } else {
      this._nameInput.value        = '';
      this._providerInput.value    = '';
      this._apiKeyInput.value      = '';
      this._modelInput.value       = '';
      this._riskLevelSelect.value  = '';
    }
  }

  getValues() {
    return {
      name:      this._nameInput.value,
      provider:  this._providerInput.value,
      apiKey:    this._apiKeyInput.value,
      model:     this._modelInput.value,
      riskLevel: this._riskLevelSelect.value,
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
      detail:   { agentID: this._agent?.id, values: this.getValues() },
    }));
  }

  _onDeleteClick() {
    this.dispatchEvent(new CustomEvent('agent-delete', {
      bubbles:  true,
      composed: true,
      detail:   { agentID: this._agent?.id },
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
