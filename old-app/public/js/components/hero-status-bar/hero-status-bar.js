'use strict';

/**
 * Hero Status Bar - Bottom Status Bar Component
 *
 * Displays:
 * - Connection status (Connected/Disconnected)
 * - Global Spend
 * - Service Spend (N/A when not in session)
 * - Session Spend (N/A when not in session)
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format cost with 3-digit padding.
 * @param {number} cost
 * @returns {string}
 */
function formatCost(cost) {
  let value = cost || 0;
  let dollars = Math.floor(value);
  let cents = Math.round((value - dollars) * 100);
  return '$' + String(dollars).padStart(3, '0') + '.' + String(cents).padStart(2, '0');
}

// ============================================================================
// HeroStatusBar Component
// ============================================================================

export class HeroStatusBar extends HeroComponent {
  static tagName = 'hero-status-bar';

  // Component state
  #view = 'sessions';
  #serviceSpend = { cost: 0 };
  #sessionSpend = { cost: 0 };
  #unsubscribers = [];

  // ---------------------------------------------------------------------------
  // Shadow DOM (override HeroComponent default of Light DOM)
  // ---------------------------------------------------------------------------

  createShadowDOM() {
    return this.attachShadow({ mode: 'open' });
  }

  // ---------------------------------------------------------------------------
  // Template Expression Getters
  // ---------------------------------------------------------------------------

  get connectionClass() {
    let wsConnected = GlobalState.wsConnected.valueOf();
    return (wsConnected) ? 'connected' : 'disconnected';
  }

  get connectionIcon() {
    let wsConnected = GlobalState.wsConnected.valueOf();
    return (wsConnected) ? '\u25CF' : '\u26A0';
  }

  get connectionText() {
    let wsConnected = GlobalState.wsConnected.valueOf();
    return (wsConnected) ? 'Connected' : 'Disconnected';
  }

  get globalSpendFormatted() {
    let globalSpend = GlobalState.globalSpend.valueOf();
    return formatCost(globalSpend.cost);
  }

  get serviceSpendFormatted() {
    if (!this.inSession)
      return 'N/A';

    // Use GlobalState if available, fall back to private field
    let serviceSpend = GlobalState.serviceSpend?.valueOf() || this.#serviceSpend;
    return formatCost(serviceSpend.cost);
  }

  get sessionSpendFormatted() {
    if (!this.inSession)
      return 'N/A';

    // Use GlobalState if available, fall back to private field
    let sessionSpend = GlobalState.sessionSpend?.valueOf() || this.#sessionSpend;
    return formatCost(sessionSpend.cost);
  }

  get spendDisabledClass() {
    return (this.inSession) ? '' : 'spend-disabled';
  }

  // ---------------------------------------------------------------------------
  // Public Getters
  // ---------------------------------------------------------------------------

  /**
   * Get current view.
   * @returns {string}
   */
  get view() {
    return this.#view;
  }

  /**
   * Set current view.
   * @param {string} value
   */
  set view(value) {
    this.#view = value;
  }

  /**
   * Check if currently in a session.
   * @returns {boolean}
   */
  get inSession() {
    // Simply check if there's a current session selected
    // (no need to track view separately - currentSession being set implies chat view)
    return this.currentSession !== null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Component connected to DOM.
   */
  connectedCallback() {
    super.connectedCallback?.();

    // Create shadow root if needed
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }

    // Render content immediately
    this._renderShadowDOM();

    // Set initial visibility based on auth state
    // (mounted() may not be called by MythixUI in all cases)
    this.scheduleRender();
  }

  /**
   * Component mounted (called by MythixUI after connectedCallback).
   */
  mounted() {
    // Subscribe to state changes
    this.#unsubscribers.push(
      this.subscribeGlobal('currentSession', () => this.scheduleRender()),
      this.subscribeGlobal('globalSpend', () => this.scheduleRender()),
      this.subscribeGlobal('serviceSpend', () => this.scheduleRender()),
      this.subscribeGlobal('sessionSpend', () => this.scheduleRender()),
      this.subscribeGlobal('wsConnected', () => this.scheduleRender())
    );

    // Listen for auth changes via custom events
    this._onAuthenticated = () => this.scheduleRender();
    this._onLogout = () => this.scheduleRender();
    document.addEventListener('hero:authenticated', this._onAuthenticated);
    document.addEventListener('hero:logout', this._onLogout);

    // Also listen for storage changes (catches token changes from other tabs or direct manipulation)
    this._onStorage = (e) => {
      if (e.key === 'token') {
        this.scheduleRender();
      }
    };
    window.addEventListener('storage', this._onStorage);

