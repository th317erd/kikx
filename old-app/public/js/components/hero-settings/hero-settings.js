'use strict';

/**
 * Hero Settings - User Settings Page Component
 *
 * Tabs:
 * - profile:  Display name, email, member since
 * - account:  Password change
 * - api-keys: Create, list, revoke API keys
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// ============================================================================
// HeroSettings Component
// ============================================================================

export class HeroSettings extends HeroComponent {
  static tagName = 'hero-settings';

  static observedAttributes = ['tab'];

  #activeTab     = 'profile';
  #profile       = null;
  #apiKeys       = [];
  #newKeyVisible = null;

  // ---------------------------------------------------------------------------
  // Shadow DOM
  // ---------------------------------------------------------------------------

  createShadowDOM() {
    return this.attachShadow({ mode: 'open' });
  }

  // ---------------------------------------------------------------------------
  // Attribute Getters
  // ---------------------------------------------------------------------------

  get tab() {
    return this.getAttribute('tab') || 'profile';
  }

  set tab(value) {
    this.setAttribute('tab', value);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  mounted() {
    this.#activeTab = this.tab;
    this._bindForms();
    this._activateTab(this.#activeTab);

    // Listen for viewchange to detect route-driven tab changes
    document.addEventListener('viewchange', (event) => {
      if (event.detail.view !== 'settings')
        return;

      let tab = event.detail.tab || 'profile';
      this._activateTab(tab);
    });
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'tab' && oldValue !== newValue && newValue) {
      this.#activeTab = newValue;
      this._activateTab(newValue);
    }
  }

  // ---------------------------------------------------------------------------
  // Public Methods (called from template data-event-* attributes)
  // ---------------------------------------------------------------------------

  /**
   * Switch to a tab. Called from tab button click events.
   * Reads target tab from event.target.dataset.tab.
   * @param {Event} event
   */
  switchTab(event) {
    let tabName = event.target.dataset.tab;
    if (!tabName)
      return;

    this.#activeTab = tabName;
    this._activateTab(tabName);

    // Update URL without triggering a full navigation
    history.replaceState({}, '', `${this._getBasePath()}/settings/${tabName}`);
  }

  /**
   * Save profile form. Public entry point for profile submission.
   * @param {Event} event
   */
  async saveProfile(event) {
    return this._handleProfileSubmit(event);
  }

  /**
   * Navigate back to sessions list.
   */
  goBack() {
    this.dispatchEvent(new CustomEvent('hero:navigate', {
      detail:   { path: '/' },
      bubbles:  true,
      composed: true,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private: Tab Management
  // ---------------------------------------------------------------------------

  _activateTab(tab) {
    // Update tab button styles
    let tabs = this.shadowRoot.querySelectorAll('[data-tab]');
    for (let tabButton of tabs) {
      tabButton.classList.toggle('active', tabButton.dataset.tab === tab);
    }

    // Update tab panel visibility
    let panels = this.shadowRoot.querySelectorAll('[data-panel]');
    for (let panel of panels) {
      panel.style.display = (panel.dataset.panel === tab) ? 'block' : 'none';
    }

    // Load data for the active tab
    this._loadTabData(tab);
  }

  async _loadTabData(tabName) {
    switch (tabName) {
      case 'profile':
        await this._loadProfile();
        break;
      case 'api-keys':
        await this._loadApiKeys();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Form Bindings
  // ---------------------------------------------------------------------------

  _bindForms() {
    let profileForm = this.shadowRoot.querySelector('#profile-form');
    if (profileForm)
      profileForm.addEventListener('submit', (event) => this._handleProfileSubmit(event));

    let passwordForm = this.shadowRoot.querySelector('#password-form');
    if (passwordForm)
      passwordForm.addEventListener('submit', (event) => this._handlePasswordSubmit(event));

    let apiKeyForm = this.shadowRoot.querySelector('#api-key-form');
    if (apiKeyForm)
      apiKeyForm.addEventListener('submit', (event) => this._handleApiKeySubmit(event));

    let backButton = this.shadowRoot.querySelector('#back-button');
    if (backButton)
      backButton.addEventListener('click', () => this.goBack());
  }

  // ---------------------------------------------------------------------------
  // Private: Profile Tab
  // ---------------------------------------------------------------------------

  async _loadProfile() {
    this._setStatus('profile-status', '');

    try {
      let result = await API.user.profile();
      this.#profile = result;

      let displayNameInput = this.shadowRoot.querySelector('#display-name');
      let emailInput       = this.shadowRoot.querySelector('#email');
      let usernameDisplay  = this.shadowRoot.querySelector('#username-display');
      let memberSince      = this.shadowRoot.querySelector('#member-since');

      if (displayNameInput)
        displayNameInput.value = result.displayName || '';
      if (emailInput)
        emailInput.value = result.email || '';
      if (usernameDisplay)
        usernameDisplay.textContent = result.username || '';
      if (memberSince && result.createdAt)
        memberSince.textContent = new Date(result.createdAt).toLocaleDateString();
    } catch (error) {
      this._setStatus('profile-status', error.message, true);
    }
  }

  async _handleProfileSubmit(event) {
    event.preventDefault();

    let displayName = this.shadowRoot.querySelector('#display-name')?.value?.trim();
    let email       = this.shadowRoot.querySelector('#email')?.value?.trim();

    this._setStatus('profile-status', '');

    try {
      await API.user.updateProfile({ displayName, email });
      this._setStatus('profile-status', 'Profile updated successfully.');
    } catch (error) {
      this._setStatus('profile-status', error.message, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Account Tab (Password)
  // ---------------------------------------------------------------------------

  async _handlePasswordSubmit(event) {
    event.preventDefault();

    let currentPassword = this.shadowRoot.querySelector('#current-password')?.value;
    let newPassword     = this.shadowRoot.querySelector('#new-password')?.value;
    let confirmPassword = this.shadowRoot.querySelector('#confirm-password')?.value;

    this._setStatus('password-status', '');

    if (!currentPassword || !newPassword) {
      this._setStatus('password-status', 'All fields are required.', true);
      return;
    }

    if (newPassword !== confirmPassword) {
      this._setStatus('password-status', 'New passwords do not match.', true);
      return;
    }

    if (newPassword.length < 6) {
      this._setStatus('password-status', 'Password must be at least 6 characters.', true);
      return;
    }

    try {
      let result = await API.user.changePassword({ currentPassword, newPassword });

      // Update stored JWT if server returned a new one
      if (result?.token)
        localStorage.setItem('token', result.token);

      this._setStatus('password-status', 'Password changed successfully.');

      // Clear form
      this.shadowRoot.querySelector('#current-password').value = '';
      this.shadowRoot.querySelector('#new-password').value     = '';
      this.shadowRoot.querySelector('#confirm-password').value = '';
    } catch (error) {
      this._setStatus('password-status', error.message, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: API Keys Tab
  // ---------------------------------------------------------------------------

  async _loadApiKeys() {
    this._setStatus('api-key-status', '');

    try {
      let result = await API.user.apiKeys();
      this.#apiKeys = result.apiKeys || [];
      this._renderApiKeysList();
    } catch (error) {
      this._setStatus('api-key-status', error.message, true);
    }
  }

  async _handleApiKeySubmit(event) {
    event.preventDefault();

    let nameInput = this.shadowRoot.querySelector('#api-key-name');
    let name      = nameInput?.value?.trim();

    if (!name) {
      this._setStatus('api-key-status', 'Key name is required.', true);
      return;
    }

    this._setStatus('api-key-status', '');
    this.#newKeyVisible = null;

    try {
      let result = await API.user.createApiKey({ name });
      this.#newKeyVisible = result.key;
      this._showNewKey(result.key);
      nameInput.value = '';
      await this._loadApiKeys();
    } catch (error) {
      this._setStatus('api-key-status', error.message, true);
    }
  }

  async _revokeApiKey(keyId) {
    this._setStatus('api-key-status', '');

    try {
      await API.user.revokeApiKey(keyId);
      await this._loadApiKeys();
      this._setStatus('api-key-status', 'API key revoked.');
    } catch (error) {
      this._setStatus('api-key-status', error.message, true);
    }
  }

  _renderApiKeysList() {
    let container = this.shadowRoot.querySelector('#api-keys-list');
    if (!container)
      return;

    if (this.#apiKeys.length === 0) {
      container.innerHTML = '<p class="empty-state">No API keys created yet.</p>';
      return;
    }

    let rows = this.#apiKeys.map((key) => {
      let lastUsed = (key.lastUsedAt) ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never';
      let expires  = (key.expiresAt) ? new Date(key.expiresAt).toLocaleDateString() : 'Never';
      let created  = new Date(key.createdAt).toLocaleDateString();

      return `
        <tr>
          <td>${this._escapeHtml(key.name)}</td>
          <td class="mono">${this._escapeHtml(key.prefix)}...</td>
          <td>${created}</td>
          <td>${lastUsed}</td>
          <td>${expires}</td>
          <td>
            <button type="button" class="button button-danger button-sm" data-revoke-id="${key.id}">
              Revoke
            </button>
          </td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table class="api-keys-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key Prefix</th>
            <th>Created</th>
            <th>Last Used</th>
            <th>Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    // Bind revoke buttons
    let revokeButtons = container.querySelectorAll('[data-revoke-id]');
    for (let button of revokeButtons) {
      button.addEventListener('click', () => this._revokeApiKey(parseInt(button.dataset.revokeId, 10)));
    }
  }

  _showNewKey(key) {
    let banner     = this.shadowRoot.querySelector('#new-key-banner');
    let keyDisplay = this.shadowRoot.querySelector('#new-key-value');

    if (banner && keyDisplay) {
      keyDisplay.textContent = key;
      banner.style.display = 'block';

      let copyButton = this.shadowRoot.querySelector('#copy-key-button');
      if (copyButton) {
        copyButton.onclick = () => {
          navigator.clipboard.writeText(key).then(() => {
            copyButton.textContent = 'Copied!';
            setTimeout(() => { copyButton.textContent = 'Copy'; }, 2000);
          });
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Utilities
  // ---------------------------------------------------------------------------

  _getBasePath() {
    let baseHref = document.querySelector('base')?.getAttribute('href') || '';
    return baseHref.replace(/\/$/, '');
  }

  _setStatus(elementId, message, isError = false) {
    let element = this.shadowRoot.querySelector(`#${elementId}`);
    if (!element)
      return;

    element.textContent = message;
    element.className = (isError) ? 'status-message error' : 'status-message success';
  }

  _escapeHtml(text) {
    let div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Register the component
HeroSettings.register();
