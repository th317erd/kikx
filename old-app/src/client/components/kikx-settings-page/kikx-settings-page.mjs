'use strict';

import { t } from '../../lib/i18n.mjs';
import { BASE_PATH } from '../../lib/config.mjs';
import { navigate } from '../../lib/router.mjs';
import { profile } from '../../lib/store.mjs';
import { clearPersistedAuth, updateProfile, getMe, persistAuth, getAuthToken } from '../../lib/api.mjs';
import { theme } from '../../lib/store.mjs';

const TAB_KEYS = ['profile', 'account', 'permissions', 'appearance', 'logout'];

const TEMPLATE_HTML = `
  <style>
    kikx-settings-page {
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: var(--bg-primary, #0a0a1a);
      color: var(--text-primary, #e8e8f0);
      overflow: hidden;
    }

    kikx-settings-page .top-area {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-settings-page .back-button {
      background: none;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      color: var(--text-primary, #e8e8f0);
      font-size: 1.25rem;
      cursor: pointer;
      padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.2s ease;
    }

    kikx-settings-page .back-button:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.10));
    }

    kikx-settings-page .settings-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
    }

    kikx-settings-page .tab-bar {
      display: flex;
      gap: var(--spacing-xs, 4px);
      padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px) 0;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-settings-page .tab-button {
      background: none;
      border: none;
      color: var(--text-secondary, #a0a0b8);
      padding: var(--spacing-sm, 8px) var(--spacing-sm, 8px);
      cursor: pointer;
      font-size: 1rem;
      border-bottom: 2px solid transparent;
      border-radius: var(--border-radius-small, 4px) var(--border-radius-small, 4px) 0 0;
      transition: color 0.2s ease, border-color 0.2s ease;
    }

    kikx-settings-page .tab-button:hover {
      color: var(--text-primary, #e8e8f0);
      background: var(--glass-hover, rgba(255, 255, 255, 0.10));
    }

    kikx-settings-page .tab-button.active {
      color: var(--accent-primary, #00e5ff);
      border-bottom-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 2px 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-settings-page .tab-content {
      flex: 1;
      overflow: auto;
      padding: var(--spacing-sm, 8px);
    }

    kikx-settings-page .tab-panel {
      display: none;
      color: var(--text-primary, #e8e8f0);
      max-width: 600px;
    }

    kikx-settings-page .tab-panel.active {
      display: block;
    }

    kikx-settings-page .form-group {
      margin-bottom: var(--spacing-md, 16px);
    }

    kikx-settings-page .form-label {
      display: block;
      font-size: 1rem;
      color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-xs, 4px);
    }

    kikx-settings-page .form-input {
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

    kikx-settings-page .form-input:focus {
      border-color: var(--accent-primary, #00e5ff);
    }

    kikx-settings-page .form-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    kikx-settings-page .form-button {
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

    kikx-settings-page .form-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-settings-page .form-button.danger {
      background: var(--color-error, #ff1744);
      color: #fff;
    }

    kikx-settings-page .form-button.secondary {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      color: var(--text-primary, #e8e8f0);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-settings-page .section-heading {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
      margin: var(--spacing-md, 16px) 0 var(--spacing-sm, 8px);
      padding-bottom: var(--spacing-xs, 4px);
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-settings-page .form-hint {
      font-size: 1rem;
      color: var(--text-muted, #606078);
      margin-top: 2px;
    }

    kikx-settings-page .theme-option {
      display: inline-block;
      padding: 8px 16px;
      margin-right: var(--spacing-xs, 4px);
      margin-bottom: var(--spacing-xs, 4px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      cursor: pointer;
      font-size: 1rem;
    }

    kikx-settings-page .theme-option.selected {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.20));
    }

    kikx-settings-page .empty-state {
      color: var(--text-muted, #606078);
      font-style: italic;
      padding: var(--spacing-md, 16px) 0;
    }

    kikx-settings-page .form-select {
      width: 100%;
      padding: 10px 12px;
      box-sizing: border-box;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      font-size: 1rem;
      outline: none;
      cursor: pointer;
      transition: border-color 0.2s ease;
    }

    kikx-settings-page .form-select:focus {
      border-color: var(--accent-primary, #00e5ff);
    }

    kikx-settings-page .form-select option {
      background: var(--bg-primary, #0a0a1a);
      color: var(--text-primary, #e8e8f0);
    }

    kikx-settings-page .form-description {
      color: var(--text-secondary, #a0a0b8);
      font-size: 1rem;
      margin-bottom: var(--spacing-md, 16px);
    }

    kikx-settings-page .save-indicator {
      display: inline-block;
      margin-left: var(--spacing-sm, 8px);
      font-size: 1rem;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    kikx-settings-page .save-indicator.visible {
      opacity: 1;
    }

    kikx-settings-page .save-indicator.success {
      color: var(--color-success, #00e676);
    }

    kikx-settings-page .save-indicator.error {
      color: var(--color-error, #ff1744);
    }

    kikx-settings-page .avatar-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      margin-bottom: var(--spacing-sm, 8px);
    }

    kikx-settings-page .email-pending {
      display: none;
      padding: 8px 12px;
      margin-top: var(--spacing-xs, 4px);
      background: rgba(255, 193, 7, 0.12);
      border: 1px solid rgba(255, 193, 7, 0.3);
      border-radius: var(--border-radius-medium, 8px);
      color: #ffc107;
      font-size: 1rem;
    }

    kikx-settings-page .email-pending.visible {
      display: block;
    }

    kikx-settings-page .logout-description {
      color: var(--text-secondary, #a0a0b8);
      font-size: 1rem;
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
    this._activeTab     = 'profile';
    this._pendingAvatar = null;
    this._originalEmail = null;
    this._onTabClick    = this._onTabClick.bind(this);
    this._onBackClick   = this._onBackClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._backButton   = this.querySelector('.back-button');
      this._titleElement = this.querySelector('.settings-title');
      this._tabBar       = this.querySelector('.tab-bar');
      this._tabContent   = this.querySelector('.tab-content');
    }

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
        await updateProfile(updates);

        // Re-fetch full profile from server (includes avatar data)
        let meResult = await getMe();
        let freshUser = (meResult && meResult.data) ? meResult.data : null;

        if (freshUser) {
          let currentUser = profile.getUser() || {};
          let merged = { ...currentUser, ...freshUser };
          profile.setUser(merged, getAuthToken());
          persistAuth(getAuthToken(), merged);
        }

        this._pendingAvatar = null;
      } catch (error) {
         
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

  _buildPermissionsTab(panel) {
    panel.innerHTML = `
      <div class="section-heading">${t('settings.permissions.heading')}</div>
      <p class="form-description">${t('settings.permissions.description')}</p>
      <div class="form-group">
        <label class="form-label">${t('settings.permissions.riskLevel')}</label>
        <select class="form-select risk-level-select">
          <option value="strict">${t('settings.permissions.strict')} — ${t('settings.permissions.strictDesc')}</option>
          <option value="normal">${t('settings.permissions.normal')} — ${t('settings.permissions.normalDesc')}</option>
          <option value="permissive">${t('settings.permissions.permissive')} — ${t('settings.permissions.permissiveDesc')}</option>
        </select>
        <span class="save-indicator"></span>
      </div>
    `;

    let select    = panel.querySelector('.risk-level-select');
    let indicator = panel.querySelector('.save-indicator');

    // Pre-select from current user profile
    let user = profile.getUser() || {};
    if (user.riskLevel)
      select.value = user.riskLevel;
    else
      select.value = 'normal';

    select.addEventListener('change', async () => {
      let value = select.value;

      try {
        await updateProfile({ riskLevel: value });

        let currentUser = profile.getUser() || {};
        profile.setUser({ ...currentUser, riskLevel: value }, getAuthToken());
        persistAuth(getAuthToken(), { ...currentUser, riskLevel: value });

        indicator.textContent = t('settings.permissions.saved');
        indicator.className   = 'save-indicator visible success';
      } catch (_error) {
        indicator.textContent = t('settings.permissions.error');
        indicator.className   = 'save-indicator visible error';
      }

      setTimeout(() => {
        indicator.classList.remove('visible');
      }, 3000);
    });
  }

  _buildAppearanceTab(panel) {
    let currentAccent = theme.getAccent() || 'cyan';

    let accents = [
      { key: 'cyan',   label: 'Cyan',   color: '#00e5ff' },
      { key: 'purple', label: 'Purple', color: '#b040ff' },
      { key: 'green',  label: 'Green',  color: '#00e676' },
      { key: 'blue',   label: 'Blue',   color: '#448aff' },
      { key: 'pink',   label: 'Pink',   color: '#ff4081' },
      { key: 'orange', label: 'Orange', color: '#ff9100' },
      { key: 'red',    label: 'Red',    color: '#ff1744' },
      { key: 'yellow', label: 'Yellow', color: '#ffea00' },
    ];

    panel.innerHTML = `
      <div class="section-heading">${t('settings.appearance.themeHeading')}</div>
      <div>
        <span class="theme-option selected">Black Glass</span>
      </div>
      <div class="section-heading">${t('settings.appearance.accentHeading')}</div>
      <div class="accent-options">
        ${accents.map((a) => `<span class="theme-option${a.key === currentAccent ? ' selected' : ''}" data-accent="${a.key}" style="color: ${a.color};">${a.label}</span>`).join('\n        ')}
      </div>
    `;

    panel.querySelector('.accent-options').addEventListener('click', (event) => {
      let option = event.target.closest('.theme-option[data-accent]');
      if (!option)
        return;

      let accent = option.dataset.accent;
      theme.setAccent(accent);
      document.documentElement.setAttribute('data-accent', accent);

      // Persist to localStorage
      try {
        localStorage.setItem('kikx_accent', accent);
      } catch (_e) { /* storage unavailable */ }

      // Update selected state
      for (let opt of panel.querySelectorAll('.accent-options .theme-option'))
        opt.classList.toggle('selected', opt.dataset.accent === accent);
    });
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
      navigate(BASE_PATH + '/login');
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
    navigate(BASE_PATH + '/');
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-settings-page', KikxSettingsPage);

export default KikxSettingsPage;
