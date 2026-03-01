'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: flex;
      flex-direction: column;
      width: 300px;
      height: 100%;
      overflow: hidden;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-left: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      box-shadow: -2px 0 16px var(--accent-glow, rgba(0, 229, 255, 0.15));
      color: var(--text-primary, #e8e8f0);
      transition: width 0.3s ease;
    }

    :host([collapsed]) {
      width: 0;
      overflow: hidden;
    }

    .search-area {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: var(--spacing-sm, 8px);
      flex-shrink: 0;
    }

    .search-input {
      flex: 1;
      padding: 8px 12px;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-primary, #e8e8f0);
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .search-input::placeholder {
      color: var(--input-placeholder, var(--text-muted, #606078));
    }

    .search-input:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    .archive-toggle {
      background: none;
      border: none;
      font-size: 1.25rem;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.2s ease;
    }

    .archive-toggle:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    .section-header {
      padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary, #a0a0b8);
      flex-shrink: 0;
    }

    .session-list {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }

    .session-list::-webkit-scrollbar {
      width: 6px;
    }

    .session-list::-webkit-scrollbar-track {
      background: transparent;
    }

    .session-list::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }

    .session-list::-webkit-scrollbar-thumb:hover {
      background: var(--text-muted, #606078);
    }

    .participant-list {
      flex-shrink: 0;
      border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      max-height: 200px;
      overflow-y: auto;
    }
  </style>

  <div class="search-area">
    <input class="search-input" type="text" />
    <button class="archive-toggle"></button>
  </div>
  <div class="section-header sessions-header"></div>
  <div class="session-list"></div>
  <div class="section-header participants-header"></div>
  <div class="participant-list"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxSidebar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._searchInput        = this.shadowRoot.querySelector('.search-input');
    this._archiveToggle      = this.shadowRoot.querySelector('.archive-toggle');
    this._sessionsHeader     = this.shadowRoot.querySelector('.sessions-header');
    this._participantsHeader = this.shadowRoot.querySelector('.participants-header');

    this._archiveVisible = false;

    this._onArchiveToggle = this._onArchiveToggle.bind(this);
  }

  connectedCallback() {
    this._render();
    this._archiveToggle.addEventListener('click', this._onArchiveToggle);
  }

  disconnectedCallback() {
    this._archiveToggle.removeEventListener('click', this._onArchiveToggle);
  }

  _render() {
    this._searchInput.placeholder        = t('sidebar.searchPlaceholder');
    this._sessionsHeader.textContent     = t('sidebar.sessions');
    this._participantsHeader.textContent = t('sidebar.participants');
    this._archiveToggle.textContent      = t('sidebar.archiveHide');
  }

  _onArchiveToggle() {
    this._archiveVisible = !this._archiveVisible;

    this._archiveToggle.textContent = (this._archiveVisible)
      ? t('sidebar.archiveShow')
      : t('sidebar.archiveHide');

    this.dispatchEvent(new CustomEvent('toggle-archive', {
      bubbles:  true,
      composed: true,
      detail:   { visible: this._archiveVisible },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-sidebar', KikxSidebar);

export default KikxSidebar;
