'use strict';

const TEMPLATE_HTML = `
  <style>
    :host { display: block; border-radius: var(--border-radius-small, 4px); }

    .search-header {
      display: flex; align-items: center; gap: var(--spacing-xs, 4px);
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-small, 4px);
      font-size: 0.8125rem; color: var(--text-secondary, #a0a0b8);
    }

    .search-icon { font-size: 1rem; }

    .status-text { font-weight: 600; }

    .status-text.searching { color: var(--accent-primary, #00e5ff); }
    .status-text.completed { color: #66bb6a; }
    .status-text.error { color: #ef5350; }

    .results-list {
      display: flex; flex-direction: column; gap: var(--spacing-xs, 4px);
      padding: var(--spacing-xs, 4px) 0;
    }

    .result-entry {
      padding: 6px 8px;
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.2s ease;
    }

    .result-entry:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

    .result-title {
      font-weight: 600; font-size: 0.875rem;
      color: var(--accent-primary, #00e5ff);
      text-decoration: none; display: block;
    }

    .result-title:hover { text-decoration: underline; }

    .result-url {
      font-size: 0.75rem; color: var(--text-muted, #606078);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .result-snippet {
      font-size: 0.8125rem; color: var(--text-secondary, #a0a0b8);
      line-height: 1.4; margin-top: 2px;
    }
  </style>

  <div class="search-header">
    <span class="search-icon">\uD83D\uDD0D</span>
    <span class="status-text"></span>
  </div>
  <div class="results-list"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

const STATUS_LABELS = {
  searching: 'Searching...',
  completed: 'Completed',
  error: 'Error',
};

class KikxWebsearchResult extends HTMLElement {
  static get observedAttributes() {
    return ['status'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._statusText  = this.shadowRoot.querySelector('.status-text');
    this._resultsList = this.shadowRoot.querySelector('.results-list');
    this._results     = [];
  }

  connectedCallback() {
    this._renderStatus();
  }

  attributeChangedCallback() {
    if (this.isConnected)
      this._renderStatus();
  }

  // ---------------------------------------------------------------------------
  // Public properties
  // ---------------------------------------------------------------------------

  get results() {
    return this._results;
  }

  set results(value) {
    this._results = Array.isArray(value) ? value : [];
    this._renderResults();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  _renderStatus() {
    let status = this.getAttribute('status') || '';

    this._statusText.textContent = STATUS_LABELS[status] || '';
    this._statusText.className   = 'status-text';

    if (status)
      this._statusText.classList.add(status);
  }

  _renderResults() {
    this._resultsList.innerHTML = '';

    for (let result of this._results) {
      let entry = document.createElement('div');
      entry.className = 'result-entry';

      let title = document.createElement('a');
      title.className  = 'result-title';
      title.href       = result.url || '#';
      title.target     = '_blank';
      title.rel        = 'noopener noreferrer';
      title.textContent = result.title || '';

      let url = document.createElement('div');
      url.className   = 'result-url';
      url.textContent = result.url || '';

      let snippet = document.createElement('div');
      snippet.className   = 'result-snippet';
      snippet.textContent = result.snippet || '';

      entry.appendChild(title);
      entry.appendChild(url);
      entry.appendChild(snippet);
      this._resultsList.appendChild(entry);
    }
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-websearch-result', KikxWebsearchResult);

export default KikxWebsearchResult;
