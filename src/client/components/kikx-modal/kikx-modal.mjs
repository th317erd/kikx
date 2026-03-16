'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-modal {
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

    kikx-modal[open] {
      display: flex;
    }

    kikx-modal .backdrop {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    kikx-modal .panel {
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
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.5),
        0 0 20px var(--accent-glow, rgba(0, 229, 255, 0.15)),
        0 0 40px rgba(176, 64, 255, 0.08),
        0 0 60px rgba(255, 64, 129, 0.04);
      color: var(--text-primary, #e8e8f0);
      padding: 0;
    }

    kikx-modal .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-modal .panel-title {
      font-size: 1.125rem;
      font-weight: 600;
    }

    kikx-modal .close-button {
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

    kikx-modal .close-button:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
      color: var(--text-primary, #e8e8f0);
    }

    kikx-modal .panel-body {
      padding: 16px 20px 20px;
    }

    kikx-modal .panel::-webkit-scrollbar { width: 6px; }
    kikx-modal .panel::-webkit-scrollbar-track { background: transparent; }
    kikx-modal .panel::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    kikx-modal .panel::-webkit-scrollbar-button { display: none; }
  </style>

  <div class="backdrop"></div>
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title"></span>
      <button class="close-button" aria-label="${t('common.close') || 'Close'}">&#10005;</button>
    </div>
    <div class="panel-body"></div>
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
    this._onBackdropClick = this._onBackdropClick.bind(this);
    this._onCloseClick    = this._onCloseClick.bind(this);
    this._onKeyDown       = this._onKeyDown.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._backdrop    = this.querySelector('.backdrop');
      this._closeButton = this.querySelector('.close-button');
      this._panelTitle  = this.querySelector('.panel-title');
      this._panelBody   = this.querySelector('.panel-body');
    }

    this._backdrop.addEventListener('click', this._onBackdropClick);
    this._closeButton.addEventListener('click', this._onCloseClick);
    this._updateTitle();

    // Move any children that were added as light DOM (slotted content)
    // into the panel-body, since we no longer have <slot>
    this._moveChildrenToBody();

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

  // Move non-template children into the panel-body div
  _moveChildrenToBody() {
    if (!this._panelBody)
      return;

    // Collect children that are NOT part of our template (backdrop, panel, style)
    let children = [];
    for (let child of this.childNodes) {
      if (child === this._backdrop || child === this._backdrop.parentNode)
        continue;
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.classList && (child.classList.contains('backdrop') || child.classList.contains('panel')))
          continue;
        if (child.tagName === 'STYLE')
          continue;
      }
      // Skip text nodes that are just whitespace
      if (child.nodeType === Node.TEXT_NODE && !child.textContent.trim())
        continue;

      children.push(child);
    }

    for (let child of children)
      this._panelBody.appendChild(child);
  }

  // Override appendChild to redirect into panel-body
  appendChild(node) {
    // If panel-body exists and the node isn't part of our template structure,
    // put it in the panel-body
    if (this._panelBody && node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'STYLE' || (node.classList && (node.classList.contains('backdrop') || node.classList.contains('panel'))))
        return HTMLElement.prototype.appendChild.call(this, node);

      return this._panelBody.appendChild(node);
    }

    return HTMLElement.prototype.appendChild.call(this, node);
  }

  // Override querySelector to also search panel-body children
  querySelector(selector) {
    // First try direct children
    let result = HTMLElement.prototype.querySelector.call(this, selector);
    return result;
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
    this._autoFocus();
  }

  _autoFocus() {
    // Wait a frame so content has rendered
    requestAnimationFrame(() => {
      let target = this._findFirstFocusable(this);
      if (target)
        target.focus();
    });
  }

  _findFirstFocusable(root) {
    let selectors = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

    // Check children (light DOM now, no shadow boundary)
    let match = root.querySelector(selectors);
    if (match)
      return match;

    // Walk children recursively
    for (let child of root.children) {
      let nested = this._findFirstFocusable(child);
      if (nested)
        return nested;
    }

    return null;
  }

  close() {
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-modal', KikxModal);

export default KikxModal;
