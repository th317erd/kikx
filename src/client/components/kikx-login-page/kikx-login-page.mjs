'use strict';

import { t } from '../../lib/i18n.mjs';
import { profile } from '../../lib/store.mjs';
import { navigate } from '../../lib/router.mjs';
import { sendMagicLink, setAuthToken } from '../../lib/api.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      min-height: 100vh;
      background: var(--background-base, #0a0a1a);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-md, 16px);
    }

    .login-card {
      width: 100%;
      max-width: 400px;
      padding: var(--spacing-xl, 32px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-large, 12px);
      box-shadow: 0 0 24px var(--accent-glow, rgba(0, 229, 255, 0.30));
      text-align: center;
    }

    .title {
      font-size: 2.5rem;
      font-weight: 700;
      color: var(--accent-primary, #00e5ff);
      margin-bottom: var(--spacing-xs, 4px);
      letter-spacing: 0.05em;
    }

    .subtitle {
      font-size: 0.95rem;
      color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-xl, 32px);
    }

    form {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md, 16px);
    }

    .email-input {
      width: 100%;
      padding: 12px 16px;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .email-input::placeholder {
      color: var(--input-placeholder, var(--text-muted, #606078));
    }

    .email-input:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    .submit-button {
      width: 100%;
      padding: 12px 16px;
      background: var(--accent-primary, #00e5ff);
      color: var(--text-inverse, #0a0a1a);
      border: none;
      border-radius: var(--border-radius-medium, 8px);
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: box-shadow 0.2s ease, opacity 0.2s ease;
    }

    .submit-button:hover:not(:disabled) {
      box-shadow: 0 0 16px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    .submit-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .status-message {
      display: none;
      font-size: 0.875rem;
      margin-top: var(--spacing-sm, 8px);
      min-height: 1.25em;
    }

    .status-message.visible {
      display: block;
    }

    .status-message.error {
      color: var(--color-error, #ff1744);
    }

    .status-message.success {
      color: var(--color-success, #00e676);
    }
  </style>

  <div class="login-card">
    <div class="title"></div>
    <div class="subtitle"></div>
    <form>
      <input class="email-input" type="email" autocomplete="email" />
      <button class="submit-button" type="submit"></button>
    </form>
    <div class="status-message"></div>
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

class KikxLoginPage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._emailInput      = this.shadowRoot.querySelector('.email-input');
    this._submitButton    = this.shadowRoot.querySelector('.submit-button');
    this._statusMessage   = this.shadowRoot.querySelector('.status-message');
    this._titleElement    = this.shadowRoot.querySelector('.title');
    this._subtitleElement = this.shadowRoot.querySelector('.subtitle');
    this._form            = this.shadowRoot.querySelector('form');

    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    this._render();
    this._form.addEventListener('submit', this._onSubmit);
  }

  disconnectedCallback() {
    this._form.removeEventListener('submit', this._onSubmit);
  }

  _render() {
    this._titleElement.textContent    = t('application.title');
    this._subtitleElement.textContent = t('login.subtitle');
    this._emailInput.placeholder      = t('login.emailPlaceholder');
    this._submitButton.textContent    = t('login.submitButton');
  }

  _showError(message) {
    this._statusMessage.textContent = message;
    this._statusMessage.className   = 'status-message visible error';
  }

  _showSuccess(message) {
    this._statusMessage.textContent = message;
    this._statusMessage.className   = 'status-message visible success';
  }

  _hideStatus() {
    this._statusMessage.textContent = '';
    this._statusMessage.className   = 'status-message';
  }

  _setLoading(loading) {
    this._submitButton.disabled    = loading;
    this._submitButton.textContent = (loading) ? t('login.loading') : t('login.submitButton');
  }

  async _onSubmit(event) {
    event.preventDefault();
    this._hideStatus();

    let email = this._emailInput.value.trim();

    if (!email) {
      this._showError(t('login.error.emailRequired'));
      return;
    }

    this._setLoading(true);

    try {
      let result       = await sendMagicLink(email);
      let sessionToken = result.data.sessionToken;

      setAuthToken(sessionToken);
      profile.setUser({ email }, sessionToken);
      navigate('/kikx/', { replace: true });
    } catch (error) {
      let message = (error && error.body && error.body.message)
        ? error.body.message
        : t('login.error.generic');

      this._showError(message);
      this._setLoading(false);
    }
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-login-page', KikxLoginPage);

export default KikxLoginPage;
