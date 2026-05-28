'use strict';

// =============================================================================
// kikx-file-write
// =============================================================================
// Collapsible diff panel for file write/edit operations.
// Used to render `tool-activity` frames with renderType 'file-write'.
// Shared by both files:write and files:edit since both produce diffs.
// =============================================================================

const TEMPLATE_HTML = `
  <style>
    kikx-file-write {
      display: block;
      border-radius: var(--border-radius-small, 4px);
      overflow: hidden;
      font-size: 1rem;
    }

    kikx-file-write .file-header {
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

    kikx-file-write .file-header:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    kikx-file-write .collapse-indicator {
      display: inline-block;
      font-size: 1rem;
      transition: transform 0.2s ease;
    }

    kikx-file-write .collapse-indicator.expanded {
      transform: rotate(90deg);
    }

    kikx-file-write .file-icon {
      font-size: 1rem;
    }

    kikx-file-write .file-path {
      font-weight: 600;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
    }

    kikx-file-write .diff-stats {
      display: flex;
      gap: 6px;
      margin-left: 6px;
      font-size: 1rem;
      font-weight: 600;
      white-space: nowrap;
    }

    kikx-file-write .diff-stats .additions {
      color: #66bb6a;
    }

    kikx-file-write .diff-stats .removals {
      color: #ef5350;
    }

    kikx-file-write .status-badge {
      margin-left: auto;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
    }

    kikx-file-write .status-badge.created {
      background: rgba(76, 175, 80, 0.2);
      color: #66bb6a;
    }

    kikx-file-write .status-badge.modified {
      background: rgba(255, 183, 77, 0.2);
      color: #ffb74d;
    }

    kikx-file-write .file-body {
      display: none;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-top: none;
      border-radius: 0 0 var(--border-radius-small, 4px) var(--border-radius-small, 4px);
      max-height: 400px;
      overflow: auto;
    }

    kikx-file-write .file-body.expanded {
      display: block;
    }

    kikx-file-write .diff-lines {
      margin: 0;
      padding: 4px 0;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.85rem;
      line-height: 1.5;
      white-space: pre;
      tab-size: 2;
    }

    kikx-file-write .diff-line {
      display: block;
      padding: 0 8px 0 0;
    }

    kikx-file-write .diff-line.add {
      background: rgba(76, 175, 80, 0.12);
      color: #a5d6a7;
    }

    kikx-file-write .diff-line.remove {
      background: rgba(229, 57, 53, 0.12);
      color: #ef9a9a;
    }

    kikx-file-write .diff-line.context {
      color: var(--text-primary, #e8e8f0);
    }

    kikx-file-write .diff-line .gutter {
      display: inline-block;
      width: 8em;
      padding-right: 4px;
      text-align: right;
      color: var(--text-muted, #606078);
      user-select: none;
      opacity: 0.6;
    }

    kikx-file-write .diff-line .prefix {
      display: inline-block;
      width: 1.5em;
      text-align: center;
      user-select: none;
    }

    kikx-file-write .diff-line.add .prefix {
      color: #66bb6a;
    }

    kikx-file-write .diff-line.remove .prefix {
      color: #ef5350;
    }

    kikx-file-write .hunk-separator {
      display: block;
      padding: 2px 8px;
      color: var(--text-muted, #606078);
      background: rgba(255, 255, 255, 0.02);
      font-style: italic;
      user-select: none;
    }
  </style>

  <button class="file-header">
    <span class="collapse-indicator">\u25B6</span>
    <span class="file-icon">\u270F\uFE0F</span>
    <span class="file-path"></span>
    <span class="diff-stats">
      <span class="additions"></span>
      <span class="removals"></span>
    </span>
    <span class="status-badge"></span>
  </button>
  <div class="file-body">
    <div class="diff-lines"></div>
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

class KikxFileWrite extends HTMLElement {
  static get observedAttributes() {
    return ['file-path', 'created'];
  }

  constructor() {
    super();
    this._expanded      = false;
    this._diff          = null;
    this._onHeaderClick = this._onHeaderClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._header            = this.querySelector('.file-header');
      this._collapseIndicator = this.querySelector('.collapse-indicator');
      this._filePathElement   = this.querySelector('.file-path');
      this._additionsElement  = this.querySelector('.diff-stats .additions');
      this._removalsElement   = this.querySelector('.diff-stats .removals');
      this._statusBadge       = this.querySelector('.status-badge');
      this._body              = this.querySelector('.file-body');
      this._diffContainer     = this.querySelector('.diff-lines');
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

  get diff() {
    return this._diff;
  }

  set diff(value) {
    this._diff = value;
    this._render();
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
    this._renderDiff();
  }

  _renderHeader() {
    if (!this._filePathElement)
      return;

    this._filePathElement.textContent = this.getAttribute('file-path') || '';

    let isCreated = this.hasAttribute('created');
    this._statusBadge.textContent = (isCreated) ? 'Created' : 'Modified';
    this._statusBadge.className   = 'status-badge ' + ((isCreated) ? 'created' : 'modified');

    let diff = this._diff;
    if (diff) {
      let additions = diff.additions || 0;
      let removals  = diff.removals || 0;

      this._additionsElement.textContent = (additions > 0) ? `+${additions}` : '';
      this._removalsElement.textContent  = (removals > 0) ? `-${removals}` : '';
    } else {
      this._additionsElement.textContent = '';
      this._removalsElement.textContent  = '';
    }
  }

  _renderDiff() {
    if (!this._diffContainer)
      return;

    let diff = this._diff;
    if (!diff || !diff.hunks || diff.hunks.length === 0) {
      this._diffContainer.innerHTML = '';
      return;
    }

    let fragment = document.createDocumentFragment();

    for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
      let hunk = diff.hunks[hunkIndex];

      // Hunk separator (except for the first hunk)
      if (hunkIndex > 0) {
        let separator = document.createElement('span');
        separator.className = 'hunk-separator';
        separator.textContent = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
        fragment.appendChild(separator);
      }

      for (let line of hunk.lines) {
        let span = document.createElement('span');
        span.className = `diff-line ${line.type}`;

        // Gutter with line numbers
        let gutter = document.createElement('span');
        gutter.className = 'gutter';

        let oldNum = (line.oldLine !== null) ? String(line.oldLine) : '';
        let newNum = (line.newLine !== null) ? String(line.newLine) : '';
        gutter.textContent = `${oldNum.padStart(4, ' ')} ${newNum.padStart(4, ' ')}`;

        // Prefix indicator
        let prefix = document.createElement('span');
        prefix.className = 'prefix';

        if (line.type === 'add')
          prefix.textContent = '+';
        else if (line.type === 'remove')
          prefix.textContent = '-';
        else
          prefix.textContent = ' ';

        span.appendChild(gutter);
        span.appendChild(prefix);
        span.appendChild(document.createTextNode(line.content));
        fragment.appendChild(span);
      }
    }

    this._diffContainer.innerHTML = '';
    this._diffContainer.appendChild(fragment);
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-file-write', KikxFileWrite);

export default KikxFileWrite;
