'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      overflow-y: auto;
      color: var(--text-primary, #e8e8f0);
    }

    .empty-state {
      padding: var(--spacing-sm, 8px);
      text-align: center;
      color: var(--text-muted, #606078);
      font-size: 1rem;
    }

    .category {
      margin-bottom: var(--spacing-xs, 4px);
    }

    .category-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary, #a0a0b8);
      cursor: pointer;
      user-select: none;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }

    .category-header:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    .collapse-indicator {
      display: inline-block;
      transition: transform 0.2s ease;
      font-size: 1rem;
    }

    .collapse-indicator.collapsed {
      transform: rotate(-90deg);
    }

    .category-items {
      overflow: hidden;
    }

    .category-items.collapsed {
      display: none;
    }

    .session-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: 6px var(--spacing-sm, 8px) 6px 20px;
      cursor: pointer;
      transition: background 0.2s ease;
      border-radius: var(--border-radius-small, 4px);
      margin: 0 var(--spacing-xs, 4px);
    }

    .session-row:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    .session-row.active {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border-left: 2px solid var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.15));
    }

    .session-row.archived {
      opacity: 0.6;
    }

    .session-name {
      flex: 1;
      font-size: 1rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-primary, #e8e8f0);
    }

    .unread-badge {
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 9px;
      background: var(--accent-primary, #00e5ff);
      color: var(--text-inverse, #0a0a1a);
      font-size: 1rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .action-button {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 6px;
      font-size: 1rem;
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-muted, #606078);
      opacity: 0;
      transition: opacity 0.2s ease, background 0.2s ease;
      flex-shrink: 0;
    }

    .session-row:hover .action-button {
      opacity: 1;
    }

    .action-button:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
      color: var(--text-primary, #e8e8f0);
    }
  </style>

  <div class="container"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxSessionList extends HTMLElement {
  static get observedAttributes() {
    return ['show-archived'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._container       = this.shadowRoot.querySelector('.container');
    this._sessions        = [];
    this._filter          = '';
    this._collapsedState  = {};

    this._onContainerClick = this._onContainerClick.bind(this);
  }

  connectedCallback() {
    this._render();
    this._container.addEventListener('click', this._onContainerClick);
  }

  disconnectedCallback() {
    this._container.removeEventListener('click', this._onContainerClick);
  }

  // ---------------------------------------------------------------------------
  // Public properties
  // ---------------------------------------------------------------------------

  set sessions(value) {
    this._sessions = value || [];
    this._render();
  }

  get sessions() {
    return this._sessions;
  }

  set filter(value) {
    this._filter = value || '';
    this._render();
  }

  get filter() {
    return this._filter;
  }

  attributeChangedCallback() {
    this._render();
  }

  // ---------------------------------------------------------------------------
  // Event delegation
  // ---------------------------------------------------------------------------

  _onContainerClick(event) {
    let target = event.target;

    // Category header toggle
    let header = target.closest('.category-header');
    if (header) {
      let category  = header.dataset.category;
      let items     = this._container.querySelector(`.category-items[data-category="${category}"]`);
      let indicator = header.querySelector('.collapse-indicator');

      this._collapsedState[category] = !this._collapsedState[category];

      if (this._collapsedState[category]) {
        items.classList.add('collapsed');
        indicator.classList.add('collapsed');
      } else {
        items.classList.remove('collapsed');
        indicator.classList.remove('collapsed');
      }

      return;
    }

    // Archive / Revive button
    let actionButton = target.closest('.action-button');
    if (actionButton) {
      let sessionID = actionButton.dataset.sessionId;
      let action    = actionButton.dataset.action;

      this.dispatchEvent(new CustomEvent(action, {
        bubbles:  true,
        composed: true,
        detail:   { sessionID },
      }));

      return;
    }

    // Session row select
    let row = target.closest('.session-row');
    if (row) {
      let sessionID = row.dataset.sessionId;

      this.dispatchEvent(new CustomEvent('select-session', {
        bubbles:  true,
        composed: true,
        detail:   { sessionID },
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _render() {
    if (!this._container) return;

    let showArchived  = this.hasAttribute('show-archived');
    let filterLower   = this._filter.toLowerCase();

    // Filter and sort
    let visible = this._sessions.filter((session) => {
      if (session.archived && !showArchived) return false;
      if (filterLower && !session.name.toLowerCase().includes(filterLower)) return false;
      return true;
    });

    visible.sort((a, b) => {
      let timeA = a.lastActivity || 0;
      let timeB = b.lastActivity || 0;
      return timeB - timeA;
    });

    // Empty state
    if (visible.length === 0) {
      this._container.innerHTML = `<div class="empty-state">${t('session.list.empty')}</div>`;
      return;
    }

    // Group into categories
    let channels = visible.filter((session) => session.participantCount >= 3);
    let privates = visible.filter((session) => session.participantCount < 3);

    let html = '';

    if (channels.length > 0) {
      let isCollapsed = this._collapsedState['channels'];
      html += this._renderCategory('channels', t('session.categories.channels'), channels, isCollapsed, showArchived);
    }

    if (privates.length > 0) {
      let isCollapsed = this._collapsedState['private'];
      html += this._renderCategory('private', t('session.categories.private'), privates, isCollapsed, showArchived);
    }

    this._container.innerHTML = html;
  }

  _renderCategory(categoryKey, label, sessions, isCollapsed, showArchived) {
    let collapseClass = isCollapsed ? ' collapsed' : '';

    let html = `<div class="category">`;
    html += `<button class="category-header" data-category="${categoryKey}">`;
    html += `<span class="collapse-indicator${collapseClass}">\u25BC</span> ${label}`;
    html += `</button>`;
    html += `<div class="category-items${collapseClass}" data-category="${categoryKey}">`;

    for (let session of sessions) {
      let activeClass   = session.active ? ' active' : '';
      let archivedClass = session.archived ? ' archived' : '';

      html += `<div class="session-row${activeClass}${archivedClass}" data-session-id="${session.id}">`;
      html += `<span class="session-name">${session.name}</span>`;

      if (session.unreadCount > 0) {
        html += `<span class="unread-badge">${session.unreadCount}</span>`;
      }

      if (session.archived) {
        html += `<button class="action-button" data-session-id="${session.id}" data-action="revive-session">${t('session.archive.reviveAction')}</button>`;
      } else {
        html += `<button class="action-button" data-session-id="${session.id}" data-action="archive-session">${t('session.archive.archiveAction')}</button>`;
      }

      html += `</div>`;
    }

    html += `</div></div>`;
    return html;
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-session-list', KikxSessionList);

export default KikxSessionList;
