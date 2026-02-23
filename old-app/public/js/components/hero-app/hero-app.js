'use strict';

/**
 * Hero App - Root Component
 *
 * Handles:
 * - Routing between views (login, sessions, chat)
 * - Authentication state
 * - WebSocket connection lifecycle
 * - Initial data loading
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// ============================================================================
// Route Parsing
// ============================================================================

/**
 * Parse a pathname into a route object.
 * @param {string} pathname - The URL pathname
 * @param {string} basePath - Optional base path to strip
 * @returns {{ view: string, sessionId?: number }}
 */
export function parseRoute(pathname, basePath = '') {
  let path = pathname;

  // Strip base path
  if (basePath && path.startsWith(basePath)) {
    path = path.slice(basePath.length) || '/';
  }

  if (path === '/login') {
    return { view: 'login' };
  }

  if (path === '/' || path === '') {
    return { view: 'sessions' };
  }

  if (path === '/settings') {
    return { view: 'settings' };
  }

  let settingsTabMatch = path.match(/^\/settings\/([\w-]+)$/);

  if (settingsTabMatch) {
    return { view: 'settings', tab: settingsTabMatch[1] };
  }

  let sessionMatch = path.match(/^\/sessions\/(\d+)$/);

  if (sessionMatch) {
    return { view: 'chat', sessionId: parseInt(sessionMatch[1], 10) };
  }

  // Unknown route defaults to sessions
  return { view: 'sessions' };
}

// ============================================================================
// HeroApp Component
// ============================================================================

export class HeroApp extends HeroComponent {
  static tagName = 'hero-app';

  // Current view state
  #currentView = 'login';
  #basePath = '';
  #unsubscribers = [];

  // Note: hero-app uses Light DOM - children are directly in the element, not slotted.
  // The template in hero-app.html is for reference/documentation only.

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Get the base path from <base> tag.
   * @returns {string}
   */
  get basePath() {
    return this.#basePath;
  }

