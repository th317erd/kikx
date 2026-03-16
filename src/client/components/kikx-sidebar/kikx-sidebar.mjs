'use strict';

import { t } from '../../lib/i18n.mjs';
import { glowInitCSS, glowCSS, glowHoverCSS } from '../../styles/glow-focus.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: flex;
      flex-direction: column;
      width: 300px;
      height: 100%;
      overflow: hidden;
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(var(--glass-blur, 16px));
      -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
      border-left: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow:
        -2px 0 20px rgba(0, 0, 0, 0.3),
        -1px 0 15px rgba(0, 229, 255, 0.08),
        -1px 0 30px rgba(176, 64, 255, 0.05);
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
      padding: 14px var(--spacing-sm, 8px) var(--spacing-sm, 8px);
      flex-shrink: 0;
      overflow: visible;
    }

    .search-wrapper {
      flex: 1;
      position: relative;
      isolation: isolate;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-medium, 8px);
      transition: border-color 0.2s ease;
    }

    .search-wrapper:focus-within {
      border-color: var(--accent-primary, #00e5ff);
    }

    ${glowInitCSS('.search-wrapper')}
    ${glowHoverCSS('.search-wrapper:hover:not(:focus-within)')}
    ${glowCSS('.search-wrapper:focus-within')}

    .search-input {
      width: 100%;
      padding: 8px 12px;
      background: transparent;
      border: none;
      border-radius: inherit;
      color: var(--text-primary, #e8e8f0);
      font-size: 1rem;
      outline: none;
      box-sizing: border-box;
    }

    .search-input::placeholder {
      color: var(--input-placeholder, var(--text-muted, #606078));
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
      flex-shrink: 0;
    }

    .section-label {
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary, #a0a0b8);
    }

    .section-add-button {
      background: var(--glass-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      color: var(--accent-primary, #00e5ff);
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      padding: 4px 12px;
      line-height: 1.2;
      border-radius: var(--border-radius-medium, 8px);
      transition: background 0.2s ease, box-shadow 0.2s ease;
    }

    .section-add-button:hover {
      background: rgba(255, 255, 255, 0.10);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.20));
    }

    .friends-area {
      flex-shrink: 0;
      max-height: 200px;
      overflow-y: auto;
      overflow-x: clip;
      padding: 14px 14px;
    }

    .friends-area::-webkit-scrollbar { width: 6px; }
    .friends-area::-webkit-scrollbar-track { background: transparent; }
    .friends-area::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    .friends-area::-webkit-scrollbar-button { display: none; }

    .session-list {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      padding: 4px 10px;
    }

    .session-list::-webkit-scrollbar { width: 6px; }
    .session-list::-webkit-scrollbar-track { background: transparent; }
    .session-list::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    .session-list::-webkit-scrollbar-thumb:hover {
      background: var(--text-muted, #606078);
    }
    .session-list::-webkit-scrollbar-button { display: none; }

    .session-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: 6px var(--spacing-sm, 8px);
      cursor: pointer;
      border-radius: var(--border-radius-small, 4px);
      transition: background 0.15s ease, box-shadow 0.15s ease;
      position: relative;
      isolation: isolate;
    }

    .session-row:hover {
      background: var(--glass-background-hover, rgba(255, 255, 255, 0.08));
    }

    .session-row.active {
      background: var(--accent-dim, rgba(0, 229, 255, 0.10));
      border-left: 2px solid var(--accent-primary, #00e5ff);
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.10));
    }

    ${glowInitCSS('.session-row')}
    ${glowHoverCSS('.session-row:hover:not(.active)')}
    ${glowCSS('.session-row.active')}

    .session-icon {
      font-size: 1rem;
      flex-shrink: 0;
      opacity: 0.6;
    }

    .session-name {
      flex: 1;
      font-size: 1rem;
      color: var(--text-primary, #e8e8f0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sessions-empty {
      padding: var(--spacing-sm, 8px);
      font-size: 1rem;
      color: var(--text-muted, #606078);
      font-style: italic;
    }
  </style>

  <div class="search-area">
    <div class="search-wrapper">
      <input class="search-input" type="text" />
    </div>
    <button class="archive-toggle"></button>
  </div>
  <div class="section-header friends-header">
    <span class="section-label friends-label"></span>
    <button class="section-add-button add-friend-button"></button>
  </div>
  <div class="friends-area" tabindex="-1">
    <kikx-friends-list></kikx-friends-list>
  </div>
  <div class="section-header sessions-header">
    <span class="section-label sessions-label"></span>
    <button class="section-add-button add-session-button"></button>
  </div>
  <div class="session-list" tabindex="-1"></div>
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

    this._searchInput       = this.shadowRoot.querySelector('.search-input');
    this._archiveToggle     = this.shadowRoot.querySelector('.archive-toggle');
    this._friendsLabel      = this.shadowRoot.querySelector('.friends-label');
    this._sessionsLabel     = this.shadowRoot.querySelector('.sessions-label');
    this._addFriendButton   = this.shadowRoot.querySelector('.add-friend-button');
    this._addSessionButton  = this.shadowRoot.querySelector('.add-session-button');
    this._friendsList       = this.shadowRoot.querySelector('kikx-friends-list');
    this._sessionList       = this.shadowRoot.querySelector('.session-list');

    this._sessions         = [];
    this._activeSessionID  = null;
    this._archiveVisible = false;

    this._onArchiveToggle    = this._onArchiveToggle.bind(this);
    this._onAddFriendClick   = this._onAddFriendClick.bind(this);
    this._onAddSessionClick  = this._onAddSessionClick.bind(this);
    this._onSessionClick     = this._onSessionClick.bind(this);
  }

  connectedCallback() {
    this._render();
    this._archiveToggle.addEventListener('click', this._onArchiveToggle);
    this._addFriendButton.addEventListener('click', this._onAddFriendClick);
    this._addSessionButton.addEventListener('click', this._onAddSessionClick);
    this._sessionList.addEventListener('click', this._onSessionClick);

    // Random glow offset for search wrapper
    let searchWrapper = this.shadowRoot.querySelector('.search-wrapper');
    searchWrapper.style.animationDelay = `${-Math.random() * 20}s, ${-Math.random() * 30}s`;
  }

  disconnectedCallback() {
    this._archiveToggle.removeEventListener('click', this._onArchiveToggle);
    this._addFriendButton.removeEventListener('click', this._onAddFriendClick);
    this._addSessionButton.removeEventListener('click', this._onAddSessionClick);
    this._sessionList.removeEventListener('click', this._onSessionClick);
  }

  set friends(value) {
    if (this._friendsList)
      this._friendsList.friends = value;
  }

  get friends() {
    return (this._friendsList) ? this._friendsList.friends : [];
  }

  set sessions(value) {
    this._sessions = Array.isArray(value) ? value : [];
    this._renderSessions();
  }

  get sessions() {
    return this._sessions;
  }

  set activeSessionID(value) {
    this._activeSessionID = value || null;
    this._updateActiveSession();
  }

  get activeSessionID() {
    return this._activeSessionID;
  }

  _updateActiveSession() {
    if (!this._sessionList)
      return;

    let rows = this._sessionList.querySelectorAll('.session-row');

    for (let row of rows) {
      if (row.dataset.id === this._activeSessionID)
        row.classList.add('active');
      else
        row.classList.remove('active');
    }

    // For DM sessions, highlight the corresponding friend in the friends list
    if (this._friendsList) {
      let activeFriendID = null;

      if (this._activeSessionID) {
        let session = this._sessions.find((s) => s.id === this._activeSessionID);

        if (session && session.type === 'dm' && session.dmAgentID)
          activeFriendID = session.dmAgentID;
      }

      this._friendsList.activeFriendID = activeFriendID;
    }
  }

  _renderSessions() {
    if (!this._sessionList)
      return;

    this._sessionList.innerHTML = '';

    let visibleSessions = this._sessions.filter((s) => !s.archived && s.type !== 'dm');

    if (visibleSessions.length === 0) {
      let empty = document.createElement('div');
      empty.className   = 'sessions-empty';
      empty.textContent = t('sidebar.noSessions') || 'No sessions yet.';
      this._sessionList.appendChild(empty);
      return;
    }

    for (let session of visibleSessions) {
      let row = document.createElement('div');
      row.className  = (session.id === this._activeSessionID) ? 'session-row active' : 'session-row';
      row.dataset.id = session.id;

      // Random glow offset so rows don't all rotate in sync
      row.style.animationDelay = `${-Math.random() * 20}s, ${-Math.random() * 30}s`;

      let icon = document.createElement('span');
      icon.className   = 'session-icon';
      icon.textContent = (session.type === 'dm') ? '\uD83D\uDCAC' : '\uD83D\uDCC1';
      row.appendChild(icon);

      let nameSpan = document.createElement('span');
      nameSpan.className   = 'session-name';

      let displayName = session.name || session.id;
      if (displayName.startsWith('DM: '))
        displayName = displayName.slice(4);

      nameSpan.textContent = displayName;
      row.appendChild(nameSpan);

      this._sessionList.appendChild(row);
    }
  }

  _render() {
    this._searchInput.placeholder       = t('sidebar.searchPlaceholder');
    this._friendsLabel.textContent      = t('sidebar.friends');
    this._sessionsLabel.textContent     = t('sidebar.sessions');
    this._addFriendButton.textContent   = t('sidebar.addFriend');
    this._addSessionButton.textContent  = t('sidebar.addSession');
    this._archiveToggle.textContent     = t('sidebar.archiveHide');
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

  _onAddFriendClick() {
    this.dispatchEvent(new CustomEvent('add-friend', {
      bubbles:  true,
      composed: true,
    }));
  }

  _onAddSessionClick() {
    this.dispatchEvent(new CustomEvent('add-session', {
      bubbles:  true,
      composed: true,
    }));
  }

  _onSessionClick(event) {
    let row = event.target.closest('.session-row');
    if (!row)
      return;

    this.dispatchEvent(new CustomEvent('select-session', {
      bubbles:  true,
      composed: true,
      detail:   { id: row.dataset.id },
    }));
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-sidebar', KikxSidebar);

export default KikxSidebar;
