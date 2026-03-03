'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: block;
      overflow-y: auto;
    }

    :host::-webkit-scrollbar { width: 6px; }
    :host::-webkit-scrollbar-track { background: transparent; }
    :host::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    :host::-webkit-scrollbar-thumb:hover {
      background: var(--text-muted, #606078);
    }

    .friend-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: 6px var(--spacing-sm, 8px);
      cursor: pointer;
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.15s ease;
    }

    .friend-row:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    .friend-name {
      flex: 1;
      font-size: 0.875rem;
      color: var(--text-primary, #e8e8f0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .agent-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.65rem;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 9999px;
      background: var(--accent-primary, #00e5ff);
      color: var(--text-inverse, #0a0a1a);
      letter-spacing: 0.03em;
      flex-shrink: 0;
    }

    .online-indicator {
      display: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4caf50;
      flex-shrink: 0;
    }

    .empty-message {
      padding: var(--spacing-sm, 8px);
      font-size: 0.8rem;
      color: var(--text-muted, #606078);
      font-style: italic;
    }
  </style>
  <div class="list-container"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxFriendsList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._container = this.shadowRoot.querySelector('.list-container');
    this._friends   = [];

    this._onRowClick = this._onRowClick.bind(this);
  }

  connectedCallback() {
    this._render();
    this._container.addEventListener('click', this._onRowClick);
  }

  disconnectedCallback() {
    this._container.removeEventListener('click', this._onRowClick);
  }

  set friends(value) {
    this._friends = Array.isArray(value) ? value : [];
    this._render();
  }

  get friends() {
    return this._friends;
  }

  _render() {
    if (!this._container)
      return;

    this._container.innerHTML = '';

    if (this._friends.length === 0) {
      let empty = document.createElement('div');
      empty.className   = 'empty-message';
      empty.textContent = t('friends.empty');
      this._container.appendChild(empty);
      return;
    }

    for (let friend of this._friends) {
      let row = document.createElement('div');
      row.className     = 'friend-row';
      row.dataset.id    = friend.id;
      row.dataset.type  = friend.type || 'agent';

      let avatar = document.createElement('kikx-user-avatar');
      avatar.setAttribute('size', '28');
      if (friend.email)
        avatar.setAttribute('email', friend.email);

      if (friend.avatarData)
        avatar.setAttribute('avatar-data', friend.avatarData);

      if (friend.name) {
        let parts = friend.name.split(' ');
        avatar.setAttribute('first-name', parts[0] || '');
        if (parts[1])
          avatar.setAttribute('last-name', parts[1]);
      }

      row.appendChild(avatar);

      let nameSpan = document.createElement('span');
      nameSpan.className   = 'friend-name';
      nameSpan.textContent = friend.name || friend.email || '';
      row.appendChild(nameSpan);

      if (friend.type === 'agent') {
        let badge = document.createElement('span');
        badge.className   = 'agent-badge';
        badge.textContent = t('friends.agentBadge');
        row.appendChild(badge);
      }

      let onlineIndicator = document.createElement('span');
      onlineIndicator.className = 'online-indicator';
      row.appendChild(onlineIndicator);

      this._container.appendChild(row);
    }
  }

  _onRowClick(event) {
    let row = event.target.closest('.friend-row');
    if (!row)
      return;

    this.dispatchEvent(new CustomEvent('select-friend', {
      bubbles:  true,
      composed: true,
      detail:   { id: row.dataset.id, type: row.dataset.type },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-friends-list', KikxFriendsList);

export default KikxFriendsList;