  /**
   * Get the current view name.
   * @returns {string}
   */
  get currentView() {
    return this.#currentView;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Component mounted - initialize routing and auth.
   */
  mounted() {
    // Read base path from <base> tag
    let baseHref = document.querySelector('base')?.getAttribute('href') || '';
    this.#basePath = baseHref.replace(/\/$/, '');

    // Listen for popstate (back/forward navigation)
    window.addEventListener('popstate', this._handlePopState);

    // Subscribe to user changes for auth state
    let unsubUser = this.subscribeGlobal('user', ({ value }) => {
      this._onUserChange(value);
    });
    this.#unsubscribers.push(unsubUser);

    // Listen for custom events from child components (event hub pattern)
    this.addEventListener('hero:logout', () => this.logout());
    this.addEventListener('hero:navigate', (event) => this.navigate(event.detail.path));
    this.addEventListener('hero:authenticated', () => this.navigate('/'));
    this.addEventListener('hero:show-modal', (event) => this._handleShowModal(event.detail));
    this.addEventListener('show-modal', (event) => this._handleShowModal(event.detail));
    this.addEventListener('hero:clear-messages', () => this._handleClearMessages());
    this.addEventListener('hero:toggle-hidden', (event) => this._handleToggleHidden(event.detail));

    // Initial route
    this.handleRoute();
  }

  /**
   * Component unmounted - cleanup.
   */
  unmounted() {
    window.removeEventListener('popstate', this._handlePopState);

    // Cleanup subscriptions
    for (let unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers = [];
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle popstate events.
   */
  _handlePopState = () => {
    this.handleRoute();
  };

  /**
   * Handle user state changes.
   * @param {object|null} user
   */
  _onUserChange(user) {
    if (!user && this.#currentView !== 'login') {
      // User logged out, redirect to login
      this.navigate('/login');
    }
  }

  /**
   * Handle show-modal event.
   * @param {object} detail - { modal: 'new-session' | 'new-agent' | 'abilities' | 'agents' }
   */
  _handleShowModal(detail) {
    // Dispatch to legacy app.js modal handlers
    document.dispatchEvent(new CustomEvent('show-modal', { detail }));
  }

  /**
   * Handle clear-messages event.
   */
  _handleClearMessages() {
    // Dispatch to legacy app.js
    document.dispatchEvent(new CustomEvent('clear-messages'));
  }

  /**
   * Handle toggle-hidden event.
   * @param {object} detail - { show: boolean }
   */
  _handleToggleHidden(detail) {
    // Dispatch to legacy app.js
    document.dispatchEvent(new CustomEvent('toggle-hidden', { detail }));
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Navigate to a path.
   * @param {string} path - Path to navigate to
   */
  navigate(path) {
    window.history.pushState({}, '', this.#basePath + path);
    this.handleRoute();
  }

  /**
   * Handle the current route.
   */
  async handleRoute() {
    let route = parseRoute(window.location.pathname, this.#basePath);

    // Check auth for protected routes
    if (route.view !== 'login') {
      let isAuthenticated = await this._checkAuth();

      if (!isAuthenticated) {
        this._showView('login');
        return;
      }
    }

    switch (route.view) {
      case 'login':
        this._disconnectWebSocket();
        this._showView('login');
        break;

      case 'sessions':
        await this._loadInitialData();
        this._showView('sessions');
        break;

      case 'chat':
        await this._loadSession(route.sessionId);
        this._showView('chat');
        break;

      case 'settings':
        this._showView('settings', { tab: route.tab });
        break;

      default:
        this._showView('sessions');
    }
  }

  /**
   * Logout the user.
   */
  async logout() {
    try {
      let { logout: apiLogout } = window;
      await apiLogout();
    } catch (e) {
      // Logout API failure is non-fatal
    }

    // Clear state
    this.setGlobal('user', null);
    this.setGlobal('sessions', []);
    this.setGlobal('agents', []);
    this.setGlobal('abilities', { system: [], user: [] });
    this.setGlobal('currentSession', null);

    this._disconnectWebSocket();
    this.navigate('/login');
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Check if user is authenticated.
   * @returns {Promise<boolean>}
   */
  async _checkAuth() {
    try {
      // Import fetchMe from api.js
      let { fetchMe } = window;
      let user = await fetchMe();
      this.setGlobal('user', user);
      this._connectWebSocket();
      return true;
    } catch (error) {
      this.setGlobal('user', null);
      return false;
    }
  }

  /**
   * Load initial data (sessions, agents, abilities).
   */
  async _loadInitialData() {
    try {
      let { fetchSessions, fetchAgents, fetchAbilities, fetchUsage } = window;

      // Load in parallel
      let [sessions, agents, abilities, usage] = await Promise.all([
        fetchSessions(),
        fetchAgents(),
        fetchAbilities(),
        fetchUsage().catch(() => ({ global: { cost: 0 } })),
      ]);

      this.setGlobal('sessions', sessions);
      this.setGlobal('agents', agents);
      this.setGlobal('abilities', abilities);
      this.setGlobal('globalSpend', { cost: usage.global?.cost || 0, inputTokens: 0, outputTokens: 0 });
    } catch (error) {
      console.error('Failed to load initial data:', error);
    }
  }

  /**
   * Load a specific session.
   * @param {number} sessionId
   */
  async _loadSession(sessionId) {
    try {
      let { fetchSession, fetchSessionUsage } = window;

      let session = await fetchSession(sessionId);
      this.setGlobal('currentSession', session);

      // Initialize SessionStore with session messages
      if (window.sessionStore) {
        let sessionMessages = window.sessionStore.getSession(session.id);
        sessionMessages.init(session.messages || []);
      }

      // Also load session usage
      try {
        let usage = await fetchSessionUsage(sessionId);
        this.setGlobal('globalSpend', { cost: usage.global?.cost || 0, inputTokens: 0, outputTokens: 0 });
        this.setGlobal('serviceSpend', { cost: usage.service?.cost || 0 });
        this.setGlobal('sessionSpend', { cost: usage.session?.cost || 0 });
      } catch (e) {
        // Usage load failure is non-fatal
      }
    } catch (error) {
      console.error('Failed to load session:', error);
      this.navigate('/');
    }
  }

  /**
   * Show a view and hide others.
   * @param {string} viewName
   * @param {object} [options] - Additional route data (e.g., { tab })
   */
  _showView(viewName, options) {
    this.#currentView = viewName;

    // Dispatch event for view changes
    this.dispatchEvent(new CustomEvent('viewchange', {
      detail: { view: viewName, ...options },
      bubbles: true,
    }));

    // Update view visibility via slotted children (light DOM)
    let views = this.querySelectorAll('[data-view]');
    for (let view of views) {
      let isActive = view.dataset.view === viewName;
      view.classList.toggle('active', isActive);
      view.style.display = isActive ? '' : 'none';
    }

    // Pass tab to hero-settings when settings view is active
    if (viewName === 'settings') {
      let settingsComponent = this.querySelector('hero-settings');
      if (settingsComponent) {
        settingsComponent.tab = options?.tab || 'profile';
      }
    }
  }

  /**
   * Connect WebSocket.
   */
  _connectWebSocket() {
    // WebSocket connection will be handled by hero-websocket component
    this.setGlobal('wsConnected', true);
    this.dispatchEvent(new CustomEvent('ws:connect', { bubbles: true }));
  }

  /**
   * Disconnect WebSocket.
   */
  _disconnectWebSocket() {
    this.setGlobal('wsConnected', false);
    this.dispatchEvent(new CustomEvent('ws:disconnect', { bubbles: true }));
  }
}

// Register the component
HeroApp.register();
