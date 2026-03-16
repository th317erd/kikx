'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host { display: block; }
    .form-group { margin-bottom: 16px; }
    .form-label { display: block; font-size: 1rem; font-weight: 600; color: var(--text-secondary, #a0a0b8); margin-bottom: 6px; }
    .session-name-input, .agent-select {
      width: 100%; box-sizing: border-box; padding: 10px 14px; font-size: 1rem;
      background: var(--input-background, rgba(255,255,255,0.05));
      border: 1px solid var(--input-border, rgba(255,255,255,0.12));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      outline: none; font-family: inherit;
    }
    .session-name-input:focus, .agent-select:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0,229,255,0.30));
    }
    .agent-select option { background: var(--background-base, #1a1a2e); color: var(--text-primary, #e8e8f0); }
    .button-row { display: flex; gap: var(--spacing-sm, 8px); justify-content: flex-end; }
    .create-button { background: var(--accent-primary, #00e5ff); color: #fff; border: none; border-radius: var(--border-radius-small, 4px); padding: 10px 24px; font-weight: 600; font-size: 1rem; cursor: pointer; }
    .create-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0,229,255,0.40)); }
    .create-button:disabled { opacity: 0.5; cursor: not-allowed; }
    .cancel-button { background: none; border: 1px solid var(--glass-border, rgba(255,255,255,0.10)); color: var(--text-secondary, #a0a0b8); border-radius: var(--border-radius-small, 4px); padding: 10px 20px; font-size: 1rem; cursor: pointer; }
    .cancel-button:hover { background: var(--glass-hover, rgba(255,255,255,0.08)); }
    .no-agents-message { font-size: 0.9rem; color: var(--text-muted, #606078); font-style: italic; padding: 4px 0; }
  </style>

  <div class="form-group">
    <label class="form-label agent-label"></label>
    <select class="agent-select"></select>
    <div class="no-agents-message" style="display:none;"></div>
  </div>
  <div class="form-group">
    <label class="form-label name-label"></label>
    <input class="session-name-input" type="text" />
  </div>
  <div class="button-row">
    <button class="cancel-button"></button>
    <button class="create-button"></button>
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

class KikxCreateSessionModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._agentLabel     = this.shadowRoot.querySelector('.agent-label');
    this._agentSelect    = this.shadowRoot.querySelector('.agent-select');
    this._noAgentsMsg    = this.shadowRoot.querySelector('.no-agents-message');
    this._nameLabel      = this.shadowRoot.querySelector('.name-label');
    this._input          = this.shadowRoot.querySelector('.session-name-input');
    this._createButton   = this.shadowRoot.querySelector('.create-button');
    this._cancelButton   = this.shadowRoot.querySelector('.cancel-button');

    this._agents = [];

    this._agentLabel.textContent     = 'Agent (optional)';
    this._nameLabel.textContent      = 'Session name (optional)';
    this._input.placeholder          = t('session.create.namePlaceholder');
    this._createButton.textContent   = t('session.create.createButton');
    this._cancelButton.textContent   = t('session.create.cancelButton');
    this._noAgentsMsg.textContent    = 'No agents available.';

    this._onInput       = this._onInput.bind(this);
    this._onAgentChange = this._onAgentChange.bind(this);
    this._onCreate      = this._onCreate.bind(this);
    this._onCancel      = this._onCancel.bind(this);
    this._onKeydown     = this._onKeydown.bind(this);
  }

  connectedCallback() {
    this._input.addEventListener('input', this._onInput);
    this._agentSelect.addEventListener('change', this._onAgentChange);
    this._createButton.addEventListener('click', this._onCreate);
    this._cancelButton.addEventListener('click', this._onCancel);
    this._input.addEventListener('keydown', this._onKeydown);
  }

  disconnectedCallback() {
    this._input.removeEventListener('input', this._onInput);
    this._agentSelect.removeEventListener('change', this._onAgentChange);
    this._createButton.removeEventListener('click', this._onCreate);
    this._cancelButton.removeEventListener('click', this._onCancel);
    this._input.removeEventListener('keydown', this._onKeydown);
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  reset() {
    this._input.value = '';
    if (this._agentSelect.options.length > 0)
      this._agentSelect.selectedIndex = 0;

    this._updateCreateState();
  }

  focus() {
    // Focus agent select if agents exist, otherwise focus name input
    if (this._agents.length > 0)
      this._agentSelect.focus();
    else
      this._input.focus();
  }

  set agents(value) {
    this._agents = Array.isArray(value) ? value : [];
    this._renderAgentOptions();
    this._updateCreateState();
  }

  get agents() {
    return this._agents;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _renderAgentOptions() {
    this._agentSelect.innerHTML = '';

    if (this._agents.length === 0) {
      this._agentSelect.style.display = 'none';
      this._noAgentsMsg.style.display = '';
      return;
    }

    this._agentSelect.style.display = '';
    this._noAgentsMsg.style.display = 'none';

    // Add a "None" option so users can create sessions without an agent
    let noneOption = document.createElement('option');
    noneOption.value       = '';
    noneOption.textContent = 'None';
    this._agentSelect.appendChild(noneOption);

    for (let agent of this._agents) {
      let option = document.createElement('option');
      option.value       = agent.id;
      option.textContent = agent.name || agent.id;
      this._agentSelect.appendChild(option);
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  _onInput() {
    this._updateCreateState();
  }

  _onAgentChange() {
    this._updateCreateState();

    // Auto-fill name from agent name if name is empty
    let selectedAgent = this._agents.find((a) => a.id === this._agentSelect.value);
    if (selectedAgent && !this._input.value.trim())
      this._input.value = selectedAgent.name || '';
  }

  _updateCreateState() {
    // Always allow creation — agent is optional
    this._createButton.disabled = false;
  }

  _onCreate() {
    let agentID = this._agentSelect.value || null;
    let name    = this._input.value.trim() || null;

    this.dispatchEvent(new CustomEvent('session-create', {
      bubbles:  true,
      composed: true,
      detail:   { name, agentID },
    }));
  }

  _onCancel() {
    this.dispatchEvent(new CustomEvent('session-cancel', {
      bubbles:  true,
      composed: true,
    }));
  }

  _onKeydown(event) {
    if (event.key === 'Enter')
      this._onCreate();
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-create-session-modal', KikxCreateSessionModal);

export default KikxCreateSessionModal;
