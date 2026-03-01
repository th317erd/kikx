'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      border-radius: var(--border-radius-small, 4px);
      overflow: hidden;
    }

    .toggle-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-small, 4px);
      cursor: pointer;
      user-select: none;
      font-size: 0.8125rem;
      color: var(--text-secondary, #a0a0b8);
      transition: background 0.2s ease;
      width: 100%;
      text-align: left;
    }

    .toggle-header:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    .collapse-indicator {
      display: inline-block;
      font-size: 0.625rem;
      transition: transform 0.2s ease;
    }

    .collapse-indicator.expanded {
      transform: rotate(90deg);
    }

    .brain-icon {
      font-size: 1rem;
    }

    .label {
      font-weight: 600;
    }

    .reflection-content {
      display: none;
      padding: var(--spacing-sm, 8px);
      font-size: 0.875rem;
      line-height: 1.5;
      color: var(--text-secondary, #a0a0b8);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-top: none;
      border-radius: 0 0 var(--border-radius-small, 4px) var(--border-radius-small, 4px);
      white-space: pre-wrap;
    }

    .reflection-content.expanded {
      display: block;
    }
  </style>

  <button class="toggle-header">
    <span class="collapse-indicator">\u25B6</span>
    <span class="brain-icon">\uD83E\uDDE0</span>
    <span class="label"></span>
  </button>
  <div class="reflection-content"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxReflectionBlock extends HTMLElement {
  static get observedAttributes() { return ['expanded']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._toggleHeader      = this.shadowRoot.querySelector('.toggle-header');
    this._collapseIndicator = this.shadowRoot.querySelector('.collapse-indicator');
    this._label             = this.shadowRoot.querySelector('.label');
    this._reflectionContent = this.shadowRoot.querySelector('.reflection-content');
    this._expanded          = false;

    this._onToggleClick = this._onToggleClick.bind(this);
  }

  connectedCallback() {
    this._label.textContent = t('chat.reflection.label');
    this._toggleHeader.addEventListener('click', this._onToggleClick);

    if (this.hasAttribute('expanded'))
      this._setExpanded(true);
  }

  disconnectedCallback() {
    this._toggleHeader.removeEventListener('click', this._onToggleClick);
  }

  attributeChangedCallback(name) {
    if (name === 'expanded') {
      let shouldExpand = this.hasAttribute('expanded');

      if (shouldExpand !== this._expanded)
        this._setExpanded(shouldExpand);
    }
  }

  get content() {
    return this._reflectionContent.textContent;
  }

  set content(value) {
    this._reflectionContent.textContent = value;
  }

  toggle() {
    this._setExpanded(!this._expanded);
    this._dispatchToggleEvent();
  }

  expand() {
    if (!this._expanded) {
      this._setExpanded(true);
      this._dispatchToggleEvent();
    }
  }

  collapse() {
    if (this._expanded) {
      this._setExpanded(false);
      this._dispatchToggleEvent();
    }
  }

  _onToggleClick() {
    this.toggle();
  }

  _setExpanded(expanded) {
    this._expanded = expanded;

    if (expanded) {
      this._collapseIndicator.classList.add('expanded');
      this._reflectionContent.classList.add('expanded');
    } else {
      this._collapseIndicator.classList.remove('expanded');
      this._reflectionContent.classList.remove('expanded');
    }
  }

  _dispatchToggleEvent() {
    this.dispatchEvent(new CustomEvent('reflection-toggle', {
      bubbles:  true,
      composed: true,
      detail:   { expanded: this._expanded },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-reflection-block', KikxReflectionBlock);

export default KikxReflectionBlock;