    // Initial render
    this.scheduleRender();
  }

  /**
   * Render the shadow DOM content.
   */
  _renderShadowDOM() {
    if (!this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }

        .status-bar {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 6px 16px;
          background: var(--bg-secondary, #1a1a2e);
          border-top: 1px solid var(--border-color, #2d2d2d);
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          height: 32px;
          box-sizing: border-box;
        }

        .connection-status {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .connection-status.connected {
          color: var(--success, #4ade80);
        }

        .connection-status.disconnected {
          color: var(--error, #f87171);
        }

        .connection-icon {
          font-size: 10px;
        }

        .connection-text {
          font-weight: 500;
        }

        .status-separator {
          color: var(--text-muted, #6b7280);
          opacity: 0.5;
        }

        .spend-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .spend-label {
          color: var(--text-secondary, #9ca3af);
        }

        .spend-value {
          font-weight: 600;
          min-width: 60px;
        }

        .spend-global .spend-value,
        .spend-service .spend-value,
        .spend-session .spend-value {
          color: var(--info, #60a5fa);
        }

        .spend-disabled {
          opacity: 0.5;
        }

        .spend-disabled .spend-value {
          color: var(--text-muted, #6b7280) !important;
        }

        @media (max-width: 640px) {
          .status-bar {
            flex-wrap: wrap;
            gap: 4px 12px;
            padding: 4px 12px;
            height: auto;
            min-height: 32px;
          }

          .status-separator {
            display: none;
          }

          .connection-status {
            width: 100%;
            justify-content: center;
          }

          .spend-item {
            font-size: 11px;
          }

          .spend-value {
            min-width: 50px;
          }
        }
      </style>

      <div class="status-bar">
        <span class="connection-status ${this.connectionClass}" title="WebSocket connection status">
          <span class="connection-icon">${this.connectionIcon}</span>
          <span class="connection-text">${this.connectionText}</span>
        </span>
        <span class="status-separator">|</span>
        <span class="spend-item spend-global" title="Total usage across all agents">
          <span class="spend-label">Global:</span>
          <span class="spend-value">${this.globalSpendFormatted}</span>
        </span>
        <span class="status-separator">|</span>
        <span class="spend-item spend-service ${this.spendDisabledClass}" title="Usage for this API key/service">
          <span class="spend-label">Service:</span>
          <span class="spend-value">${this.serviceSpendFormatted}</span>
        </span>
        <span class="status-separator">|</span>
        <span class="spend-item spend-session ${this.spendDisabledClass}" title="Usage in this session">
          <span class="spend-label">Session:</span>
          <span class="spend-value">${this.sessionSpendFormatted}</span>
        </span>
      </div>
    `;
  }

  /**
   * Component unmounted.
   */
  unmounted() {
    for (let unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers = [];

    // Clean up event listeners
    if (this._onAuthenticated) {
      document.removeEventListener('hero:authenticated', this._onAuthenticated);
    }
    if (this._onLogout) {
      document.removeEventListener('hero:logout', this._onLogout);
    }
    if (this._onStorage) {
      window.removeEventListener('storage', this._onStorage);
    }
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Set service and session spend.
   * @param {object} service
   * @param {object} session
   */
  setSpend(service, session) {
    this.#serviceSpend = service || { cost: 0 };
    this.#sessionSpend = session || { cost: 0 };
    this.scheduleRender();
  }

  /**
   * Schedule a render on next animation frame.
   * Prevents multiple renders in the same frame.
   */
  scheduleRender() {
    if (this._renderScheduled)
      return;

    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      // Hide when not authenticated using CSS class
      let hasToken = !!localStorage.getItem('token');

      if (hasToken) {
        this.classList.remove('hidden');
        this._updateDOM();
      } else {
        this.classList.add('hidden');
      }
    });
  }

  /**
   * Update Shadow DOM elements with current values.
   * Template expressions are only evaluated on mount, so we update manually.
   */
  _updateDOM() {
    if (!this.shadowRoot) return;

    // Connection status
    let connectionEl = this.shadowRoot.querySelector('.connection-status');
    if (connectionEl) {
      connectionEl.className = 'connection-status ' + this.connectionClass;
    }

    let iconEl = this.shadowRoot.querySelector('.connection-icon');
    if (iconEl) {
      iconEl.textContent = this.connectionIcon;
    }

    let textEl = this.shadowRoot.querySelector('.connection-text');
    if (textEl) {
      textEl.textContent = this.connectionText;
    }

    // Global spend
    let globalValueEl = this.shadowRoot.querySelector('.spend-global .spend-value');
    if (globalValueEl) {
      globalValueEl.textContent = this.globalSpendFormatted;
    }

    // Service spend
    let serviceEl = this.shadowRoot.querySelector('.spend-service');
    if (serviceEl) {
      serviceEl.className = 'spend-item spend-service ' + this.spendDisabledClass;
    }
    let serviceValueEl = this.shadowRoot.querySelector('.spend-service .spend-value');
    if (serviceValueEl) {
      serviceValueEl.textContent = this.serviceSpendFormatted;
    }

    // Session spend
    let sessionEl = this.shadowRoot.querySelector('.spend-session');
    if (sessionEl) {
      sessionEl.className = 'spend-item spend-session ' + this.spendDisabledClass;
    }
    let sessionValueEl = this.shadowRoot.querySelector('.spend-session .spend-value');
    if (sessionValueEl) {
      sessionValueEl.textContent = this.sessionSpendFormatted;
    }
  }
}

// Register the component
HeroStatusBar.register();
