'use strict';

import { t } from '../../lib/i18n.mjs';
import { profile } from '../../lib/store.mjs';
import { navigate } from '../../lib/router.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      height: 52px;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      box-shadow: 0 2px 12px var(--accent-glow, rgba(0, 229, 255, 0.15));
    }

    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 100%;
      padding: 0 var(--spacing-md, 16px);
    }

    .left-group {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
    }

    .right-group {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
    }

    .session-name {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }

    button {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      padding: 6px 12px;
      font-size: 0.85rem;
      cursor: pointer;
      transition: background 0.2s ease, box-shadow 0.2s ease;
    }

    button:hover {
      background: rgba(255, 255, 255, 0.10);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.20));
    }

    .back-button {
      font-size: 1.1rem;
      padding: 4px 8px;
      line-height: 1;
    }

    .new-session-button {
      background: var(--accent-primary, #00e5ff);
      color: var(--text-inverse, #0a0a1a);
      font-weight: 600;
      border-color: transparent;
    }

    .new-session-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40));
    }

    .settings-button {
      font-size: 1.1rem;
      padding: 4px 8px;
      line-height: 1;
    }
  </style>

  <div class="bar">
    <div class="left-group">
      <button class="back-button" type="button"></button>
      <span class="session-name"></span>
    </div>
    <div class="right-group">
      <button class="agents-button" type="button"></button>
      <button class="abilities-button" type="button"></button>
      <button class="new-session-button" type="button"></button>
      <button class="settings-button" type="button"></button>
      <button class="logout-button" type="button"></button>
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

class KikxTopBar extends HTMLElement {
  static get observedAttributes() {
    return ['session-name'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._backButton       = this.shadowRoot.querySelector('.back-button');
    this._sessionName      = this.shadowRoot.querySelector('.session-name');
    this._agentsButton     = this.shadowRoot.querySelector('.agents-button');
    this._abilitiesButton  = this.shadowRoot.querySelector('.abilities-button');
    this._newSessionButton = this.shadowRoot.querySelector('.new-session-button');
    this._settingsButton   = this.shadowRoot.querySelector('.settings-button');
    this._logoutButton     = this.shadowRoot.querySelector('.logout-button');

    this._onBackClick       = this._onBackClick.bind(this);
    this._onAgentsClick     = this._onAgentsClick.bind(this);
    this._onAbilitiesClick  = this._onAbilitiesClick.bind(this);
    this._onNewSessionClick = this._onNewSessionClick.bind(this);
    this._onSettingsClick   = this._onSettingsClick.bind(this);
    this._onLogoutClick     = this._onLogoutClick.bind(this);
  }

  connectedCallback() {
    this._render();

    this._backButton.addEventListener('click', this._onBackClick);
    this._agentsButton.addEventListener('click', this._onAgentsClick);
    this._abilitiesButton.addEventListener('click', this._onAbilitiesClick);
    this._newSessionButton.addEventListener('click', this._onNewSessionClick);
    this._settingsButton.addEventListener('click', this._onSettingsClick);
    this._logoutButton.addEventListener('click', this._onLogoutClick);
  }

  disconnectedCallback() {
    this._backButton.removeEventListener('click', this._onBackClick);
    this._agentsButton.removeEventListener('click', this._onAgentsClick);
    this._abilitiesButton.removeEventListener('click', this._onAbilitiesClick);
    this._newSessionButton.removeEventListener('click', this._onNewSessionClick);
    this._settingsButton.removeEventListener('click', this._onSettingsClick);
    this._logoutButton.removeEventListener('click', this._onLogoutClick);
  }

  attributeChangedCallback() {
    this._updateSessionName();
  }

  _render() {
    this._backButton.textContent       = t('topBar.backButton');
    this._agentsButton.textContent     = t('topBar.agents');
    this._abilitiesButton.textContent  = t('topBar.abilities');
    this._newSessionButton.textContent = t('topBar.newSession');
    this._settingsButton.textContent   = t('topBar.settings');
    this._logoutButton.textContent     = t('topBar.logout');

    this._updateSessionName();
  }

  _updateSessionName() {
    let name = this.getAttribute('session-name');

    if (name) {
      this._sessionName.textContent = name;
    } else {
      this._sessionName.textContent = t('application.title');
    }
  }

  _onBackClick() {
    navigate('/kikx/');
  }

  _onAgentsClick() {
    this.dispatchEvent(new CustomEvent('open-agents-modal', { bubbles: true, composed: true }));
  }

  _onAbilitiesClick() {
    this.dispatchEvent(new CustomEvent('open-abilities-modal', { bubbles: true, composed: true }));
  }

  _onNewSessionClick() {
    this.dispatchEvent(new CustomEvent('create-session', { bubbles: true, composed: true }));
  }

  _onSettingsClick() {
    navigate('/kikx/settings');
  }

  _onLogoutClick() {
    profile.logout();
    navigate('/kikx/login');
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-top-bar', KikxTopBar);

export default KikxTopBar;
