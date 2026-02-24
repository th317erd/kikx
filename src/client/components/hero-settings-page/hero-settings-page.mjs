'use strict';

import { t } from '../../lib/i18n.mjs';

const TAB_KEYS = ['profile', 'account', 'apiKeys', 'permissions', 'appearance'];

const TEMPLATE_HTML = `
  <style>
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: var(--bg-primary, #0a0a1a);
      color: var(--text-primary, #e8e8f0);
      overflow: hidden;
    }

    .top-area {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    .back-button {
      background: none;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      color: var(--text-primary, #e8e8f0);
      font-size: 1.25rem;
      cursor: pointer;
      padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.2s ease;
    }

    .back-button:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.10));
    }

    .settings-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
    }

    .tab-bar {
      display: flex;
      gap: var(--spacing-xs, 4px);
      padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px) 0;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    .tab-button {
      background: none;
      border: none;
      color: var(--text-secondary, #a0a0b8);
      padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px);
      cursor: pointer;
      font-size: 0.9rem;
      border-bottom: 2px solid transparent;
      border-radius: var(--border-radius-small, 4px) var(--border-radius-small, 4px) 0 0;
      transition: color 0.2s ease, border-color 0.2s ease;
    }

    .tab-button:hover {
      color: var(--text-primary, #e8e8f0);
      background: var(--glass-hover, rgba(255, 255, 255, 0.10));
    }

    .tab-button.active {
      color: var(--accent-primary, #00e5ff);
      border-bottom-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 2px 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    .tab-content {
      flex: 1;
      overflow: auto;
      padding: var(--spacing-sm, 8px);
    }

    .tab-panel {
      display: none;
      color: var(--text-muted, #606078);
    }

    .tab-panel.active {
      display: block;
    }
  </style>

  <div class="top-area">
    <button class="back-button"></button>
    <span class="settings-title"></span>
  </div>
  <div class="tab-bar"></div>
  <div class="tab-content"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class HeroSettingsPage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._activeTab = 'profile';
    this._onTabClick = this._onTabClick.bind(this);
    this._onBackClick = this._onBackClick.bind(this);
  }

  connectedCallback() {
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._backButton    = this.shadowRoot.querySelector('.back-button');
    this._titleElement  = this.shadowRoot.querySelector('.settings-title');
    this._tabBar        = this.shadowRoot.querySelector('.tab-bar');
    this._tabContent    = this.shadowRoot.querySelector('.tab-content');

    this._render();
    this._backButton.addEventListener('click', this._onBackClick);
    this._tabBar.addEventListener('click', this._onTabClick);
  }

  disconnectedCallback() {
    if (this._backButton)
      this._backButton.removeEventListener('click', this._onBackClick);

    if (this._tabBar)
      this._tabBar.removeEventListener('click', this._onTabClick);
  }

  _render() {
    this._backButton.textContent   = t('topBar.backButton');
    this._titleElement.textContent = t('settings.title');

    this._tabBar.innerHTML    = '';
    this._tabContent.innerHTML = '';

    for (let key of TAB_KEYS) {
      let button = document.createElement('button');
      button.className    = 'tab-button' + ((key === this._activeTab) ? ' active' : '');
      button.textContent  = t('settings.tabs.' + key);
      button.dataset.tab  = key;
      this._tabBar.appendChild(button);

      let panel = document.createElement('div');
      panel.className   = 'tab-panel' + ((key === this._activeTab) ? ' active' : '');
      panel.dataset.tab = key;
      panel.textContent = t('settings.tabs.' + key) + ' settings content';
      this._tabContent.appendChild(panel);
    }
  }

  _onTabClick(event) {
    let button = event.target.closest('.tab-button');
    if (!button) return;

    let tabKey = button.dataset.tab;
    if (tabKey === this._activeTab) return;

    this._activeTab = tabKey;

    for (let btn of this._tabBar.querySelectorAll('.tab-button'))
      btn.classList.toggle('active', btn.dataset.tab === tabKey);

    for (let panel of this._tabContent.querySelectorAll('.tab-panel'))
      panel.classList.toggle('active', panel.dataset.tab === tabKey);
  }

  _onBackClick() {
    this.dispatchEvent(new CustomEvent('navigate', {
      bubbles:  true,
      composed: true,
      detail:   { path: '/hero/' },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('hero-settings-page', HeroSettingsPage);

export default HeroSettingsPage;
