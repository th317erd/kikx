'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host { display: block; }
    .form-group { margin-bottom: 16px; }
    .form-label { display: block; font-size: 0.875rem; font-weight: 600; color: var(--text-secondary, #a0a0b8); margin-bottom: 6px; }
    .session-name-input { width: 100%; box-sizing: border-box; padding: 10px 14px; font-size: 1rem; background: var(--input-background, rgba(255,255,255,0.05)); border: 1px solid var(--input-border, rgba(255,255,255,0.12)); border-radius: var(--border-radius-medium, 8px); color: var(--text-primary, #e8e8f0); outline: none; font-family: inherit; }
    .session-name-input:focus { border-color: var(--accent-primary, #00e5ff); box-shadow: 0 0 8px var(--accent-glow, rgba(0,229,255,0.30)); }
    .button-row { display: flex; gap: var(--spacing-sm, 8px); justify-content: flex-end; }
    .create-button { background: var(--accent-primary, #00e5ff); color: var(--bg-primary, #0a0a12); border: none; border-radius: var(--border-radius-small, 4px); padding: 10px 24px; font-weight: 600; font-size: 0.875rem; cursor: pointer; }
    .create-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0,229,255,0.40)); }
    .create-button:disabled { opacity: 0.5; cursor: not-allowed; }
    .cancel-button { background: none; border: 1px solid var(--glass-border, rgba(255,255,255,0.10)); color: var(--text-secondary, #a0a0b8); border-radius: var(--border-radius-small, 4px); padding: 10px 20px; font-size: 0.875rem; cursor: pointer; }
    .cancel-button:hover { background: var(--glass-hover, rgba(255,255,255,0.08)); }
  </style>

  <div class="form-group">
    <label class="form-label"></label>
    <input class="session-name-input" type="text" />
  </div>
  <div class="button-row">
    <button class="cancel-button"></button>
    <button class="create-button"></button>
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

class HeroCreateSessionModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._label        = this.shadowRoot.querySelector('.form-label');
    this._input        = this.shadowRoot.querySelector('.session-name-input');
    this._createButton = this.shadowRoot.querySelector('.create-button');
    this._cancelButton = this.shadowRoot.querySelector('.cancel-button');

    this._label.textContent        = t('session.create.title');
    this._input.placeholder        = t('session.create.namePlaceholder');
    this._createButton.textContent = t('session.create.createButton');
    this._cancelButton.textContent = t('session.create.cancelButton');

    this._createButton.disabled = true;

    this._onInput       = this._onInput.bind(this);
    this._onCreate      = this._onCreate.bind(this);
    this._onCancel      = this._onCancel.bind(this);
    this._onKeydown     = this._onKeydown.bind(this);
  }

  connectedCallback() {
    this._input.addEventListener('input', this._onInput);
    this._createButton.addEventListener('click', this._onCreate);
    this._cancelButton.addEventListener('click', this._onCancel);
    this._input.addEventListener('keydown', this._onKeydown);
  }

  disconnectedCallback() {
    this._input.removeEventListener('input', this._onInput);
    this._createButton.removeEventListener('click', this._onCreate);
    this._cancelButton.removeEventListener('click', this._onCancel);
    this._input.removeEventListener('keydown', this._onKeydown);
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  reset() {
    this._input.value = '';
    this._createButton.disabled = true;
  }

  focus() {
    this._input.focus();
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  _onInput() {
    this._createButton.disabled = this._input.value.trim().length === 0;
  }

  _onCreate() {
    let name = this._input.value.trim();
    if (!name) return;

    this.dispatchEvent(new CustomEvent('session-create', {
      bubbles:  true,
      composed: true,
      detail:   { name },
    }));
  }

  _onCancel() {
    this.dispatchEvent(new CustomEvent('session-cancel', {
      bubbles:  true,
      composed: true,
    }));
  }

  _onKeydown(event) {
    if (event.key === 'Enter') {
      this._onCreate();
    }
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('hero-create-session-modal', HeroCreateSessionModal);

export default HeroCreateSessionModal;
