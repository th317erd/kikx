'use strict';

/**
 * Hero WebSocket - Connection Handler Component
 *
 * Manages:
 * - WebSocket connection lifecycle
 * - Authentication via token
 * - Message routing
 * - Automatic reconnection
 * - Session subscription
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from './hero-base.js';

// WebSocket ready states
const WS_CONNECTING = 0;
const WS_OPEN       = 1;
const WS_CLOSING    = 2;
const WS_CLOSED     = 3;

// Reconnect delay in ms
const RECONNECT_DELAY = 5000;

// Message type categories
const GLOBAL_UPDATE_TYPES = [
  'sessions_updated',
  'agents_updated',
  'abilities_updated',
];

const SESSION_MESSAGE_TYPES = [
  'new_message',
  'message_append',
  'assertion_new',
  'assertion_update',
  'element_new',
  'element_update',
  'todo_item_update',
  'new_frame',        // Interaction Frames system
  'frame_update',     // Frame payload updates
];

// ============================================================================
// HeroWebSocket Component
// ============================================================================

export class HeroWebSocket extends HeroComponent {
  static tagName = 'hero-websocket';

  // WebSocket instance
  #ws = null;
  #subscribedSessionId = null;
  #reconnectTimer = null;
  #basePath = '';
  #unsubscribers = [];

  /**
   * Check if connected.
   * @returns {boolean}
   */
  get connected() {
    return !!(this.#ws && this.#ws.readyState === WS_OPEN);
  }

  /**
   * Component mounted.
   */
  mounted() {
    // Get base path
    let baseHref = document.querySelector('base')?.getAttribute('href') || '';
    this.#basePath = baseHref.replace(/\/$/, '');

    // Listen for connect/disconnect events from hero-app (events bubble UP to document)
    this._onWsConnect = () => this.connect();
    this._onWsDisconnect = () => this.disconnect();
    document.addEventListener('ws:connect', this._onWsConnect);
    document.addEventListener('ws:disconnect', this._onWsDisconnect);

    // Subscribe to session changes
    this.#unsubscribers.push(
      this.subscribeGlobal('currentSession', ({ value, oldValue }) => {
        this.#handleSessionChange(value, oldValue);
      })
    );
  }

  /**
   * Component unmounted.
   */
  unmounted() {
    this.disconnect();

    // Remove document-level event listeners
    if (this._onWsConnect) {
      document.removeEventListener('ws:connect', this._onWsConnect);
    }
    if (this._onWsDisconnect) {
      document.removeEventListener('ws:disconnect', this._onWsDisconnect);
    }

    for (let unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers = [];
  }

  /**
   * Connect to WebSocket server.
   */
  connect() {
    // Skip if already connected
    if (this.connected) return;

    // Get auth token from cookie
    let token = this.#getToken();
    if (!token) {
      this.debug('No token found, skipping WebSocket connect');
      return;
    }

    // Build WebSocket URL (nginx proxies /hero/ws to server's /ws)
    let protocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
    let wsUrl    = `${protocol}//${window.location.host}${this.#basePath}/ws?token=${token}`;

    this.debug('Connecting to', wsUrl);

    try {
      this.#ws = new WebSocket(wsUrl);
      this.#setupEventHandlers();
    } catch (error) {
      console.error('WebSocket connection failed:', error);
      this.#scheduleReconnect();
    }
  }

  /**
   * Disconnect from WebSocket server.
   */
  disconnect() {
    this.#clearReconnectTimer();

    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }

    this.#subscribedSessionId = null;
    this.setGlobal('wsConnected', false);
  }

  /**
   * Send a message through WebSocket.
   * @param {object} message
   * @returns {boolean} True if sent
   */
  send(message) {
    if (!this.connected) {
      this.debug('Cannot send, not connected');
      return false;
    }

    try {
      this.#ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error('WebSocket send failed:', error);
      return false;
    }
  }

  /**
   * Subscribe to a session for real-time updates.
   * @param {number} sessionId
   */
  subscribeSession(sessionId) {
    if (this.#subscribedSessionId === sessionId) return;

    // Unsubscribe from previous session
    if (this.#subscribedSessionId) {
      this.send({
        type:      'unsubscribe_session',
        sessionId: this.#subscribedSessionId,
      });
    }

    // Subscribe to new session
    this.#subscribedSessionId = sessionId;
    this.send({
      type:      'subscribe_session',
      sessionId: sessionId,
    });

    this.debug('Subscribed to session', sessionId);
  }

  /**
   * Unsubscribe from current session.
   */
  unsubscribeSession() {
    if (this.#subscribedSessionId) {
      this.send({
        type:      'unsubscribe_session',
        sessionId: this.#subscribedSessionId,
      });
      this.#subscribedSessionId = null;
    }
  }

  /**
   * Get auth token from localStorage or cookie.
   * @returns {string|undefined}
   */
  #getToken() {
    // Try localStorage first (primary storage)
    let token = localStorage.getItem('token');
    if (token) return token;

    // Fallback to cookie
    return document.cookie.split('; ')
      .find((c) => c.startsWith('token='))
      ?.split('=')[1];
  }

  /**
   * Setup WebSocket event handlers.
   */
  #setupEventHandlers() {
    this.#ws.onopen = () => {
      this.debug('Connected');
      this.setGlobal('wsConnected', true);
      this.#clearReconnectTimer();

      // Re-subscribe to session if we were subscribed
      if (this.#subscribedSessionId) {
        this.send({
          type:      'subscribe_session',
          sessionId: this.#subscribedSessionId,
        });
      }

      this.dispatchEvent(new CustomEvent('ws:open', { bubbles: true }));
    };

    this.#ws.onmessage = (event) => {
      try {
        let message = JSON.parse(event.data);
        this.#handleMessage(message);
      } catch (e) {
        console.error('WebSocket message parse error:', e);
      }
    };

    this.#ws.onclose = () => {
      this.debug('Disconnected');
      this.#ws = null;
      this.setGlobal('wsConnected', false);

      this.dispatchEvent(new CustomEvent('ws:close', { bubbles: true }));

      // Attempt reconnect if still authenticated
      if (this.user) {
        this.#scheduleReconnect();
      }
    };

    this.#ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.dispatchEvent(new CustomEvent('ws:error', {
        detail: { error },
        bubbles: true,
      }));
    };
  }

  /**
   * Handle incoming WebSocket message.
   * @param {object} message
   */
  #handleMessage(message) {
    this.debug('Received:', message.type);

    // Dispatch general message event
    this.dispatchEvent(new CustomEvent('ws:message', {
      detail: { message },
      bubbles: true,
    }));

    // Dispatch type-specific event (composed: true allows crossing shadow DOM)
    this.dispatchEvent(new CustomEvent(`ws:${message.type}`, {
      detail: message,
      bubbles: true,
      composed: true,
    }));

    // Handle global updates
    if (GLOBAL_UPDATE_TYPES.includes(message.type)) {
      this.#handleGlobalUpdate(message);
    }
  }

  /**
   * Handle global update messages.
   * @param {object} message
   */
  async #handleGlobalUpdate(message) {
    try {
      let { fetchSessions, fetchAgents, fetchAbilities } = window;

      switch (message.type) {
        case 'sessions_updated':
          let sessions = await fetchSessions();
          this.setGlobal('sessions', sessions);
          break;

        case 'agents_updated':
          let agents = await fetchAgents();
          this.setGlobal('agents', agents);
          break;

        case 'abilities_updated':
          let abilities = await fetchAbilities();
          this.setGlobal('abilities', abilities);
          break;
      }
    } catch (error) {
      console.error('Failed to handle global update:', error);
    }
  }

  /**
   * Handle session change.
   * @param {object|null} newSession
   * @param {object|null} oldSession
   */
  #handleSessionChange(newSession, oldSession) {
    if (newSession?.id !== oldSession?.id) {
      if (newSession) {
        this.subscribeSession(newSession.id);
      } else {
        this.unsubscribeSession();
      }
    }
  }

  /**
   * Schedule reconnection attempt.
   */
  #scheduleReconnect() {
    this.#clearReconnectTimer();
    this.debug('Scheduling reconnect in', RECONNECT_DELAY, 'ms');
    this.#reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY);
  }

  /**
   * Clear reconnection timer.
   */
  #clearReconnectTimer() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  /**
   * No DOM rendering needed.
   */
  render() {
    // This component has no visual output
  }
}

// Register the component
if (typeof customElements !== 'undefined') {
  customElements.define(HeroWebSocket.tagName, HeroWebSocket);
}
