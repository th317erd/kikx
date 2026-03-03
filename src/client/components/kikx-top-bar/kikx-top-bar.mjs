'use strict';

import { t } from '../../lib/i18n.mjs';
import { profile } from '../../lib/store.mjs';
import { navigate } from '../../lib/router.mjs';
import store from '../../lib/store.mjs';

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

    .avatar-button {
      background: none;
      border: none;
      padding: 2px;
      cursor: pointer;
      border-radius: 50%;
      transition: box-shadow 0.2s ease;
      line-height: 0;
    }

    .avatar-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    :host([hide-back]) .back-button {
      display: none;
    }
  </style>

  <div class="bar">
    <div class="left-group">
      <button class="back-button" type="button"></button>
      <span class="session-name"></span>
    </div>
    <div class="right-group">
      <button class="avatar-button" type="button">
        <kikx-user-avatar size="32"></kikx-user-avatar>
      </button>
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
    return ['session-name', 'hide-back'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._backButton   = this.shadowRoot.querySelector('.back-button');
    this._sessionName  = this.shadowRoot.querySelector('.session-name');
    this._avatarButton = this.shadowRoot.querySelector('.avatar-button');
    this._avatar       = this.shadowRoot.querySelector('kikx-user-avatar');

    this._onBackClick   = this._onBackClick.bind(this);
    this._onAvatarClick = this._onAvatarClick.bind(this);
    this._onStoreUpdate = this._onStoreUpdate.bind(this);
  }

  connectedCallback() {
    this._render();

    this._backButton.addEventListener('click', this._onBackClick);
    this._avatarButton.addEventListener('click', this._onAvatarClick);

    this._removeStoreListener = store.on('update', this._onStoreUpdate);
  }

  disconnectedCallback() {
    this._backButton.removeEventListener('click', this._onBackClick);
    this._avatarButton.removeEventListener('click', this._onAvatarClick);

    if (this._removeStoreListener) {
      this._removeStoreListener();
      this._removeStoreListener = null;
    }
  }

  attributeChangedCallback() {
    this._updateSessionName();
  }

  _render() {
    this._backButton.textContent = t('topBar.backButton');
    this._updateSessionName();
    this._updateAvatar();
  }

  _updateSessionName() {
    let name = this.getAttribute('session-name');

    if (name)
      this._sessionName.textContent = name;
    else
      this._sessionName.textContent = t('application.title');
  }

  _updateAvatar() {
    let user = profile.getUser();
    if (!user)
      return;

    if (user.email)
      this._avatar.setAttribute('email', user.email);

    if (user.firstName)
      this._avatar.setAttribute('first-name', user.firstName);

    if (user.lastName)
      this._avatar.setAttribute('last-name', user.lastName);

    if (user.avatar)
      this._avatar.setAttribute('avatar-data', user.avatar);
    else
      this._avatar.removeAttribute('avatar-data');
  }

  _onStoreUpdate() {
    this._updateAvatar();
  }

  _onBackClick() {
    navigate('/kikx/');
  }

  _onAvatarClick() {
    navigate('/kikx/settings');
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-top-bar', KikxTopBar);

export default KikxTopBar;
