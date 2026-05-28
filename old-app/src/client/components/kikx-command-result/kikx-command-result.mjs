'use strict';

const TEMPLATE_HTML = `
  <style>
    kikx-command-result {
      display: block;
      border-radius: var(--border-radius-small, 4px);
      overflow: hidden;
      font-size: 1rem;
    }

    kikx-command-result .command-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-small, 4px);
      cursor: pointer;
      user-select: none;
      color: var(--text-secondary, #a0a0b8);
      transition: background 0.2s ease;
      width: 100%;
      text-align: left;
    }

    kikx-command-result .command-header:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    kikx-command-result .collapse-indicator {
      display: inline-block;
      font-size: 1rem;
      transition: transform 0.2s ease;
    }

    kikx-command-result .collapse-indicator.expanded {
      transform: rotate(90deg);
    }

    kikx-command-result .tool-icon {
      font-size: 1rem;
    }

    kikx-command-result .command-name {
      font-weight: 600;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
    }

    kikx-command-result .status-badge {
      margin-left: auto;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
    }

    kikx-command-result .status-badge.success {
      background: rgba(76, 175, 80, 0.2);
      color: #66bb6a;
    }

    kikx-command-result .status-badge.error {
      background: rgba(229, 57, 53, 0.2);
      color: #ef5350;
    }

    kikx-command-result .status-badge.running {
      background: rgba(255, 183, 77, 0.2);
      color: #ffb74d;
    }

    kikx-command-result .command-body {
      display: none;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-top: none;
      border-radius: 0 0 var(--border-radius-small, 4px) var(--border-radius-small, 4px);
    }

    kikx-command-result .command-body.expanded {
      display: block;
    }

    kikx-command-result .section-label {
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted, #606078);
      padding: 6px 8px 2px;
    }

    kikx-command-result .section-content {
      padding: 4px 8px 8px;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 1rem;
      line-height: 1.4;
      white-space: pre-wrap;
      color: var(--text-primary, #e8e8f0);
      overflow-x: auto;
    }
  </style>

  <button class="command-header">
    <span class="collapse-indicator">\u25B6</span>
    <span class="tool-icon">\u2699</span>
    <span class="command-name"></span>
    <span class="status-badge"></span>
  </button>
  <div class="command-body">
    <div class="section-label arguments-label">Arguments</div>
    <div class="section-content arguments-content"></div>
    <div class="section-label result-label">Result</div>
    <div class="section-content result-content"></div>
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

class KikxCommandResult extends HTMLElement {
  static get observedAttributes() {
    return ['command-name', 'status'];
  }

  constructor() {
    super();
    this._expanded   = false;
    this._arguments  = '';
    this._result     = '';
    this._onHeaderClick = this._onHeaderClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._header             = this.querySelector('.command-header');
      this._collapseIndicator  = this.querySelector('.collapse-indicator');
      this._commandName        = this.querySelector('.command-name');
      this._statusBadge        = this.querySelector('.status-badge');
      this._body               = this.querySelector('.command-body');
      this._argumentsContent   = this.querySelector('.arguments-content');
      this._resultContent      = this.querySelector('.result-content');
    }

    this._header.addEventListener('click', this._onHeaderClick);
    this._render();
  }

  disconnectedCallback() {
    this._header.removeEventListener('click', this._onHeaderClick);
  }

  attributeChangedCallback() {
    if (this.isConnected)
      this._render();
  }

  // ---------------------------------------------------------------------------
  // Public properties
  // ---------------------------------------------------------------------------

  get arguments() {
    return this._arguments;
  }

  set arguments(value) {
    this._arguments = value;
    this._renderArguments();
  }

  get result() {
    return this._result;
  }

  set result(value) {
    this._result = value;
    this._renderResult();
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  toggle() {
    if (this._expanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  expand() {
    this._expanded = true;
    this._body.classList.add('expanded');
    this._collapseIndicator.classList.add('expanded');
  }

  collapse() {
    this._expanded = false;
    this._body.classList.remove('expanded');
    this._collapseIndicator.classList.remove('expanded');
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  _onHeaderClick() {
    this.toggle();
  }

  _render() {
    this._commandName.textContent = this.getAttribute('command-name') || '';
    this._renderStatus();
  }

  _renderStatus() {
    let status = this.getAttribute('status') || '';

    this._statusBadge.textContent = status;
    this._statusBadge.className   = 'status-badge';

    if (status)
      this._statusBadge.classList.add(status);
  }

  _renderArguments() {
    if (!this._argumentsContent)
      return;

    let value = this._arguments;

    if (value && typeof value === 'object')
      value = JSON.stringify(value, null, 2);

    this._argumentsContent.textContent = value || '';
  }

  _renderResult() {
    if (!this._resultContent)
      return;

    this._resultContent.textContent = this._result || '';
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-command-result', KikxCommandResult);

export default KikxCommandResult;
