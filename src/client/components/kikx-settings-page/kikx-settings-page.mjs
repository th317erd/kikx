'use strict';

import { t } from '../../lib/i18n.mjs';
import { navigate } from '../../lib/router.mjs';
import { profile } from '../../lib/store.mjs';
import { clearPersistedAuth, updateProfile } from '../../lib/api.mjs';

const TAB_KEYS = ['profile', 'account', 'apiKeys', 'permissions', 'appearance', 'logout'];

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
      color: var(--text-primary, #e8e8f0);
      max-width: 600px;
    }

    .tab-panel.active {
      display: block;
    }

    .form-group {
      margin-bottom: var(--spacing-md, 16px);
    }

    .form-label {
      display: block;
      font-size: 0.85rem;
      color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-xs, 4px);
    }

    .form-input {
      width: 100%;
      padding: 10px 12px;
      box-sizing: border-box;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s ease;
    }

    .form-input:focus {
      border-color: var(--accent-primary, #00e5ff);
    }

    .form-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .form-button {
      padding: 8px 20px;
      background: var(--accent-primary, #00e5ff);
      color: var(--text-inverse, #0a0a1a);
      border: none;
      border-radius: var(--border-radius-medium, 8px);
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: box-shadow 0.2s ease;
    }

    .form-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    .form-button.danger {
      background: var(--color-error, #ff1744);
      color: #fff;
    }

    .form-button.secondary {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      color: var(--text-primary, #e8e8f0);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    .section-heading {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
      margin: var(--spacing-md, 16px) 0 var(--spacing-sm, 8px);
      padding-bottom: var(--spacing-xs, 4px);
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    .form-hint {
      font-size: 0.8rem;
      color: var(--text-muted, #606078);
      margin-top: 2px;
    }

    .theme-option {
      display: inline-block;
      padding: 8px 16px;
      margin-right: var(--spacing-xs, 4px);
      margin-bottom: var(--spacing-xs, 4px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      cursor: pointer;
      font-size: 0.85rem;
    }

    .theme-option.selected {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.20));
    }

    .empty-state {
      color: var(--text-muted, #606078);
      font-style: italic;
      padding: var(--spacing-md, 16px) 0;
    }

    .avatar-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      margin-bottom: var(--spacing-sm, 8px);
    }

    .email-pending {
      display: none;
      padding: 8px 12px;
      margin-top: var(--spacing-xs, 4px);
      background: rgba(255, 193, 7, 0.12);
      border: 1px solid rgba(255, 193, 7, 0.3);
      border-radius: var(--border-radius-medium, 8px);
      color: #ffc107;
      font-size: 0.8rem;
    }

    .email-pending.visible {
      display: block;
    }

    .logout-description {
      color: var(--text-secondary, #a0a0b8);
      font-size: 0.9rem;
      margin-bottom: var(--spacing-md, 16px);
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

class KikxSettingsPage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._activeTab     = 'profile';
    this._pendingAvatar = null;
    this._originalEmail = null;
    this._onTabClick    = this._onTabClick.bind(this);
    this._onBackClick   = this._onBackClick.bind(this);
  }

  connectedCallback() {
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._backButton   = this.shadowRoot.querySelector('.back-button');
    this._titleElement = this.shadowRoot.querySelector('.settings-title');
    this._tabBar       = this.shadowRoot.querySelector('.tab-bar');
    this._tabContent   = this.shadowRoot.querySelector('.tab-content');

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

    this._tabBar.innerHTML     = '';
    this._tabContent.innerHTML = '';

    for (let key of TAB_KEYS) {
      let button = document.createElement('button');
      button.className   = 'tab-button' + ((key === this._activeTab) ? ' active' : '');
      button.textContent = t('settings.tabs.' + key);
      button.dataset.tab = key;
      this._tabBar.appendChild(button);

      let panel = document.createElement('div');
      panel.className   = 'tab-panel' + ((key === this._activeTab) ? ' active' : '');
      panel.dataset.tab = key;
      this._buildTabContent(key, panel);
      this._tabContent.appendChild(panel);
    }
  }

  _buildTabContent(key, panel) {
    let builder = this._tabBuilders[key];
    if (builder)
      builder.call(this, panel);
  }

  get _tabBuilders() {
    return {
      profile:     this._buildProfileTab,
      account:     this._buildAccountTab,
      apiKeys:     this._buildApiKeysTab,
      permissions: this._buildPermissionsTab,
      appearance:  this._buildAppearanceTab,
      logout:      this._buildLogoutTab,
    };
  }

  _buildProfileTab(panel) {
    let user = profile.getUser() || {};
    this._originalEmail = user.email || '';

    panel.innerHTML = `
      <div class="section-heading">${t('settings.profile.heading')}</div>
      <div class="form-group avatar-group">
        <label class="form-label">${t('settings.profile.avatarLabel')}</label>
        <div class="avatar-row">
          <kikx-user-avatar class="profile-avatar" size="64"
            email="${this._escape(user.email || '')}"
            first-name="${this._escape(user.firstName || '')}"
            last-name="${this._escape(user.lastName || '')}"
            ${user.avatar ? `avatar-data="${this._escape(user.avatar)}"` : ''}
          ></kikx-user-avatar>
          <button class="form-button secondary upload-avatar" type="button">${t('settings.profile.avatarUploadButton')}</button>
          <button class="form-button secondary remove-avatar" type="button">${t('settings.profile.avatarRemoveButton')}</button>
          <input type="file" accept="image/*" class="avatar-file-input" style="display:none" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('settings.profile.displayName')}</label>
        <input class="form-input first-name-input" type="text" value="${this._escape(user.firstName || '')}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t('settings.profile.lastName')}</label>
        <input class="form-input last-name-input" type="text" value="${this._escape(user.lastName || '')}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t('settings.profile.email')}</label>
        <input class="form-input email-input" type="email" value="${this._escape(user.email || '')}" />
        <div class="form-hint">${t('settings.profile.emailHint')}</div>
        <div class="email-pending"></div>
      </div>
      <button class="form-button save-profile" type="button">${t('common.save')}</button>
    `;

    let uploadButton = panel.querySelector('.upload-avatar');
    let removeButton = panel.querySelector('.remove-avatar');
    let fileInput    = panel.querySelector('.avatar-file-input');
    let saveButton   = panel.querySelector('.save-profile');

    uploadButton.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      let file = fileInput.files[0];
      if (!file)
        return;

      let reader = new FileReader();
      reader.onload = () => {
        this._resizeImage(reader.result, 128, (resized) => {
          this._pendingAvatar = resized;
          let avatarElement = panel.querySelector('.profile-avatar');
          avatarElement.setAttribute('avatar-data', resized);
        });
      };
      reader.readAsDataURL(file);
    });

    removeButton.addEventListener('click', () => {
      this._pendingAvatar = '';
      let avatarElement = panel.querySelector('.profile-avatar');
      avatarElement.removeAttribute('avatar-data');
    });

    saveButton.addEventListener('click', async () => {
      let firstName = panel.querySelector('.first-name-input').value.trim();
      let lastName  = panel.querySelector('.last-name-input').value.trim();
      let email     = panel.querySelector('.email-input').value.trim();

      let updates = { firstName, lastName };

      if (this._pendingAvatar !== null)
        updates.avatar = this._pendingAvatar || null;

      if (email !== this._originalEmail) {
        updates.email = email;
        let pendingElement = panel.querySelector('.email-pending');
        pendingElement.textContent = t('settings.profile.emailPending', { email });
        pendingElement.classList.add('visible');
      }

      try {
        let result = await updateProfile(updates);
        let userData = (result && result.data) ? result.data : updates;

        profile.setUser(
          { ...profile.getUser(), ...userData },
          profile.getUser()?.token,
        );

        this._pendingAvatar = null;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Profile update failed:', error);
      }
    });
  }

  _resizeImage(dataURL, maxSize, callback) {
    if (typeof document === 'undefined') {
      callback(dataURL);
      return;
    }

    let image = new Image();
    image.onload = () => {
      let width  = image.width;
      let height = image.height;

      if (width > maxSize || height > maxSize) {
        let ratio = Math.min(maxSize / width, maxSize / height);
        width  = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      let canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;

      let context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);

      callback(canvas.toDataURL('image/png'));
    };

    image.src = dataURL;
  }

  _buildAccountTab(panel) {
    panel.innerHTML = `
      <div class="section-heading">${t('settings.account.passwordHeading')}</div>
      <div class="form-group">
        <label class="form-label">${t('settings.account.currentPassword')}</label>
        <input class="form-input" type="password" />
      </div>
      <div class="form-group">
        <label class="form-label">${t('settings.account.newPassword')}</label>
        <input class="form-input" type="password" />
      </div>
      <div class="form-group">
        <label class="form-label">${t('settings.account.confirmPassword')}</label>
        <input class="form-input" type="password" />
      </div>
      <button class="form-button" type="button">${t('settings.account.changePassword')}</button>
    `;
  }

  _buildApiKeysTab(panel) {
    panel.innerHTML = `
      <div class="section-heading">${t('settings.apiKeys.heading')}</div>
      <div class="empty-state">${t('settings.apiKeys.empty')}</div>
      <button class="form-button" type="button">${t('settings.apiKeys.createButton')}</button>
    `;
  }

  _buildPermissionsTab(panel) {
    panel.innerHTML = `
      <div class="section-heading">${t('settings.permissions.heading')}</div>
      <div class="empty-state">${t('settings.permissions.empty')}</div>
    `;
  }

  _buildAppearanceTab(panel) {
    panel.innerHTML = `
      <div class="section-heading">${t('settings.appearance.themeHeading')}</div>
      <div>
        <span class="theme-option selected">Black Glass</span>
      </div>
      <div class="section-heading">${t('settings.appearance.accentHeading')}</div>
      <div>
        <span class="theme-option selected" style="color: #00e5ff;">Cyan</span>
        <span class="theme-option" style="color: #e040fb;">Purple</span>
        <span class="theme-option" style="color: #00e676;">Green</span>
      </div>
    `;
  }

  _buildLogoutTab(panel) {
    panel.innerHTML = `
      <div class="section-heading">${t('settings.logout.heading')}</div>
      <p class="logout-description">${t('settings.logout.description')}</p>
      <button class="form-button danger logout-action" type="button">${t('settings.logout.button')}</button>
    `;

    panel.querySelector('.logout-action').addEventListener('click', () => {
      clearPersistedAuth();
      profile.logout();
      navigate('/kikx/login');
    });
  }

  _escape(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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
    navigate('/kikx/');
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-settings-page', KikxSettingsPage);

export default KikxSettingsPage;
