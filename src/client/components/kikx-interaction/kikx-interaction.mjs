'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      padding: var(--spacing-sm, 8px);
      max-width: 85%;
      align-self: flex-start;
    }

    :host([alignment="user"]) {
      align-self: flex-end;
    }

    :host([alignment="system"]) {
      align-self: center;
      max-width: 100%;
    }

    .bubble {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs, 4px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-large, 12px);
      padding: 12px 14px;
      color: var(--text-primary, #e8e8f0);
    }

    :host([alignment="user"]) .bubble {
      background: var(--chat-user-background, var(--accent-dim, rgba(0, 229, 255, 0.10)));
      border-color: var(--chat-user-border, var(--accent-glow, rgba(0, 229, 255, 0.30)));
    }

    .bubble-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
    }

    .avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 1rem;
      flex-shrink: 0;
      color: #fff;
      background: var(--interaction-avatar-color, #e53935);
    }

    .header-text {
      display: flex;
      align-items: baseline;
      gap: var(--spacing-sm, 8px);
      flex: 1;
      min-width: 0;
    }

    .header-name {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #e8e8f0);
    }

    .content {
      padding: 2px 0;
    }

    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 1rem;
      color: var(--text-muted, #606078);
      padding-top: 2px;
    }

    .footer:empty {
      display: none;
    }

    .footer-left {
      display: flex;
      gap: var(--spacing-sm, 8px);
      align-items: center;
    }

    .footer-right {
      display: flex;
      gap: var(--spacing-xs, 4px);
      align-items: center;
    }

    .action-button {
      border: none;
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 20px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: box-shadow 0.2s ease;
    }

    .ignore-button {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      color: var(--text-primary, #e8e8f0);
    }

    .ignore-button:hover {
      box-shadow: 0 0 8px rgba(255, 255, 255, 0.12);
    }

    .submit-button {
      background: var(--accent-primary, #00e5ff);
      color: #fff;
    }

    .submit-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40));
    }
  </style>

  <div class="bubble">
    <div class="bubble-header">
      <div class="avatar"></div>
      <div class="header-text">
        <span class="header-name"></span>
      </div>
    </div>
    <div class="content">
      <slot></slot>
    </div>
    <div class="footer">
      <div class="footer-left">
        <span class="footer-meta"></span>
      </div>
      <div class="footer-right"></div>
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

function formatTokenCount(count) {
  let num = parseInt(count, 10);

  if (isNaN(num) || num <= 0)
    return '';

  return (num === 1)
    ? t('chat.interaction.tokenCount.one').replace('{count}', '1')
    : t('chat.interaction.tokenCount.other').replace('{count}', String(num));
}

class KikxInteraction extends HTMLElement {
  static get observedAttributes() {
    return [
      'participant-name',
      'participant-initials',
      'avatar-color',
      'alignment',
      'timestamp',
      'token-count',
      'show-actions',
      'data-interaction-id',
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._avatar      = this.shadowRoot.querySelector('.avatar');
    this._headerName  = this.shadowRoot.querySelector('.header-name');
    this._footerMeta  = this.shadowRoot.querySelector('.footer-meta');
    this._footerRight = this.shadowRoot.querySelector('.footer-right');

    this._onIgnoreClick = this._onIgnoreClick.bind(this);
    this._onSubmitClick = this._onSubmitClick.bind(this);
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    this._removeActionListeners();
  }

  attributeChangedCallback() {
    if (this.isConnected)
      this._render();
  }

  _render() {
    this._headerName.textContent = this.getAttribute('participant-name') || '';
    this._avatar.textContent     = this.getAttribute('participant-initials') || '';

    let avatarColor = this.getAttribute('avatar-color');
    if (avatarColor) {
      this._avatar.style.setProperty('--interaction-avatar-color', avatarColor);
    } else {
      this._avatar.style.removeProperty('--interaction-avatar-color');
    }

    // Build footer meta: "timestamp / ~N tokens" or just "timestamp"
    let timestamp      = this.getAttribute('timestamp') || '';
    let tokenCountAttr = this.getAttribute('token-count');
    let tokenStr       = tokenCountAttr ? formatTokenCount(tokenCountAttr) : '';
    let parts          = [];

    if (timestamp)
      parts.push(timestamp);

    if (tokenStr)
      parts.push(tokenStr);

    this._footerMeta.textContent = parts.join(' / ');

    this._renderActions();
  }

  _renderActions() {
    this._removeActionListeners();
    this._footerRight.innerHTML = '';

    if (!this.hasAttribute('show-actions'))
      return;

    let ignoreButton = document.createElement('button');
    ignoreButton.className   = 'action-button ignore-button';
    ignoreButton.textContent = t('chat.interaction.ignoreButton');
    ignoreButton.type        = 'button';

    let submitButton = document.createElement('button');
    submitButton.className   = 'action-button submit-button';
    submitButton.textContent = t('chat.interaction.submitButton');
    submitButton.type        = 'button';

    ignoreButton.addEventListener('click', this._onIgnoreClick);
    submitButton.addEventListener('click', this._onSubmitClick);

    this._ignoreButton = ignoreButton;
    this._submitButton = submitButton;

    this._footerRight.appendChild(ignoreButton);
    this._footerRight.appendChild(submitButton);
  }

  _removeActionListeners() {
    if (this._ignoreButton) {
      this._ignoreButton.removeEventListener('click', this._onIgnoreClick);
      this._ignoreButton = null;
    }

    if (this._submitButton) {
      this._submitButton.removeEventListener('click', this._onSubmitClick);
      this._submitButton = null;
    }
  }

  _onIgnoreClick() {
    this.dispatchEvent(new CustomEvent('interaction-ignore', {
      bubbles:  true,
      composed: true,
      detail:   { interactionId: this.getAttribute('data-interaction-id') },
    }));
  }

  _onSubmitClick() {
    this.dispatchEvent(new CustomEvent('interaction-submit', {
      bubbles:  true,
      composed: true,
      detail:   { interactionId: this.getAttribute('data-interaction-id') },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-interaction', KikxInteraction);

export default KikxInteraction;
