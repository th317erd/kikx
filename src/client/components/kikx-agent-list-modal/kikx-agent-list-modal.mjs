'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host { display: contents; }

    .agent-list { display: flex; flex-direction: column; gap: var(--spacing-sm, 8px); }

    .agent-card {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      cursor: pointer; transition: background 0.2s ease;
    }

    .agent-card:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

    .agent-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 1rem; color: #fff; flex-shrink: 0;
    }

    .agent-name { flex: 1; font-weight: 500; font-size: 1rem; color: var(--text-primary, #e8e8f0); }

    .settings-button {
      background: none; border: none; font-size: 1.125rem;
      color: var(--text-muted, #606078); cursor: pointer;
      padding: 4px 8px; border-radius: var(--border-radius-small, 4px);
      transition: background 0.2s ease;
    }

    .settings-button:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); color: var(--text-primary, #e8e8f0); }

    .empty-state { text-align: center; padding: 20px; color: var(--text-muted, #606078); font-size: 1rem; }

    .add-button {
      width: 100%; margin-top: var(--spacing-sm, 8px);
      padding: 10px; background: var(--accent-primary, #00e5ff);
      color: #fff; border: none;
      border-radius: var(--border-radius-small, 4px);
      font-weight: 600; font-size: 1rem; cursor: pointer;
      transition: box-shadow 0.2s ease;
    }

    .add-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }
  </style>

  <div class="agent-list"></div>
  <button class="add-button"></button>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxAgentListModal extends HTMLElement {
  static get observedAttributes() { return ['open']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // Create the inner kikx-modal
    this._modal = document.createElement('kikx-modal');
    this._modal.setAttribute('modal-title', t('agent.list.title'));
    this.shadowRoot.appendChild(this._modal);

    // Create the content from template and append into modal
    let content = getTemplate().content.cloneNode(true);
    this._modal.appendChild(content);

    this._agentList = this._modal.querySelector('.agent-list');
    this._addButton = this._modal.querySelector('.add-button');
    this._addButton.textContent = t('agent.list.addButton');

    this._agents = [];

    this._onAgentListClick = this._onAgentListClick.bind(this);
    this._onAddClick       = this._onAddClick.bind(this);
  }

  connectedCallback() {
    this._agentList.addEventListener('click', this._onAgentListClick);
    this._addButton.addEventListener('click', this._onAddClick);
    this._render();
  }

  disconnectedCallback() {
    this._agentList.removeEventListener('click', this._onAgentListClick);
    this._addButton.removeEventListener('click', this._onAddClick);
  }

  attributeChangedCallback(name) {
    if (name === 'open') {
      if (this.hasAttribute('open'))
        this._modal.setAttribute('open', '');
      else
        this._modal.removeAttribute('open');
    }
  }

  // ---------------------------------------------------------------------------
  // Public properties
  // ---------------------------------------------------------------------------

  set agents(value) {
    this._agents = value || [];
    this._render();
  }

  get agents() {
    return this._agents;
  }

  // ---------------------------------------------------------------------------
  // Public methods -- delegate to inner modal
  // ---------------------------------------------------------------------------

  open() {
    this.setAttribute('open', '');
    this._modal.open();
  }

  close() {
    this.removeAttribute('open');
    this._modal.close();
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  _onAgentListClick(event) {
    let target = event.target;

    // Settings gear button
    let settingsButton = target.closest('.settings-button');
    if (settingsButton) {
      let agentID = settingsButton.dataset.agentID;

      this.dispatchEvent(new CustomEvent('edit-agent', {
        bubbles:  true,
        composed: true,
        detail:   { agentID },
      }));

      return;
    }

    // Agent card
    let card = target.closest('.agent-card');
    if (card) {
      let agentID = card.dataset.agentID;

      this.dispatchEvent(new CustomEvent('select-agent', {
        bubbles:  true,
        composed: true,
        detail:   { agentID },
      }));
    }
  }

  _onAddClick() {
    this.dispatchEvent(new CustomEvent('create-agent', {
      bubbles:  true,
      composed: true,
    }));
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _render() {
    if (!this._agentList) return;

    if (this._agents.length === 0) {
      this._agentList.innerHTML = `<div class="empty-state">${t('agent.list.empty')}</div>`;
      return;
    }

    let html = '';

    for (let agent of this._agents) {
      html += `<div class="agent-card" data-agent-id="${agent.id}">`;
      html += `<div class="agent-avatar" style="background-color: ${agent.color}">${agent.initials}</div>`;
      html += `<span class="agent-name">${agent.name}</span>`;
      html += `<button class="settings-button" data-agent-id="${agent.id}">\u2699</button>`;
      html += `</div>`;
    }

    this._agentList.innerHTML = html;
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-agent-list-modal', KikxAgentListModal);

export default KikxAgentListModal;
