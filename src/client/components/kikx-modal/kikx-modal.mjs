'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }

    :host([open]) {
      display: flex;
    }

    .backdrop {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    .panel {
      position: relative;
      z-index: 1;
      min-width: 320px;
      max-width: 90vw;
      max-height: 85vh;
      overflow-y: auto;
      background: var(--glass-background-solid, rgba(18, 18, 30, 0.95));
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-large, 12px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 16px var(--accent-glow, rgba(0, 229, 255, 0.10));
      color: var(--text-primary, #e8e8f0);
      padding: 0;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    .panel-title {
      font-size: 1.125rem;
      font-weight: 600;
    }

    .close-button {
      background: none;
      border: none;
      color: var(--text-muted, #606078);
      font-size: 1.25rem;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.2s ease, color 0.2s ease;
      line-height: 1;
    }

    .close-button:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
      color: var(--text-primary, #e8e8f0);
    }

    .panel-body {
      padding: 16px 20px 20px;
    }

    .panel::-webkit-scrollbar { width: 6px; }
    .panel::-webkit-scrollbar-track { background: transparent; }
    .panel::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    .panel::-webkit-scrollbar-button { display: none; }
  </style>

  <div class="backdrop"></div>
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title"></span>
      <button class="close-button" aria-label="${t('common.close') || 'Close'}">&#10005;</button>
    </div>
    <div class="panel-body">
      <slot></slot>
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

class KikxModal extends HTMLElement {
  static get observedAttributes() { return ['open', 'modal-title']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._backdrop    = this.shadowRoot.querySelector('.backdrop');
    this._closeButton = this.shadowRoot.querySelector('.close-button');
    this._panelTitle  = this.shadowRoot.querySelector('.panel-title');

    this._onBackdropClick = this._onBackdropClick.bind(this);
    this._onCloseClick    = this._onCloseClick.bind(this);
    this._onKeyDown       = this._onKeyDown.bind(this);
  }

  connectedCallback() {
    this._backdrop.addEventListener('click', this._onBackdropClick);
    this._closeButton.addEventListener('click', this._onCloseClick);
    this._updateTitle();

    if (this.hasAttribute('open'))
      this._addEscapeListener();
  }

  disconnectedCallback() {
    this._backdrop.removeEventListener('click', this._onBackdropClick);
    this._closeButton.removeEventListener('click', this._onCloseClick);
    this._removeEscapeListener();
  }

  attributeChangedCallback(name) {
    if (name === 'modal-title')
      this._updateTitle();

    if (name === 'open') {
      if (this.hasAttribute('open'))
        this._addEscapeListener();
      else
        this._removeEscapeListener();
    }
  }

  _updateTitle() {
    if (this._panelTitle)
      this._panelTitle.textContent = this.getAttribute('modal-title') || '';
  }

  _onBackdropClick() { this.close(); }
  _onCloseClick() { this.close(); }

  _onKeyDown(event) {
    if (event.key === 'Escape')
      this.close();
  }

  _addEscapeListener() {
    let doc = this.ownerDocument || document;
    doc.addEventListener('keydown', this._onKeyDown);
  }

  _removeEscapeListener() {
    let doc = this.ownerDocument || document;
    doc.removeEventListener('keydown', this._onKeyDown);
  }

  open() {
    this.setAttribute('open', '');
    this.dispatchEvent(new CustomEvent('modal-open', { bubbles: true, composed: true }));
  }

  close() {
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-modal', KikxModal);

export default KikxModal;
