'use strict';

/**
 * Hero Base Component Infrastructure
 *
 * Provides:
 * - GlobalState: App-wide reactive state via DynamicProperty
 * - HeroComponent: Base class for all Hero UI components
 */

import {
  MythixUIComponent,
  DynamicProperty,
  Utils,
} from '@cdn/mythix-ui-core@1';

// ============================================================================
// Global State (Tier 1)
// ============================================================================

/**
 * App-wide reactive state.
 * Access via GlobalState.user, GlobalState.sessions, etc.
 * Update via GlobalState.sessions[DynamicProperty.set](newValue)
 */
export const GlobalState = {
  // Current authenticated user
  user: Utils.dynamicPropID('heroUser', null),

  // All sessions list
  sessions: Utils.dynamicPropID('heroSessions', []),

  // All agents list
  agents: Utils.dynamicPropID('heroAgents', []),

  // Abilities { system: [], user: [] }
  abilities: Utils.dynamicPropID('heroAbilities', { system: [], user: [] }),

  // Currently selected session (full object)
  currentSession: Utils.dynamicPropID('heroCurrentSession', null),

  // WebSocket connection status
  wsConnected: Utils.dynamicPropID('heroWsConnected', false),

  // Spend tracking
  globalSpend: Utils.dynamicPropID('heroGlobalSpend', { cost: 0, inputTokens: 0, outputTokens: 0 }),
  serviceSpend: Utils.dynamicPropID('heroServiceSpend', { cost: 0 }),
  sessionSpend: Utils.dynamicPropID('heroSessionSpend', { cost: 0 }),

  // UI state
  showHiddenSessions: Utils.dynamicPropID('heroShowHiddenSessions', false),
};

// ============================================================================
// HeroComponent Base Class
// ============================================================================

/**
 * Base class for all Hero UI components.
 * Extends MythixUIComponent with Hero-specific conveniences.
 */
export class HeroComponent extends MythixUIComponent {
  /**
   * Access GlobalState directly on the component.
   * @returns {typeof GlobalState}
   */
  get global() {
    return GlobalState;
  }

  /**
   * Get the current user.
   * @returns {object|null}
   */
  get user() {
    return GlobalState.user.valueOf();
  }

  /**
   * Check if user is authenticated.
   * @returns {boolean}
   */
  get isAuthenticated() {
    return GlobalState.user.valueOf() !== null;
  }

  /**
   * Get current session.
   * @returns {object|null}
   */
  get currentSession() {
    return GlobalState.currentSession.valueOf();
  }

  /**
   * Override createShadowDOM to use Light DOM by default.
   * Components can override this to use Shadow DOM if needed.
   */
  createShadowDOM() {
    // Light DOM by default - no shadow root
    // Override in subclass with super.createShadowDOM() to use Shadow DOM
  }

  /**
   * Render HTML content to the component.
   * Uses mythixUI.setHTML() to set innerHTML and process data-event-* attributes.
   * @param {string} html - HTML string to render
   */
  render(html) {
    if (typeof html === 'string') {
      // Use Mythix UI's setHTML to set innerHTML AND process event bindings
      globalThis.mythixUI.setHTML(this, html);
    }
  }

  /**
   * Convenience method to update a global state property.
   * @param {string} key - GlobalState key (e.g., 'sessions')
   * @param {*} value - New value
   */
  setGlobal(key, value) {
    if (GlobalState[key]) {
      GlobalState[key][DynamicProperty.set](value);
    } else {
      console.warn(`GlobalState.${key} does not exist`);
    }
  }

  /**
   * Subscribe to a GlobalState property change.
   * Returns unsubscribe function.
   * @param {string} key - GlobalState key
   * @param {Function} callback - Called with { value, oldValue }
   * @returns {Function} Unsubscribe function
   */
  subscribeGlobal(key, callback) {
    if (!GlobalState[key]) {
      console.warn(`GlobalState.${key} does not exist`);
      return () => {};
    }

    let handler = (event) => callback({ value: event.value, oldValue: event.oldValue });
    GlobalState[key].addEventListener('update', handler);
    return () => GlobalState[key].removeEventListener('update', handler);
  }

  /**
   * Debug log (only if debug mode enabled).
   * @param  {...any} args
   */
  debug(...args) {
    if (sessionStorage.getItem('debug') === 'true') {
      console.log(`[${this.constructor.tagName}]`, ...args);
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

// Re-export core mythix-ui classes for convenience
export { MythixUIComponent, DynamicProperty, Utils };
