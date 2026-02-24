'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: flex;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px);
      max-width: 85%;
      align-self: flex-start;
    }

    :host([alignment="user"]) {
      align-self: flex-end;
      flex-direction: row-reverse;
    }

    :host([alignment="system"]) {
      align-self: center;
      max-width: 100%;
    }

    .avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.8rem;
      flex-shrink: 0;
      color: #fff;
      background: var(--interaction-avatar-color, #e53935);
    }

    .body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs, 4px);
    }

    .header {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-secondary, #a0a0b8);
    }

    .content {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs, 4px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      padding: var(--spacing-sm, 8px) 12px;
      color: var(--text-primary, #e8e8f0);
    }

    :host([alignment="user"]) .content {
      background: var(--user-bubble-background, rgba(229, 57, 53, 0.15));
      border-color: var(--user-bubble-border, rgba(229, 57, 53, 0.30));
    }

    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-muted, #606078);
      padding-top: 2px;
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
      background: none;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-secondary, #a0a0b8);
      padding: 4px 10px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .action-button:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    .submit-button {
      background: var(--accent-primary, #00e5ff);
      color: var(--bg-primary, #0a0a12);
      border-color: transparent;
      font-weight: 600;
    }

    .submit-button:hover {
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }
  </style>

  <div class="avatar"></div>
  <div class="body">
    <div class="header"></div>
    <div class="content">
      <slot></slot>
    </div>
    <div class="footer">
      <div class="footer-left">
        <span class="timestamp"></span>
        <span class="token-count"></span>
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

class HeroInteraction extends HTMLElement {
  static get observedAttributes() {
    return [
      'participant-name',
      'participant-initials',
      'avatar-color',
      'alignment',
      'timestamp',
      'token-count',
      'show-actions',
      'interaction-id',
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._avatar      = this.shadowRoot.querySelector('.avatar');
    this._header      = this.shadowRoot.querySelector('.header');
    this._timestamp   = this.shadowRoot.querySelector('.timestamp');
    this._tokenCount  = this.shadowRoot.querySelector('.token-count');
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
    this._header.textContent    = this.getAttribute('participant-name') || '';
    this._avatar.textContent    = this.getAttribute('participant-initials') || '';
    this._timestamp.textContent = this.getAttribute('timestamp') || '';

    let avatarColor = this.getAttribute('avatar-color');
    if (avatarColor) {
      this._avatar.style.setProperty('--interaction-avatar-color', avatarColor);
    } else {
      this._avatar.style.removeProperty('--interaction-avatar-color');
    }

    let tokenCountAttr = this.getAttribute('token-count');
    this._tokenCount.textContent = tokenCountAttr ? formatTokenCount(tokenCountAttr) : '';

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
      detail:   { interactionId: this.getAttribute('interaction-id') },
    }));
  }

  _onSubmitClick() {
    this.dispatchEvent(new CustomEvent('interaction-submit', {
      bubbles:  true,
      composed: true,
      detail:   { interactionId: this.getAttribute('interaction-id') },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('hero-interaction', HeroInteraction);

export default HeroInteraction;
