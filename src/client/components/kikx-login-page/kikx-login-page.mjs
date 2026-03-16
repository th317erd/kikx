'use strict';

import { t } from '../../lib/i18n.mjs';
import { BASE_PATH } from '../../lib/config.mjs';
import { profile } from '../../lib/store.mjs';
import { navigate } from '../../lib/router.mjs';
import { login, setAuthToken, persistAuth } from '../../lib/api.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-login-page {
      display: block;
      min-height: 100vh;
      background:
        radial-gradient(ellipse at 30% 20%, rgba(176, 64, 255, 0.10) 0%, transparent 50%),
        radial-gradient(ellipse at 70% 80%, rgba(0, 229, 255, 0.08) 0%, transparent 50%),
        radial-gradient(ellipse at 90% 30%, rgba(255, 64, 129, 0.06) 0%, transparent 50%),
        var(--background-base, #0a0a1a);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-md, 16px);
    }

    kikx-login-page .login-card {
      width: 100%;
      max-width: 400px;
      padding: var(--spacing-xl, 32px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(var(--glass-blur, 16px));
      -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-large, 12px);
      box-shadow:
        0 0 24px var(--accent-glow, rgba(0, 229, 255, 0.30)),
        0 0 48px rgba(176, 64, 255, 0.12),
        0 0 80px rgba(255, 64, 129, 0.06);
      text-align: center;
    }

    kikx-login-page .title {
      font-size: 2.5rem;
      font-weight: 700;
      color: var(--accent-primary, #00e5ff);
      margin-bottom: var(--spacing-xs, 4px);
      letter-spacing: 0.05em;
    }

    kikx-login-page .subtitle {
      font-size: 1rem;
      color: var(--text-secondary, #a0a0b8);
      margin-bottom: var(--spacing-xl, 32px);
    }

    kikx-login-page form {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md, 16px);
    }

    kikx-login-page .form-input {
      width: 100%;
      padding: 12px 16px;
      box-sizing: border-box;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    kikx-login-page .form-input::placeholder {
      color: var(--input-placeholder, var(--text-muted, #606078));
    }

    kikx-login-page .form-input:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-login-page .submit-button {
      width: 100%;
      padding: 12px 16px;
      box-sizing: border-box;
      background: var(--accent-primary, #00e5ff);
      color: #fff;
      border: none;
      border-radius: var(--border-radius-medium, 8px);
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: box-shadow 0.2s ease, opacity 0.2s ease;
    }

    kikx-login-page .submit-button:hover:not(:disabled) {
      box-shadow: 0 0 16px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-login-page .submit-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    kikx-login-page .status-message {
      display: none;
      font-size: 1rem;
      margin-top: var(--spacing-sm, 8px);
      min-height: 1.25em;
    }

    kikx-login-page .status-message.visible {
      display: block;
    }

    kikx-login-page .status-message.error {
      color: var(--color-error, #ff1744);
    }

    kikx-login-page .status-message.success {
      color: var(--color-success, #00e676);
    }
  </style>

  <div class="login-card">
    <div class="title"></div>
    <div class="subtitle"></div>
    <form>
      <input class="form-input email-input" type="email" autocomplete="email" />
      <input class="form-input password-input" type="password" autocomplete="current-password" />
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
    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._emailInput      = this.querySelector('.email-input');
      this._passwordInput   = this.querySelector('.password-input');
      this._submitButton    = this.querySelector('.submit-button');
      this._statusMessage   = this.querySelector('.status-message');
      this._titleElement    = this.querySelector('.title');
      this._subtitleElement = this.querySelector('.subtitle');
      this._form            = this.querySelector('form');
    }

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
    this._passwordInput.placeholder   = t('login.passwordPlaceholder') || 'Password';
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

    let email    = this._emailInput.value.trim();
    let password = this._passwordInput.value;

    if (!email) {
      this._showError(t('login.error.emailRequired'));
      return;
    }

    if (!password) {
      this._showError('Password is required.');
      return;
    }

    this._setLoading(true);

    try {
      let result = await login(email, password);
      let token  = result.data.token;

      setAuthToken(token);
      persistAuth(token, result.data.user);
      profile.setUser(result.data.user, token);
      navigate(BASE_PATH + '/', { replace: true });
    } catch (error) {
      let message = (error && error.message)
        ? error.message
        : t('login.error.generic');

      this._showError(message);
      this._setLoading(false);
    }
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-login-page', KikxLoginPage);

export default KikxLoginPage;
