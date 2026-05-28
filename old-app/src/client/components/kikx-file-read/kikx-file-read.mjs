'use strict';

// =============================================================================
// kikx-file-read
// =============================================================================
// Collapsible panel displaying file contents with line numbers.
// Used to render `tool-activity` frames with renderType 'file-read'.
// =============================================================================

const TEMPLATE_HTML = `
  <style>
    kikx-file-read {
      display: block;
      border-radius: var(--border-radius-small, 4px);
      overflow: hidden;
      font-size: 1rem;
    }

    kikx-file-read .file-header {
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

    kikx-file-read .file-header:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    kikx-file-read .collapse-indicator {
      display: inline-block;
      font-size: 1rem;
      transition: transform 0.2s ease;
    }

    kikx-file-read .collapse-indicator.expanded {
      transform: rotate(90deg);
    }

    kikx-file-read .file-icon {
      font-size: 1rem;
    }

    kikx-file-read .file-path {
      font-weight: 600;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
    }

    kikx-file-read .line-count {
      margin-left: auto;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-muted, #606078);
      white-space: nowrap;
    }

    kikx-file-read .file-body {
      display: none;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-top: none;
      border-radius: 0 0 var(--border-radius-small, 4px) var(--border-radius-small, 4px);
      max-height: 400px;
      overflow: auto;
    }

    kikx-file-read .file-body.expanded {
      display: block;
    }

    kikx-file-read .file-lines {
      margin: 0;
      padding: 4px 0;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.85rem;
      line-height: 1.5;
      white-space: pre;
      tab-size: 2;
    }

    kikx-file-read .line {
      display: block;
      padding: 0 8px 0 0;
    }

    kikx-file-read .line::before {
      content: attr(data-line-number);
      display: inline-block;
      width: 4em;
      padding-right: 8px;
      text-align: right;
      color: var(--text-muted, #606078);
      user-select: none;
      opacity: 0.6;
    }

    kikx-file-read .line:hover {
      background: rgba(255, 255, 255, 0.03);
    }
  </style>

  <button class="file-header">
    <span class="collapse-indicator">\u25B6</span>
    <span class="file-icon">\uD83D\uDCC4</span>
    <span class="file-path"></span>
    <span class="line-count"></span>
  </button>
  <div class="file-body">
    <div class="file-lines"></div>
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

class KikxFileRead extends HTMLElement {
  static get observedAttributes() {
    return ['file-path', 'language'];
  }

  constructor() {
    super();
    this._expanded      = false;
    this._fileContent   = '';
    this._lineCount     = 0;
    this._totalLines    = 0;
    this._offset        = 0;
    this._onHeaderClick = this._onHeaderClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._header             = this.querySelector('.file-header');
      this._collapseIndicator  = this.querySelector('.collapse-indicator');
      this._filePathElement    = this.querySelector('.file-path');
      this._lineCountElement   = this.querySelector('.line-count');
      this._body               = this.querySelector('.file-body');
      this._linesContainer     = this.querySelector('.file-lines');
    }

    this._header.addEventListener('click', this._onHeaderClick);
    this._render();
  }

  disconnectedCallback() {
    if (this._header)
      this._header.removeEventListener('click', this._onHeaderClick);
  }

  attributeChangedCallback() {
    if (this.isConnected)
      this._render();
  }

  // ---------------------------------------------------------------------------
  // Public properties
  // ---------------------------------------------------------------------------

  get fileContent() {
    return this._fileContent;
  }

  set fileContent(value) {
    this._fileContent = value || '';
    this._renderLines();
  }

  get lineCount() {
    return this._lineCount;
  }

  set lineCount(value) {
    this._lineCount = value || 0;
    this._renderHeader();
  }

  get totalLines() {
    return this._totalLines;
  }

  set totalLines(value) {
    this._totalLines = value || 0;
    this._renderHeader();
  }

  get offset() {
    return this._offset;
  }

  set offset(value) {
    this._offset = value || 0;
    this._renderLines();
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  toggle() {
    if (this._expanded)
      this.collapse();
    else
      this.expand();
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
    this._renderHeader();
    this._renderLines();
  }

  _renderHeader() {
    if (!this._filePathElement)
      return;

    this._filePathElement.textContent = this.getAttribute('file-path') || '';

    let display = this._totalLines || this._lineCount;
    this._lineCountElement.textContent = (display) ? `(${display} lines)` : '';
  }

  _renderLines() {
    if (!this._linesContainer)
      return;

    let content = this._fileContent;
    if (!content) {
      this._linesContainer.innerHTML = '';
      return;
    }

    let lines    = content.split('\n');
    let offset   = this._offset || 0;
    let fragment = document.createDocumentFragment();

    for (let i = 0; i < lines.length; i++) {
      let span = document.createElement('span');
      span.className = 'line';
      span.setAttribute('data-line-number', String(offset + i + 1));
      span.textContent = lines[i];
      fragment.appendChild(span);
    }

    this._linesContainer.innerHTML = '';
    this._linesContainer.appendChild(fragment);
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-file-read', KikxFileRead);

export default KikxFileRead;
