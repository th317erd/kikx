'use strict';

import { t } from '../../lib/i18n.mjs';

const TAB_KEYS = ['profile', 'account', 'apiKeys', 'permissions', 'appearance'];

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      color: var(--text-primary, #e8e8f0);
    }

    .panel {
      display: none;
      padding: var(--spacing-sm, 8px);
    }

    .panel[data-active] {
      display: block;
    }

    .panel h2 {
      margin: 0 0 var(--spacing-sm, 8px) 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
    }

    .panel p {
      margin: 0;
      color: var(--text-secondary, #a0a0b8);
      font-size: 1rem;
      line-height: 1.5;
    }
  </style>

  <div class="panel" data-tab="profile">
    <h2 class="panel-heading"></h2>
    <p class="panel-placeholder">Profile settings will appear here.</p>
  </div>
  <div class="panel" data-tab="account">
    <h2 class="panel-heading"></h2>
    <p class="panel-placeholder">Account settings will appear here.</p>
  </div>
  <div class="panel" data-tab="apiKeys">
    <h2 class="panel-heading"></h2>
    <p class="panel-placeholder">API key management will appear here.</p>
  </div>
  <div class="panel" data-tab="permissions">
    <h2 class="panel-heading"></h2>
    <p class="panel-placeholder">Permission settings will appear here.</p>
  </div>
  <div class="panel" data-tab="appearance">
    <h2 class="panel-heading"></h2>
    <p class="panel-placeholder">Appearance settings will appear here.</p>
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

class KikxSettingsTabs extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._panels   = this.shadowRoot.querySelectorAll('.panel');
    this._activeTab = 'profile';
  }

  connectedCallback() {
    this._render();
    this._showTab(this._activeTab);
  }

  get activeTab() {
    return this._activeTab;
  }

  set activeTab(value) {
    this._activeTab = value;
    this._showTab(value);
  }

  _render() {
    for (let key of TAB_KEYS) {
      let panel   = this.shadowRoot.querySelector(`.panel[data-tab="${key}"]`);
      let heading = panel.querySelector('.panel-heading');
      heading.textContent = t(`settings.tabs.${key}`);
    }
  }

  _showTab(tabKey) {
    for (let panel of this._panels) {
      if (panel.getAttribute('data-tab') === tabKey) {
        panel.setAttribute('data-active', '');
      } else {
        panel.removeAttribute('data-active');
      }
    }
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-settings-tabs', KikxSettingsTabs);

export default KikxSettingsTabs;
