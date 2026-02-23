'use strict';

/**
 * Hero Participant List — Session Participant Sidebar Component
 *
 * Displays all participants (users and agents) in the current session
 * with their roles, aliases, and avatars.
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// ============================================================================
// HeroParticipantList Component
// ============================================================================

export class HeroParticipantList extends HeroComponent {
  static tagName = 'hero-participant-list';

  #participants = [];
  #sessionId    = null;

  // ---------------------------------------------------------------------------
  // Shadow DOM
  // ---------------------------------------------------------------------------

  createShadowDOM() {
    return this.attachShadow({ mode: 'open' });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  mounted() {
    // Listen for session changes via viewchange
    document.addEventListener('viewchange', (event) => {
      if (event.detail.view === 'chat')
        this._loadFromSession();
    });

    // Listen for participant updates via custom event
    document.addEventListener('participants-updated', () => {
      this._loadFromSession();
    });
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Update the participant list with fresh data.
   * @param {Object[]} participants - Array of participant objects
   * @param {number} sessionId - Current session ID
   */
  setParticipants(participants, sessionId) {
    this.#participants = participants || [];
    this.#sessionId    = sessionId;
    this._render();
  }

  /**
   * Get current participant count.
   * @returns {number}
   */
  get participantCount() {
    return this.#participants.length;
  }

  // ---------------------------------------------------------------------------
  // Private: Data Loading
  // ---------------------------------------------------------------------------

  _loadFromSession() {
    let session = window.state?.currentSession;
    if (!session)
      return;

    this.#sessionId    = session.id;
    this.#participants = session.participants || [];
    this._render();
  }

  // ---------------------------------------------------------------------------
  // Private: Rendering
  // ---------------------------------------------------------------------------

  _render() {
    let container = this.shadowRoot.querySelector('.participant-list');
    if (!container)
      return;

    if (this.#participants.length === 0) {
      container.innerHTML = '<p class="empty">No participants</p>';
      return;
    }

    // Separate into coordinators, members, and users
    let coordinators = this.#participants.filter((p) => p.role === 'coordinator');
    let members      = this.#participants.filter((p) => p.role === 'member' && p.participantType === 'agent');
    let users        = this.#participants.filter((p) => p.participantType === 'user');

    let html = '';

    if (coordinators.length > 0) {
      html += '<div class="section-label">Coordinator</div>';
      html += coordinators.map((p) => this._renderParticipant(p)).join('');
    }

    if (members.length > 0) {
      html += '<div class="section-label">Members</div>';
      html += members.map((p) => this._renderParticipant(p)).join('');
    }

    if (users.length > 0) {
      html += '<div class="section-label">Users</div>';
      html += users.map((p) => this._renderParticipant(p)).join('');
    }

    container.innerHTML = html;
  }

  _renderParticipant(participant) {
    let displayName = this._escapeHtml(this._getDisplayName(participant));
    let aliasHtml = '';
    if (participant.alias) {
      // Show alias as primary name, real name underneath
      displayName = this._escapeHtml(participant.alias);
      let realName = participant.name || '';
      if (realName)
        aliasHtml = `<span class="alias">${this._escapeHtml(realName)}</span>`;
    }

    let avatarHtml = '';
    if (participant.avatarUrl) {
      avatarHtml = `<img class="participant-avatar" src="${this._escapeAttr(participant.avatarUrl)}" alt="">`;
    } else {
      let icon = (participant.participantType === 'agent') ? '&#x1F916;' : '&#x1F464;';
      avatarHtml = `<span class="icon">${icon}</span>`;
    }

    let role = this._escapeHtml(participant.role);

    return `
      <div class="participant" data-participant-id="${participant.participantId}" data-participant-type="${participant.participantType}">
        ${avatarHtml}
        <div class="info">
          <span class="name">${displayName}</span>
          ${aliasHtml}
        </div>
        <span class="role-badge role-${role}">${role}</span>
      </div>
    `;
  }

  _getDisplayName(participant) {
    // Use enriched name from API if available
    if (participant.name)
      return participant.name;

    // Look up agent/user name from global state as fallback
    if (participant.participantType === 'agent') {
      let agents = GlobalState.agents?.valueOf() || [];
      let agent  = agents.find((a) => a.id === participant.participantId);
      return agent?.name || `Agent #${participant.participantId}`;
    }

    let user = GlobalState.user?.valueOf();
    if (user && user.id === participant.participantId)
      return user.displayName || user.username || `User #${participant.participantId}`;

    return `User #${participant.participantId}`;
  }

  // ---------------------------------------------------------------------------
  // Private: Utilities
  // ---------------------------------------------------------------------------

  _escapeHtml(text) {
    if (!text) return '';
    let div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  _escapeAttr(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
}

// Register the component
HeroParticipantList.register();
