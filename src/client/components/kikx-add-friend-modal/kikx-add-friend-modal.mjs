'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-add-friend-modal {
      display: block;
      min-width: 320px;
    }

    kikx-add-friend-modal .wizard-step {
      display: none;
    }

    kikx-add-friend-modal .wizard-step.active {
      display: block;
    }

    kikx-add-friend-modal .type-selection {
      display: flex;
      gap: var(--spacing-md, 16px);
      justify-content: center;
      padding: var(--spacing-md, 16px) 0;
    }

    kikx-add-friend-modal .type-button {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm, 8px);
      width: 140px;
      height: 120px;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-large, 12px);
      color: var(--text-primary, #e8e8f0);
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
    }

    kikx-add-friend-modal .type-button:hover {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.25));
      background: rgba(255, 255, 255, 0.08);
    }

    kikx-add-friend-modal .type-icon {
      font-size: 2rem;
    }

    kikx-add-friend-modal .step-title {
      font-size: 1rem;
      color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-md, 16px);
    }

    kikx-add-friend-modal .form-group {
      margin-bottom: var(--spacing-md, 16px);
    }

    kikx-add-friend-modal .form-label {
      display: block;
      font-size: 1rem;
      color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-xs, 4px);
    }

    kikx-add-friend-modal .form-input, kikx-add-friend-modal .form-select {
      width: 100%;
      padding: 10px 12px;
      box-sizing: border-box;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s ease;
    }

    kikx-add-friend-modal .form-input:focus, kikx-add-friend-modal .form-select:focus {
      border-color: var(--accent-primary, #00e5ff);
    }

    kikx-add-friend-modal .form-select {
      appearance: none;
      cursor: pointer;
    }

    kikx-add-friend-modal .form-select option {
      background: var(--bg-primary, #0a0a1a);
      color: var(--text-primary, #e8e8f0);
    }

    kikx-add-friend-modal .button-row {
      display: flex;
      gap: var(--spacing-sm, 8px);
      justify-content: flex-end;
      padding-top: var(--spacing-sm, 8px);
    }

    kikx-add-friend-modal .form-button {
      padding: 8px 20px;
      background: var(--accent-primary, #00e5ff);
      color: #fff;
      border: none;
      border-radius: var(--border-radius-medium, 8px);
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: box-shadow 0.2s ease;
    }

    kikx-add-friend-modal .form-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-add-friend-modal .form-button.secondary {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      color: var(--text-primary, #e8e8f0);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-add-friend-modal .form-button.secondary:hover {
      background: rgba(255, 255, 255, 0.10);
      box-shadow: none;
    }
  </style>

  <div class="wizard-step step-type active" data-step="type">
    <div class="step-title"></div>
    <div class="type-selection">
      <button class="type-button agent-type-button" type="button">
        <span class="type-icon">&#129302;</span>
        <span class="type-label agent-type-label"></span>
      </button>
      <button class="type-button user-type-button" type="button">
        <span class="type-icon">&#128100;</span>
        <span class="type-label user-type-label"></span>
      </button>
    </div>
    <div class="button-row">
      <button class="form-button secondary type-cancel-button" type="button"></button>
    </div>
  </div>

  <div class="wizard-step step-agent" data-step="agent">
    <div class="form-group">
      <label class="form-label plugin-label"></label>
      <select class="form-select plugin-select">
        <option value="claude">Claude</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label api-key-label"></label>
      <input class="form-input api-key-input" type="password" />
    </div>
    <div class="form-group">
      <label class="form-label name-label"></label>
      <input class="form-input name-input" type="text" />
    </div>
    <div class="form-group">
      <label class="form-label model-label"></label>
      <select class="form-select model-select">
        <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
        <option value="claude-opus-4-6">Claude Opus 4.6</option>
        <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
      </select>
    </div>
    <div class="button-row">
      <button class="form-button secondary back-button" type="button"></button>
      <button class="form-button secondary cancel-button" type="button"></button>
      <button class="form-button save-button" type="button"></button>
    </div>
  </div>

  <div class="wizard-step step-user" data-step="user">
    <div class="form-group">
      <label class="form-label user-email-label"></label>
      <input class="form-input user-email-input" type="email" />
    </div>
    <div class="form-group">
      <label class="form-label user-name-label"></label>
      <input class="form-input user-name-input" type="text" />
    </div>
    <div class="button-row">
      <button class="form-button secondary back-button" type="button"></button>
      <button class="form-button secondary cancel-button" type="button"></button>
      <button class="form-button invite-button" type="button"></button>
    </div>
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

class KikxAddFriendModal extends HTMLElement {
  constructor() {
    super();
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._steps = {
        type:  this.querySelector('.step-type'),
        agent: this.querySelector('.step-agent'),
        user:  this.querySelector('.step-user'),
      };

      this._currentStep = 'type';

      this._onAgentTypeClick = this._onAgentTypeClick.bind(this);
      this._onUserTypeClick  = this._onUserTypeClick.bind(this);
      this._onBackClick      = this._onBackClick.bind(this);
      this._onCancelClick    = this._onCancelClick.bind(this);
      this._onSaveClick      = this._onSaveClick.bind(this);
      this._onInviteClick    = this._onInviteClick.bind(this);
    }

    this._render();

    this.querySelector('.agent-type-button').addEventListener('click', this._onAgentTypeClick);
    this.querySelector('.user-type-button').addEventListener('click', this._onUserTypeClick);
    this.querySelector('.type-cancel-button').addEventListener('click', this._onCancelClick);

    for (let button of this.querySelectorAll('.back-button'))
      button.addEventListener('click', this._onBackClick);

    for (let button of this.querySelectorAll('.cancel-button'))
      button.addEventListener('click', this._onCancelClick);

    this.querySelector('.save-button').addEventListener('click', this._onSaveClick);
    this.querySelector('.invite-button').addEventListener('click', this._onInviteClick);
  }

  disconnectedCallback() {
    this.querySelector('.agent-type-button').removeEventListener('click', this._onAgentTypeClick);
    this.querySelector('.user-type-button').removeEventListener('click', this._onUserTypeClick);
    this.querySelector('.type-cancel-button').removeEventListener('click', this._onCancelClick);

    for (let button of this.querySelectorAll('.back-button'))
      button.removeEventListener('click', this._onBackClick);

    for (let button of this.querySelectorAll('.cancel-button'))
      button.removeEventListener('click', this._onCancelClick);

    this.querySelector('.save-button').removeEventListener('click', this._onSaveClick);
    this.querySelector('.invite-button').removeEventListener('click', this._onInviteClick);
  }

  reset() {
    this._showStep('type');

    let inputs = this.querySelectorAll('.form-input');
    for (let input of inputs)
      input.value = '';

    let modelSelect = this.querySelector('.model-select');
    if (modelSelect)
      modelSelect.value = 'claude-sonnet-4-6';

    let pluginSelect = this.querySelector('.plugin-select');
    if (pluginSelect)
      pluginSelect.value = 'claude';
  }

  _render() {
    let stepTitle = this.querySelector('.step-title');
    stepTitle.textContent = t('friends.wizard.typeStep');

    this.querySelector('.agent-type-label').textContent    = t('friends.wizard.agentButton');
    this.querySelector('.user-type-label').textContent     = t('friends.wizard.userButton');
    this.querySelector('.type-cancel-button').textContent  = t('friends.wizard.cancelButton');

    // Agent step labels
    this.querySelector('.plugin-label').textContent   = t('friends.wizard.pluginLabel');
    this.querySelector('.api-key-label').textContent  = t('friends.wizard.apiKeyLabel');
    this.querySelector('.name-label').textContent     = t('friends.wizard.nameLabel');
    this.querySelector('.model-label').textContent    = t('agent.form.modelLabel');

    // User step labels
    this.querySelector('.user-email-label').textContent = t('friends.wizard.emailLabel');
    this.querySelector('.user-name-label').textContent  = t('friends.wizard.nameLabel');

    // Buttons
    for (let button of this.querySelectorAll('.back-button'))
      button.textContent = t('friends.wizard.backButton');

    for (let button of this.querySelectorAll('.cancel-button'))
      button.textContent = t('friends.wizard.cancelButton');

    this.querySelector('.save-button').textContent   = t('friends.wizard.saveButton');
    this.querySelector('.invite-button').textContent = t('friends.wizard.inviteButton');
  }

  _showStep(stepName) {
    this._currentStep = stepName;

    for (let [key, element] of Object.entries(this._steps))
      element.classList.toggle('active', key === stepName);
  }

  _onAgentTypeClick() {
    this._showStep('agent');
  }

  _onUserTypeClick() {
    this._showStep('user');
  }

  _onBackClick() {
    this._showStep('type');
  }

  _onCancelClick() {
    this.dispatchEvent(new CustomEvent('friend-cancel', {
      bubbles:  true,
      composed: true,
    }));
  }

  _onSaveClick() {
    let pluginID = this.querySelector('.plugin-select').value;
    let apiKey   = this.querySelector('.api-key-input').value.trim();
    let name     = this.querySelector('.name-input').value.trim();
    let model    = this.querySelector('.model-select').value;

    this.dispatchEvent(new CustomEvent('friend-save', {
      bubbles:  true,
      composed: true,
      detail:   { type: 'agent', pluginID, apiKey, name, model },
    }));
  }

  _onInviteClick() {
    let email = this.querySelector('.user-email-input').value.trim();
    let name  = this.querySelector('.user-name-input').value.trim();

    this.dispatchEvent(new CustomEvent('friend-save', {
      bubbles:  true,
      composed: true,
      detail:   { type: 'user', email, name },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-add-friend-modal', KikxAddFriendModal);

export default KikxAddFriendModal;
