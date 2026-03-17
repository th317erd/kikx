'use strict';

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

    kikx-reflection-block .thinking-dots {
      display: inline-flex;
      gap: 2px;
      font-weight: 600;
      font-size: 1.2rem;
      line-height: 1;
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
    this._expanded = false;
    this._onToggleClick = this._onToggleClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._toggleHeader      = this.querySelector('.toggle-header');
      this._collapseIndicator = this.querySelector('.collapse-indicator');
      this._reflectionContent = this.querySelector('.reflection-content');
    }

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
    return (this._reflectionContent) ? this._reflectionContent.textContent : '';
  }

  set content(value) {
    if (this._reflectionContent)
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
