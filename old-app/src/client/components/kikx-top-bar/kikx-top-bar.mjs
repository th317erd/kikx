'use strict';

import { t } from '../../lib/i18n.mjs';
import { BASE_PATH } from '../../lib/config.mjs';
import { profile } from '../../lib/store.mjs';
import { navigate } from '../../lib/router.mjs';
import store from '../../lib/store.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-top-bar {
      display: block;
      height: 52px;
      position: relative;
      background:
        linear-gradient(90deg,
          rgba(176, 64, 255, 0.06) 0%,
          rgba(0, 229, 255, 0.04) 50%,
          rgba(255, 64, 129, 0.05) 100%),
        var(--glass-background, rgba(255, 255, 255, 0.05));
      background-size: 200% 100%, 100% 100%;
      animation: topbar-breathe 80s ease-in-out infinite;
      backdrop-filter: blur(var(--glass-blur, 16px));
      -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
      border-bottom: none;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }

    @keyframes topbar-breathe {
      0%   { background-position: 0% 50%, 0% 0%; }
      50%  { background-position: 100% 50%, 0% 0%; }
      100% { background-position: 0% 50%, 0% 0%; }
    }

    kikx-top-bar::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg,
        #ff4081, #b040ff, #448aff, #00e5ff, #00e676, #ffea00, #ff9100, #ff4081,
        #b040ff, #448aff, #00e5ff, #00e676, #ffea00, #ff9100, #ff4081);
      background-size: 200% 100%;
      animation: rainbow-scroll 60s linear infinite;
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.3), 0 0 20px rgba(176, 64, 255, 0.15);
    }

    @keyframes rainbow-scroll {
      to { background-position: -200% 0; }
    }

    kikx-top-bar .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 100%;
      padding: 0 var(--spacing-md, 16px);
    }

    kikx-top-bar .left-group {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
    }

    kikx-top-bar .right-group {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
    }

    kikx-top-bar .app-logo {
      height: 28px;
      width: auto;
      display: none;
    }

    kikx-top-bar .app-logo.visible {
      display: block;
    }

    kikx-top-bar .session-name {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
    }

    kikx-top-bar button {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      padding: 6px 12px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s ease, box-shadow 0.2s ease;
    }

    kikx-top-bar button:hover {
      background: rgba(255, 255, 255, 0.10);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.20));
    }

    kikx-top-bar .back-button {
      font-size: 1.1rem;
      padding: 4px 8px;
      line-height: 1;
    }

    kikx-top-bar .avatar-button {
      background: none;
      border: none;
      padding: 2px;
      cursor: pointer;
      border-radius: 50%;
      transition: box-shadow 0.2s ease;
      line-height: 0;
    }

    kikx-top-bar .avatar-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-top-bar[hide-back] .back-button {
      display: none;
    }
  </style>

  <div class="bar">
    <div class="left-group">
      <button class="back-button" type="button"></button>
      <img class="app-logo" alt="Kikx" />
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
    this._onBackClick   = this._onBackClick.bind(this);
    this._onAvatarClick = this._onAvatarClick.bind(this);
    this._onStoreUpdate = this._onStoreUpdate.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._backButton   = this.querySelector('.back-button');
      this._appLogo      = this.querySelector('.app-logo');
      this._sessionName  = this.querySelector('.session-name');
      this._avatarButton = this.querySelector('.avatar-button');
      this._avatar       = this.querySelector('kikx-user-avatar');
    }

    this._render();

    this._backButton.addEventListener('click', this._onBackClick);
    this._avatarButton.addEventListener('click', this._onAvatarClick);

    store.on('update', this._onStoreUpdate);
  }

  disconnectedCallback() {
    this._backButton.removeEventListener('click', this._onBackClick);
    this._avatarButton.removeEventListener('click', this._onAvatarClick);
    store.off('update', this._onStoreUpdate);
  }

  attributeChangedCallback() {
    this._updateSessionName();
  }

  _render() {
    this._backButton.textContent = t('topBar.backButton');
    this._appLogo.src = BASE_PATH + '/assets/images/kikx-cape.svg';
    this._updateSessionName();
    this._updateAvatar();
  }

  _updateSessionName() {
    if (!this._sessionName)
      return;

    let name = this.getAttribute('session-name');

    if (name) {
      this._sessionName.textContent = name;
      this._appLogo.classList.remove('visible');
    } else {
      this._sessionName.textContent = t('application.title');
      this._appLogo.classList.add('visible');
    }
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
    navigate(BASE_PATH + '/');
  }

  _onAvatarClick() {
    navigate(BASE_PATH + '/settings');
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-top-bar', KikxTopBar);

export default KikxTopBar;
