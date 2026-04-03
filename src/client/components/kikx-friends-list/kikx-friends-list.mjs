'use strict';

import { t } from '../../lib/i18n.mjs';
import { glowInitCSS, glowCSS, glowHoverCSS } from '../../styles/glow-focus.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-friends-list {
      display: block;
      overflow: visible;
    }

    kikx-friends-list::-webkit-scrollbar { width: 6px; }
    kikx-friends-list::-webkit-scrollbar-track { background: transparent; }
    kikx-friends-list::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    kikx-friends-list::-webkit-scrollbar-thumb:hover {
      background: var(--text-muted, #606078);
    }
    kikx-friends-list::-webkit-scrollbar-button { display: none; }

    kikx-friends-list .friend-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: 6px var(--spacing-sm, 8px);
      cursor: pointer;
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.15s ease;
      position: relative;
      isolation: isolate;
    }

    kikx-friends-list .friend-row:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.08));
    }

    kikx-friends-list .friend-row.active {
      background: var(--accent-dim, rgba(0, 229, 255, 0.10));
      border-left: 2px solid var(--accent-primary, #00e5ff);
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.10));
    }

    ${glowInitCSS('kikx-friends-list .friend-row')}
    ${glowHoverCSS('kikx-friends-list .friend-row:hover:not(.active)')}
    ${glowCSS('kikx-friends-list .friend-row.active')}

    kikx-friends-list .friend-name {
      flex: 1;
      font-size: 1rem;
      color: var(--text-primary, #e8e8f0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    kikx-friends-list .agent-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 9999px;
      background: var(--accent-primary, #00e5ff);
      color: #fff;
      letter-spacing: 0.03em;
      flex-shrink: 0;
    }

    kikx-friends-list .online-indicator {
      display: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4caf50;
      flex-shrink: 0;
    }

    kikx-friends-list .badge-wrapper {
      position: relative;
      flex-shrink: 0;
    }

    kikx-friends-list .edit-icon {
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      color: var(--text-secondary, #a0a0b8);
      cursor: pointer;
      padding: 1px 4px;
    }

    kikx-friends-list .edit-icon:hover {
      color: var(--accent-primary, #00e5ff);
    }

    kikx-friends-list .friend-row:hover .agent-badge {
      display: none;
    }

    kikx-friends-list .friend-row:hover .edit-icon {
      display: inline-flex;
    }

    kikx-friends-list .empty-message {
      padding: var(--spacing-sm, 8px);
      font-size: 1rem;
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
    this._friends        = [];
    this._activeFriendID = null;
    this._onRowClick  = this._onRowClick.bind(this);
    this._onEditClick = this._onEditClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._container = this.querySelector('.list-container');
    }

    this._render();
    this._container.addEventListener('click', this._onRowClick);
    this._container.addEventListener('click', this._onEditClick);
  }

  disconnectedCallback() {
    this._container.removeEventListener('click', this._onRowClick);
    this._container.removeEventListener('click', this._onEditClick);
  }

  set friends(value) {
    this._friends = Array.isArray(value) ? value : [];
    this._render();
  }

  get friends() {
    return this._friends;
  }

  set activeFriendID(value) {
    this._activeFriendID = value || null;
    this._updateActiveFriend();
  }

  get activeFriendID() {
    return this._activeFriendID;
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
      row.className     = (friend.id === this._activeFriendID) ? 'friend-row active' : 'friend-row';
      row.dataset.id    = friend.id;
      row.dataset.type  = friend.type || 'agent';

      // Random glow phase so rows don't all rotate in sync
      row.style.setProperty('--glow-delay-rotate', `${-Math.random() * 20}s`);
      row.style.setProperty('--glow-delay-hue', `${-Math.random() * 30}s`);

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

      // Badge wrapper: shows AI badge normally, edit icon on hover
      let badgeWrapper = document.createElement('span');
      badgeWrapper.className = 'badge-wrapper';

      if (friend.type === 'agent') {
        let badge = document.createElement('span');
        badge.className   = 'agent-badge';
        badge.textContent = t('friends.agentBadge');
        badgeWrapper.appendChild(badge);
      }

      let editIcon = document.createElement('span');
      editIcon.className = 'edit-icon';
      editIcon.textContent = '\u270F\uFE0F';
      editIcon.setAttribute('role', 'button');
      editIcon.setAttribute('aria-label', t('agent.edit.title'));
      badgeWrapper.appendChild(editIcon);

      row.appendChild(badgeWrapper);

      let onlineIndicator = document.createElement('span');
      onlineIndicator.className = 'online-indicator';
      row.appendChild(onlineIndicator);

      this._container.appendChild(row);
    }
  }

  _updateActiveFriend() {
    if (!this._container)
      return;

    let rows = this._container.querySelectorAll('.friend-row');

    for (let row of rows) {
      if (row.dataset.id === this._activeFriendID)
        row.classList.add('active');
      else
        row.classList.remove('active');
    }
  }

  _onRowClick(event) {
    // Ignore clicks on the edit icon — those fire edit-friend instead
    if (event.target.closest('.edit-icon'))
      return;

    let row = event.target.closest('.friend-row');
    if (!row)
      return;

    this.dispatchEvent(new CustomEvent('select-friend', {
      bubbles:  true,
      composed: true,
      detail:   { id: row.dataset.id, type: row.dataset.type },
    }));
  }

  _onEditClick(event) {
    let editIcon = event.target.closest('.edit-icon');
    if (!editIcon)
      return;

    let row = editIcon.closest('.friend-row');
    if (!row)
      return;

    let friend = this._friends.find((f) => f.id === row.dataset.id);

    this.dispatchEvent(new CustomEvent('edit-friend', {
      bubbles:  true,
      composed: true,
      detail:   { id: row.dataset.id, type: row.dataset.type, ...(friend || {}) },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-friends-list', KikxFriendsList);

export default KikxFriendsList;
