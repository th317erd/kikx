'use strict';

/**
 * Hero Sessions List Component
 *
 * Displays:
 * - List of chat sessions
 * - Search/filter functionality
 * - Archive/restore actions
 *
 * Uses mythix-for-each for reactive list rendering with event delegation.
 */

import {
  MythixUIComponent,
  DynamicProperty,
} from '@cdn/mythix-ui-core@1';

// ============================================================================
// GlobalState Reference
// ============================================================================

function getGlobalState() {
  return window.GlobalState;
}

// ============================================================================
// HeroSessionsList Component
// ============================================================================

export class HeroSessionsList extends MythixUIComponent {
  static tagName = 'hero-sessions-list';

  // ============================================================================
  // Constructor
  // ============================================================================

  constructor() {
    super();

    // Local component state
    this.defineDynamicProp('searchQuery', '');
    this.defineDynamicProp('showHidden', false);
    this.defineDynamicProp('filteredSessions', []);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  createShadowDOM() {
    return this.attachShadow({ mode: 'open' });
  }

  mounted() {
    super.mounted();

    let GlobalState = getGlobalState();
    if (!GlobalState) {
      console.warn('[hero-sessions-list] GlobalState not available');
      return;
    }

    // Subscribe to GlobalState changes
    this._unsubscribers = [
      this.subscribeToGlobal('sessions', () => this.updateFilteredSessions()),
      this.subscribeToGlobal('agents', () => this.updateVisibility()),
    ];

    // Subscribe to local state changes
    this.searchQuery.addEventListener('update', () => this.updateFilteredSessions());
    this.showHidden.addEventListener('update', () => {
      this.updateFilteredSessions();
      this.updateToggleButton();
    });
    this.filteredSessions.addEventListener('update', () => {
      this.updateVisibility();
      this.updateForEach();
    });

    // Set up event delegation
    this.setupEventDelegation();

    // Set up search input handler
    this.setupSearchInput();

    // Initial computation
    this.updateFilteredSessions();
    this.updateToggleButton();
    this.updateForEach();
  }

  unmounted() {
    super.unmounted();

    if (this._unsubscribers) {
      for (let unsub of this._unsubscribers) {
        unsub();
      }
      this._unsubscribers = [];
    }
  }

  // ============================================================================
  // Event Delegation Setup
  // ============================================================================

  /**
   * Set up event delegation on the container.
   * Uses data-action attributes to route clicks.
   */
  setupEventDelegation() {
    let container = this.shadow?.querySelector('.sessions-container');
    if (!container) return;

    container.addEventListener('click', (event) => {
      let target = event.target.closest('[data-action]');
      if (!target) {
        // Check if we clicked on a session row (but not on an action button)
        let row = event.target.closest('.session-row');
        if (row && !event.target.closest('[data-action]')) {
          this.navigateToSession(row);
          return;
        }
        return;
      }

      let action = target.getAttribute('data-action');

      switch (action) {
        case 'toggle-hidden':
          this.toggleHidden();
          break;

        case 'navigate':
          this.navigateToSession(target.closest('.session-row'));
          break;

        case 'toggle-archive':
          event.stopPropagation();
          this.toggleArchive(target);
          break;

        case 'show-new-session':
          this.showNewSessionModal();
          break;

        case 'show-new-agent':
          this.showNewAgentModal();
          break;
      }
    });
  }

  /**
   * Set up search input event handler.
   */
  setupSearchInput() {
    let searchInput = this.shadow?.querySelector('.session-search');
    if (!searchInput) return;

    searchInput.addEventListener('input', (event) => {
      this.searchQuery[DynamicProperty.set](event.target.value);
    });
  }

  // ============================================================================
  // State Management
  // ============================================================================

  /**
   * Subscribe to a GlobalState property.
   */
  subscribeToGlobal(key, callback) {
    let GlobalState = getGlobalState();
    if (!GlobalState || !GlobalState[key]) {
      return () => {};
    }

    let handler = () => callback();
    GlobalState[key].addEventListener('update', handler);
    return () => GlobalState[key].removeEventListener('update', handler);
  }

  /**
   * Compute and update the filtered sessions list.
   */
  updateFilteredSessions() {
    let GlobalState = getGlobalState();
    let sessions    = GlobalState?.sessions?.valueOf() || [];
    let showHidden  = this.showHidden.valueOf();
    let query       = this.searchQuery.valueOf().toLowerCase();

    // Filter by visibility
    let filtered = sessions.filter((s) =>
      (showHidden) ? true : (s.status !== 'archived' && s.status !== 'agent')
    );

    // Filter by search query
    if (query) {
      filtered = filtered.filter((s) =>
        s.name.toLowerCase().includes(query) ||
        (s.preview && s.preview.toLowerCase().includes(query))
      );
    }

    this.filteredSessions[DynamicProperty.set](filtered);
  }

  /**
   * Update visibility of sections based on current state.
   */
  updateVisibility() {
    let GlobalState = getGlobalState();
    let sessions    = GlobalState?.sessions?.valueOf() || [];
    let agents      = GlobalState?.agents?.valueOf() || [];
    let filtered    = this.filteredSessions.valueOf();
    let query       = this.searchQuery.valueOf();
    let showHidden  = this.showHidden.valueOf();

    // Calculate hidden sessions count (archived or agent status when not showing hidden)
    let hiddenCount = 0;
    if (!showHidden) {
      hiddenCount = sessions.filter((s) => s.status === 'archived' || s.status === 'agent').length;
    }

    // Determine current state
    let state;
    if (sessions.length === 0 && agents.length === 0) {
      state = 'no-agents';
    } else if (sessions.length === 0) {
      state = 'no-sessions';
    } else if (filtered.length === 0 && query) {
      state = 'no-results';
    } else {
      // We have sessions (even if all are hidden)
      state = 'has-sessions';
    }

    // Update visibility classes
    let container = this.shadow?.querySelector('.sessions-container');
    if (!container) return;

    let elements = container.querySelectorAll('[data-show-when]');
    for (let el of elements) {
      let showWhen = el.getAttribute('data-show-when');
      if (showWhen === state) {
        el.classList.add('visible');
      } else {
        el.classList.remove('visible');
      }
    }

    // Update hidden sessions message
    this.updateHiddenMessage(hiddenCount);
  }

  /**
   * Update the "## sessions are not currently visible" message.
   */
  updateHiddenMessage(hiddenCount) {
    let hiddenMessage = this.shadow?.querySelector('.hidden-sessions-message');
    if (!hiddenMessage) return;

    if (hiddenCount > 0) {
      let text = (hiddenCount === 1)
        ? '1 session is not currently visible'
        : `${hiddenCount} sessions are not currently visible`;
      hiddenMessage.textContent = text;
      hiddenMessage.style.display = '';
    } else {
      hiddenMessage.style.display = 'none';
    }
  }

  /**
   * Update the toggle button appearance.
   */
  updateToggleButton() {
    let button = this.shadow?.querySelector('.toggle-archived');
    if (!button) return;

    let showHidden = this.showHidden.valueOf();
    button.textContent = (showHidden) ? '🐵' : '🙈';
    button.title = (showHidden) ? 'Hide archived sessions' : 'Show archived sessions';
    button.classList.toggle('active', showHidden);
  }

  /**
   * Update the mythix-for-each with current filtered sessions.
   * Pre-computes display values for CSP-safe strict mode rendering.
   */
  updateForEach() {
    let forEach = this.shadow?.querySelector('mythix-for-each');
    if (!forEach) return;

    let sessions = this.filteredSessions.valueOf();

    // Pre-compute display values for each session (CSP-safe, no eval needed)
    let displaySessions = sessions.map((s) => {
      // Build row CSS class
      let rowClasses = [];
      if (s.status === 'archived') rowClasses.push('archived');
      if (s.status === 'agent') rowClasses.push('agent-session');
      if (s.depth > 0) rowClasses.push('child-session');

      return {
        ...s,
        // Pre-computed display properties
        _rowClass:          rowClasses.join(' '),
        _rowStyle:          (s.depth > 0) ? `margin-left: ${s.depth * 24}px` : '',
        _isAgent:           s.status === 'agent',
        _previewText:       s.preview || 'No messages yet',
        _previewClass:      s.preview ? '' : 'no-preview',
        _messageCountText:  (s.messageCount === 1) ? '1 message' : `${s.messageCount || 0} messages`,
        _relativeDate:      this.formatRelativeDate(s.updatedAt),
        _agentName:         s.agent?.name || 'Unknown',
        _archiveTitle:      (s.status === 'archived') ? 'Restore session' : 'Archive session',
        _archiveIcon:       (s.status === 'archived') ? '♻️' : '🗑️',
        _isArchived:        s.status === 'archived',
      };
    });

    // Set items directly - this triggers the render
    forEach.items = displaySessions;

    // Post-process: set attributes that mythix-for-each doesn't interpolate
    // Use requestAnimationFrame to ensure DOM is updated
    requestAnimationFrame(() => {
      let rows = forEach.querySelectorAll('.session-row');
      rows.forEach((row, index) => {
        let session = displaySessions[index];
        if (!session) return;

        // Set data attributes
        row.setAttribute('data-session-id', session.id);
        if (session._rowStyle) {
          row.style.cssText = session._rowStyle;
        }
        if (session._rowClass) {
          row.className = `session-row ${session._rowClass}`;
        }

        // Set archive button attributes
        let archiveBtn = row.querySelector('.session-archive-button');
        if (archiveBtn) {
          archiveBtn.title = session._archiveTitle;
          archiveBtn.setAttribute('data-is-archived', String(session._isArchived));
        }

        // Show/hide agent badge
        let badge = row.querySelector('.session-status-badge');
        if (badge) {
          badge.style.display = session._isAgent ? '' : 'none';
        }

        // Set preview class
        let preview = row.querySelector('.session-preview');
        if (preview && session._previewClass) {
          preview.classList.add(session._previewClass);
        }
      });
    });
  }

  // ============================================================================
  // Template Helper Functions (exposed to @@expressions@@)
  // ============================================================================

  /**
   * Format a date as relative time.
   * This is called from template expressions.
   */
  formatRelativeDate(dateString) {
    if (!dateString) return '';

    let date    = new Date(dateString);
    let now     = new Date();
    let diffMs  = now - date;
    let diffMin = Math.floor(diffMs / 60000);
    let diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 5) return 'just now';

    let timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    if (diffDay < 1 && date.getDate() === now.getDate()) return timeStr;
    if (diffDay < 2 && date.getDate() === now.getDate() - 1) return `yesterday ${timeStr}`;

    if (diffDay < 7) {
      let dayName = date.toLocaleDateString([], { weekday: 'short' });
      return `${dayName} ${timeStr}`;
    }

    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${timeStr}`;
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Toggle show/hide archived sessions.
   */
  toggleHidden() {
    let current = this.showHidden.valueOf();
    this.showHidden[DynamicProperty.set](!current);
  }

  /**
   * Navigate to a session.
   */
  navigateToSession(row) {
    if (!row) return;

    let sessionId = row.getAttribute('data-session-id');
    if (sessionId) {
      this.dispatchEvent(new CustomEvent('hero:navigate', {
        detail: { path: `/sessions/${sessionId}` },
        bubbles: true,
      }));
    }
  }

  /**
   * Archive or restore a session.
   */
  async toggleArchive(button) {
    let row        = button.closest('.session-row');
    let sessionId  = row?.getAttribute('data-session-id');
    let isArchived = button.getAttribute('data-is-archived') === 'true';

    if (!sessionId) return;

    try {
      if (isArchived) {
        await API.sessions.unarchive(sessionId);
      } else {
        await API.sessions.archive(sessionId);
      }

      // Refresh sessions list
      let sessions = await API.sessions.list();
      window.setGlobal('sessions', sessions);
    } catch (error) {
      console.error('Failed to toggle archive:', error);
    }
  }

  /**
   * Show new session modal.
   */
  showNewSessionModal() {
    this.dispatchEvent(new CustomEvent('hero:show-modal', {
      detail: { modal: 'new-session' },
      bubbles: true,
    }));
  }

  /**
   * Show new agent modal.
   */
  showNewAgentModal() {
    this.dispatchEvent(new CustomEvent('hero:show-modal', {
      detail: { modal: 'new-agent' },
      bubbles: true,
    }));
  }
}

// Register the component
HeroSessionsList.register();
