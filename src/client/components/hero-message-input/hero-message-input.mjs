'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      padding: var(--spacing-sm, 8px);
      flex-shrink: 0;
    }

    .input-area {
      display: flex;
      align-items: flex-end;
      gap: var(--spacing-xs, 4px);
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      padding: var(--spacing-xs, 4px);
    }

    .message-textarea {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-primary, #e8e8f0);
      font-size: 0.9375rem;
      font-family: inherit;
      resize: none;
      outline: none;
      padding: 8px 12px;
      max-height: 150px;
      overflow-y: auto;
      line-height: 1.4;
    }

    .message-textarea::placeholder {
      color: var(--input-placeholder, var(--text-muted, #606078));
    }

    .send-button {
      background: var(--accent-primary, #00e5ff);
      color: var(--bg-primary, #0a0a12);
      border: none;
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px;
      font-weight: 600;
      font-size: 0.875rem;
      cursor: pointer;
      transition: background 0.2s ease, box-shadow 0.2s ease;
      white-space: nowrap;
    }

    .send-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40));
    }

    .send-button:disabled,
    .message-textarea:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>

  <div class="input-area">
    <textarea class="message-textarea" rows="1"></textarea>
    <button class="send-button"></button>
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

class HeroMessageInput extends HTMLElement {
  static get observedAttributes() {
    return ['disabled'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._textarea   = this.shadowRoot.querySelector('.message-textarea');
    this._sendButton = this.shadowRoot.querySelector('.send-button');

    this._onKeyDown   = this._onKeyDown.bind(this);
    this._onSendClick = this._onSendClick.bind(this);
  }

  connectedCallback() {
    this._render();
    this._textarea.addEventListener('keydown', this._onKeyDown);
    this._sendButton.addEventListener('click', this._onSendClick);
  }

  disconnectedCallback() {
    this._textarea.removeEventListener('keydown', this._onKeyDown);
    this._sendButton.removeEventListener('click', this._onSendClick);
  }

  attributeChangedCallback() {
    let isDisabled = this.hasAttribute('disabled');
    this._textarea.disabled   = isDisabled;
    this._sendButton.disabled = isDisabled;
  }

  _render() {
    this._textarea.placeholder   = t('chat.input.placeholder');
    this._sendButton.textContent = t('chat.input.sendButton');

    let isDisabled = this.hasAttribute('disabled');
    this._textarea.disabled   = isDisabled;
    this._sendButton.disabled = isDisabled;
  }

  _onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this._send();
    }
  }

  _onSendClick() {
    this._send();
  }

  _send() {
    let text = this._textarea.value.trim();
    if (!text)
      return;

    this.dispatchEvent(new CustomEvent('send-message', {
      bubbles:  true,
      composed: true,
      detail:   { text },
    }));

    this._textarea.value = '';
  }

  focus() {
    this._textarea.focus();
  }

  clear() {
    this._textarea.value = '';
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('hero-message-input', HeroMessageInput);

export default HeroMessageInput;
