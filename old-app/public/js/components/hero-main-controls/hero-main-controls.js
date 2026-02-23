'use strict';

/**
 * Hero Main Controls - Header Action Buttons Component
 *
 * Displays action buttons for header navigation.
 * Supports two layouts via attribute:
 * - layout="horizontal" (default, desktop)
 * - layout="vertical" (mobile menu)
 *
 * Context attribute controls which controls are shown:
 * - context="sessions" (default) - nav buttons only
 * - context="chat" - nav buttons + session controls
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// ============================================================================
// HeroMainControls Component
// ============================================================================

export class HeroMainControls extends HeroComponent {
  static tagName = 'hero-main-controls';

  // Observed attributes (array form for Mythix UI compatibility)
  static observedAttributes = ['layout', 'context'];

  #unsubscribers = [];

  // ---------------------------------------------------------------------------
  // Shadow DOM
  // ---------------------------------------------------------------------------

  createShadowDOM() {
    return this.attachShadow({ mode: 'open' });
  }

  // ---------------------------------------------------------------------------
  // Attribute Getters
  // ---------------------------------------------------------------------------

  get layout() {
    return this.getAttribute('layout') || 'horizontal';
  }

  get context() {
    return this.getAttribute('context') || 'sessions';
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this._updateLayout();
    }
  }

  mounted() {
    this._updateLayout();
  }

  unmounted() {
    for (let unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers = [];
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Update layout visibility based on layout attribute.
   */
  _updateLayout() {
    let horizontal = this.shadowRoot.querySelector('[data-layout="horizontal"]');
    let vertical = this.shadowRoot.querySelector('[data-layout="vertical"]');

    if (this.layout === 'vertical') {
      if (horizontal)
        horizontal.style.display = 'none';
      if (vertical)
        vertical.style.display = 'flex';
    } else {
      if (horizontal)
        horizontal.style.display = 'flex';
      if (vertical)
        vertical.style.display = 'none';
    }
  }

  // ---------------------------------------------------------------------------
  // Action Methods (called from template events)
  // ---------------------------------------------------------------------------

  showAgents() {
    this._dispatchMenuAction();
    this.dispatchEvent(new CustomEvent('show-modal', {
      detail: { modal: 'agents' },
      bubbles: true,
      composed: true,
    }));
  }

  showAbilities() {
    this._dispatchMenuAction();
    this.dispatchEvent(new CustomEvent('show-modal', {
      detail: { modal: 'abilities' },
      bubbles: true,
      composed: true,
    }));
  }

  newSession() {
    this._dispatchMenuAction();
    this.dispatchEvent(new CustomEvent('show-modal', {
      detail: { modal: 'new-session' },
      bubbles: true,
      composed: true,
    }));
  }

  goToSettings() {
    this._dispatchMenuAction();
    this.dispatchEvent(new CustomEvent('hero:navigate', {
      detail: { path: '/settings' },
      bubbles: true,
      composed: true,
    }));
  }

  logout() {
    this._dispatchMenuAction();
    this.dispatchEvent(new CustomEvent('hero:logout', {
      bubbles: true,
      composed: true,
    }));
  }

  clearMessages() {
    this._dispatchMenuAction();
    this.dispatchEvent(new CustomEvent('hero:clear-messages', {
      bubbles: true,
      composed: true,
    }));
  }

  /**
   * Dispatch event to notify parent that a menu action was taken.
   * This allows the mobile menu to close after an action.
   */
  _dispatchMenuAction() {
    this.dispatchEvent(new CustomEvent('hero:menu-action', {
      bubbles: true,
      composed: true,
    }));
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  handleShowHiddenToggle(event) {
    this.dispatchEvent(new CustomEvent('hero:toggle-hidden', {
      detail: { show: event.target.checked },
      bubbles: true,
      composed: true,
    }));
  }
}

// Register the component
HeroMainControls.register();
