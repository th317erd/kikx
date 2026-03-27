'use strict';

import { t } from '../../lib/i18n.mjs';

const THINKING_SAYING_INTERVAL = 3000; // ms between saying changes

const TEMPLATE_HTML = `
  <style>
    kikx-reflection-block {
      display: block;
      border-radius: var(--border-radius-small, 4px);
      overflow: hidden;
    }

    kikx-reflection-block .toggle-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-small, 4px);
      cursor: pointer;
      user-select: none;
      font-size: 1rem;
      color: var(--text-secondary, #a0a0b8);
      transition: background 0.2s ease;
      width: 100%;
      text-align: left;
    }

    kikx-reflection-block .toggle-header:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    kikx-reflection-block .collapse-indicator {
      display: inline-block;
      font-size: 1rem;
      transition: transform 0.2s ease;
    }

    kikx-reflection-block .collapse-indicator.expanded {
      transform: rotate(90deg);
    }

    kikx-reflection-block .brain-icon {
      font-size: 1rem;
    }

    kikx-reflection-block[complete] .thinking-dots {
      display: none;
    }

    kikx-reflection-block .thinking-dots {
      display: inline-flex;
      gap: 2px;
      font-weight: 600;
      font-size: 1.2rem;
      line-height: 1;
      flex-shrink: 0;
    }

    kikx-reflection-block .thinking-dots span {
      animation: kikx-dot-pulse 1.4s ease-in-out infinite;
      opacity: 0.2;
    }

    kikx-reflection-block .thinking-dots span:nth-child(2) {
      animation-delay: 0.2s;
    }

    kikx-reflection-block .thinking-dots span:nth-child(3) {
      animation-delay: 0.4s;
    }

    @keyframes kikx-dot-pulse {
      0%, 80%, 100% { opacity: 0.2; }
      40%           { opacity: 1; }
    }

    /* Scrolling preview of actual thinking text (from other bot) */
    kikx-reflection-block .thinking-preview {
      display: none;
      flex: 1;
      overflow: hidden;
      white-space: nowrap;
      font-size: 0.8rem;
      color: var(--text-tertiary, rgba(255, 255, 255, 0.35));
      font-style: italic;
      mask-image: linear-gradient(to right, transparent 0%, black 5%, black 85%, transparent 100%);
      -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 85%, transparent 100%);
    }

    kikx-reflection-block:not([complete]) .thinking-preview {
      display: block;
    }

    kikx-reflection-block .thinking-preview-inner {
      display: inline-block;
      animation: kikx-thinking-scroll 8s linear infinite;
    }

    @keyframes kikx-thinking-scroll {
      0%   { transform: translateX(0%); }
      100% { transform: translateX(-50%); }
    }

    /* Funny sayings banner below the header */
    kikx-reflection-block .thinking-saying {
      display: block;
      padding: 2px 8px 4px;
      font-size: 0.8rem;
      font-style: italic;
      color: var(--text-muted, #6a6a80);
      opacity: 0;
      transition: opacity 0.4s ease;
    }

    kikx-reflection-block .thinking-saying.visible {
      opacity: 1;
    }

    kikx-reflection-block[complete] .thinking-saying {
      display: none;
    }

    kikx-reflection-block .reflection-content {
      display: none;
      padding: var(--spacing-sm, 8px);
      font-size: 1rem;
      line-height: 1.5;
      color: var(--text-secondary, #a0a0b8);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-top: none;
      border-radius: 0 0 var(--border-radius-small, 4px) var(--border-radius-small, 4px);
      white-space: pre-wrap;
    }

    kikx-reflection-block .reflection-content.expanded {
      display: block;
    }
  </style>

  <button class="toggle-header">
    <span class="collapse-indicator">\u25B6</span>
    <span class="brain-icon">\uD83E\uDDE0</span>
    <span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
    <span class="thinking-preview"><span class="thinking-preview-inner"></span></span>
  </button>
  <div class="thinking-saying"></div>
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

function pickRandomSaying(sayings, lastIndex) {
  if (!sayings || sayings.length === 0)
    return { text: '', index: -1 };

  if (sayings.length === 1)
    return { text: sayings[0], index: 0 };

  let index;
  do {
    index = Math.floor(Math.random() * sayings.length);
  } while (index === lastIndex);

  return { text: sayings[index], index };
}

class KikxReflectionBlock extends HTMLElement {
  static get observedAttributes() { return ['expanded', 'complete']; }

  constructor() {
    super();
    this._expanded         = false;
    this._pendingContent   = null;
    this._sayingTimer      = null;
    this._lastSayingIndex  = -1;
    this._onToggleClick    = this._onToggleClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._toggleHeader      = this.querySelector('.toggle-header');
      this._collapseIndicator = this.querySelector('.collapse-indicator');
      this._reflectionContent = this.querySelector('.reflection-content');
      this._previewInner      = this.querySelector('.thinking-preview-inner');
      this._thinkingSaying    = this.querySelector('.thinking-saying');

      // Apply content that was set before the element connected to the DOM
      if (this._pendingContent !== null) {
        this._reflectionContent.textContent = this._pendingContent;
        this._updatePreview(this._pendingContent);
        this._pendingContent = null;
      }
    }

    this._toggleHeader.addEventListener('click', this._onToggleClick);

    if (this.hasAttribute('expanded'))
      this._setExpanded(true);

    // Start cycling sayings if not yet complete
    if (!this.hasAttribute('complete'))
      this._startSayings();
  }

  disconnectedCallback() {
    this._toggleHeader.removeEventListener('click', this._onToggleClick);
    this._stopSayings();
  }

  attributeChangedCallback(name) {
    if (name === 'expanded') {
      let shouldExpand = this.hasAttribute('expanded');

      if (shouldExpand !== this._expanded)
        this._setExpanded(shouldExpand);
    }

    if (name === 'complete') {
      if (this.hasAttribute('complete'))
        this._stopSayings();
    }
  }

  get content() {
    return (this._reflectionContent) ? this._reflectionContent.textContent : '';
  }

  set content(value) {
    if (this._reflectionContent) {
      this._reflectionContent.textContent = value;
      this._updatePreview(value);
    } else {
      this._pendingContent = value;
    }
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

    if (!this._collapseIndicator)
      return;

    if (expanded) {
      this._collapseIndicator.classList.add('expanded');
      this._reflectionContent.classList.add('expanded');
    } else {
      this._collapseIndicator.classList.remove('expanded');
      this._reflectionContent.classList.remove('expanded');
    }
  }

  // Scrolling preview of actual thinking text
  _updatePreview(text) {
    if (!this._previewInner)
      return;

    if (!text) {
      this._previewInner.textContent = '';
      return;
    }

    let preview = text.length > 200 ? text.slice(-200) : text;
    preview = preview.replace(/\n+/g, ' \u2022 ').replace(/\s+/g, ' ').trim();
    this._previewInner.textContent = preview + '    \u2022    ' + preview;
  }

  // Funny sayings cycling
  _startSayings() {
    if (this._sayingTimer)
      return;

    let sayings = t('chat.thinking.sayings');
    if (!Array.isArray(sayings) || sayings.length === 0)
      return;

    this._showNextSaying(sayings);
    this._sayingTimer = setInterval(() => this._showNextSaying(sayings), THINKING_SAYING_INTERVAL);
  }

  _stopSayings() {
    if (this._sayingTimer) {
      clearInterval(this._sayingTimer);
      this._sayingTimer = null;
    }

    if (this._thinkingSaying) {
      this._thinkingSaying.classList.remove('visible');
      this._thinkingSaying.textContent = '';
    }
  }

  _showNextSaying(sayings) {
    if (!this._thinkingSaying)
      return;

    this._thinkingSaying.classList.remove('visible');

    setTimeout(() => {
      let { text, index }   = pickRandomSaying(sayings, this._lastSayingIndex);
      this._lastSayingIndex = index;

      this._thinkingSaying.textContent = text;
      this._thinkingSaying.classList.add('visible');
    }, 400);
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
