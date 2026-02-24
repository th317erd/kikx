'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host { display: block; }

    .tabs {
      display: flex; gap: 0;
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      margin-bottom: 12px;
    }

    .tab-button {
      background: none; border: none;
      padding: 8px 16px; font-size: 0.875rem;
      color: var(--text-muted, #606078);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.2s ease;
    }

    .tab-button.active {
      color: var(--accent-primary, #00e5ff);
      border-bottom-color: var(--accent-primary, #00e5ff);
    }

    .tab-button:hover { color: var(--text-primary, #e8e8f0); }

    .ability-list { display: flex; flex-direction: column; gap: var(--spacing-sm, 8px); }

    .ability-card {
      padding: 10px 12px;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      cursor: pointer; transition: background 0.2s ease;
    }

    .ability-card:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

    .ability-name {
      font-weight: 600; font-size: 0.9375rem;
      color: var(--text-primary, #e8e8f0);
    }

    .category-badge {
      display: inline-block; padding: 1px 8px;
      border-radius: 3px; font-size: 0.7rem;
      font-weight: 600; text-transform: uppercase;
      background: rgba(0, 229, 255, 0.15);
      color: var(--accent-primary, #00e5ff);
      margin-left: 8px;
    }

    .ability-description {
      font-size: 0.8125rem;
      color: var(--text-secondary, #a0a0b8);
      margin-top: 4px; line-height: 1.4;
    }

    .empty-state {
      text-align: center; padding: 20px;
      color: var(--text-muted, #606078);
      font-size: 0.875rem;
    }

    .add-button {
      width: 100%; margin-top: var(--spacing-sm, 8px);
      padding: 10px; background: var(--accent-primary, #00e5ff);
      color: var(--bg-primary, #0a0a12); border: none;
      border-radius: var(--border-radius-small, 4px);
      font-weight: 600; font-size: 0.875rem; cursor: pointer;
    }

    .add-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }

    .tab-content { display: none; }
    .tab-content.active { display: block; }
  </style>

  <div class="tabs">
    <button class="tab-button system-tab active" data-tab="system"></button>
    <button class="tab-button user-tab" data-tab="user"></button>
  </div>
  <div class="tab-content system-content active">
    <div class="ability-list system-list"></div>
  </div>
  <div class="tab-content user-content">
    <div class="ability-list user-list"></div>
    <button class="add-button"></button>
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

class HeroAbilityListModal extends HTMLElement {
  static get observedAttributes() { return ['open']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // Create the inner hero-modal
    this._modal = document.createElement('hero-modal');
    this._modal.setAttribute('modal-title', t('ability.list.title'));
    this.shadowRoot.appendChild(this._modal);

    // Create the content from template and append into modal
    let content = getTemplate().content.cloneNode(true);
    this._modal.appendChild(content);

    this._systemTab    = this._modal.querySelector('.system-tab');
    this._userTab      = this._modal.querySelector('.user-tab');
    this._systemContent = this._modal.querySelector('.system-content');
    this._userContent  = this._modal.querySelector('.user-content');
    this._systemList   = this._modal.querySelector('.system-list');
    this._userList     = this._modal.querySelector('.user-list');
    this._addButton    = this._modal.querySelector('.add-button');

    this._systemTab.textContent = t('ability.list.title');
    this._userTab.textContent   = t('ability.list.myAbilitiesTab');
    this._addButton.textContent = t('ability.list.addButton');

    this._abilities = { system: [], user: [] };

    this._onTabClick       = this._onTabClick.bind(this);
    this._onSystemListClick = this._onSystemListClick.bind(this);
    this._onUserListClick  = this._onUserListClick.bind(this);
    this._onAddClick       = this._onAddClick.bind(this);
  }

  connectedCallback() {
    this._systemTab.addEventListener('click', this._onTabClick);
    this._userTab.addEventListener('click', this._onTabClick);
    this._systemList.addEventListener('click', this._onSystemListClick);
    this._userList.addEventListener('click', this._onUserListClick);
    this._addButton.addEventListener('click', this._onAddClick);
    this._render();
  }

  disconnectedCallback() {
    this._systemTab.removeEventListener('click', this._onTabClick);
    this._userTab.removeEventListener('click', this._onTabClick);
    this._systemList.removeEventListener('click', this._onSystemListClick);
    this._userList.removeEventListener('click', this._onUserListClick);
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

  set abilities(value) {
    this._abilities = value || { system: [], user: [] };
    this._render();
  }

  get abilities() {
    return this._abilities;
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

  _onTabClick(event) {
    let tab = event.target.dataset.tab;

    if (tab === 'system') {
      this._systemTab.classList.add('active');
      this._userTab.classList.remove('active');
      this._systemContent.classList.add('active');
      this._userContent.classList.remove('active');
    } else if (tab === 'user') {
      this._userTab.classList.add('active');
      this._systemTab.classList.remove('active');
      this._userContent.classList.add('active');
      this._systemContent.classList.remove('active');
    }
  }

  _onSystemListClick(event) {
    this._handleAbilityClick(event);
  }

  _onUserListClick(event) {
    this._handleAbilityClick(event);
  }

  _handleAbilityClick(event) {
    let card = event.target.closest('.ability-card');
    if (card) {
      let abilityId = card.dataset.abilityId;

      this.dispatchEvent(new CustomEvent('select-ability', {
        bubbles:  true,
        composed: true,
        detail:   { abilityId },
      }));
    }
  }

  _onAddClick() {
    this.dispatchEvent(new CustomEvent('create-ability', {
      bubbles:  true,
      composed: true,
    }));
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _render() {
    if (!this._systemList || !this._userList) return;

    this._renderList(this._systemList, this._abilities.system);
    this._renderList(this._userList, this._abilities.user);
  }

  _renderList(container, abilities) {
    if (!abilities || abilities.length === 0) {
      container.innerHTML = '<div class="empty-state">No abilities available.</div>';
      return;
    }

    let html = '';

    for (let ability of abilities) {
      html += `<div class="ability-card" data-ability-id="${ability.id}">`;
      html += `<div class="ability-card-header">`;
      html += `<span class="ability-name">${ability.name}</span>`;
      html += `<span class="category-badge">${ability.category}</span>`;
      html += `</div>`;
      html += `<div class="ability-description">${ability.description}</div>`;
      html += `</div>`;
    }

    container.innerHTML = html;
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('hero-ability-list-modal', HeroAbilityListModal);

export default HeroAbilityListModal;
