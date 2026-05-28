'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-scroll-anchor {
      display: block;
      position: absolute;
      bottom: var(--spacing-md, 16px);
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }

    kikx-scroll-anchor[hidden] {
      display: none;
    }

    kikx-scroll-anchor .anchor-button {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: 8px 16px;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s ease, box-shadow 0.2s ease;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }

    kikx-scroll-anchor .anchor-button:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-scroll-anchor .chevron {
      font-size: 1.125rem;
      line-height: 1;
    }

    kikx-scroll-anchor .badge {
      display: none;
      background: var(--accent-primary, #00e5ff);
      color: var(--bg-primary, #0a0a12);
      border-radius: 50%;
      min-width: 20px;
      height: 20px;
      font-size: 1rem;
      font-weight: 700;
      text-align: center;
      line-height: 20px;
      padding: 0 4px;
    }

    kikx-scroll-anchor .badge[data-count]:not([data-count="0"]) {
      display: inline-block;
    }
  </style>

  <button class="anchor-button" title="">
    <span class="chevron">\u25BC</span>
    <span class="badge" data-count="0"></span>
  </button>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxScrollAnchor extends HTMLElement {
  constructor() {
    super();
    this._onClick = this._onClick.bind(this);
  }

  static get observedAttributes() { return ['hidden', 'unread-count']; }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._button = this.querySelector('.anchor-button');
      this._badge  = this.querySelector('.badge');
    }

    this._button.title = t('chat.scrollAnchor.jumpToBottom');
    this._button.addEventListener('click', this._onClick);
  }

  disconnectedCallback() {
    this._button.removeEventListener('click', this._onClick);
  }

  attributeChangedCallback(name) {
    if (name === 'unread-count')
      this._updateBadge();
  }

  _onClick() {
    this.dispatchEvent(new CustomEvent('jump-to-bottom', {
      bubbles:  true,
      composed: true,
    }));
  }

  _updateBadge() {
    if (!this._badge)
      return;

    let count = parseInt(this.getAttribute('unread-count') || '0', 10);
    this._badge.textContent = (count > 0) ? String(count) : '';
    this._badge.setAttribute('data-count', String(count));
  }

  show() {
    this.removeAttribute('hidden');
  }

  hide() {
    this.setAttribute('hidden', '');
  }

  setUnreadCount(count) {
    this.setAttribute('unread-count', String(count));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-scroll-anchor', KikxScrollAnchor);

export default KikxScrollAnchor;
