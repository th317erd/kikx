'use strict';

/**
 * Hero Header - Top Bar Component
 *
 * Displays:
 * - Session title (in chat view)
 * - Logo and title (in sessions view)
 * - Navigation controls via hero-main-controls
 * - Mobile hamburger menu
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// ============================================================================
// HeroHeader Component
// ============================================================================

export class HeroHeader extends HeroComponent {
  static tagName = 'hero-header';

  // Component state
  #mobileMenuOpen = false;
  #unsubscribers = [];

  // ---------------------------------------------------------------------------
  // Shadow DOM
  // ---------------------------------------------------------------------------

  createShadowDOM() {
    return this.attachShadow({ mode: 'open' });
  }

  // ---------------------------------------------------------------------------
  // Template Expression Getters
  // ---------------------------------------------------------------------------

  /**
   * Get session title for chat view.
   * @returns {string}
   */
  get title() {
    return this.currentSession?.name || 'Chat';
  }

  /**
   * Get context for hero-main-controls.
   * @returns {string}
   */
  get context() {
    let view = this.getAttribute('view') || 'sessions';
    return (view === 'chat') ? 'chat' : 'sessions';
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Component mounted.
   */
  mounted() {
    // Set initial view attribute
    this.setAttribute('view', 'sessions');

    // Subscribe to state changes
    this.#unsubscribers.push(
      this.subscribeGlobal('currentSession', () => this._updateTitle())
    );

    // Listen for view changes from hero-app
    document.addEventListener('viewchange', (event) => {
      this.setAttribute('view', event.detail.view);
      this._updateTitle();
    });

    // Listen for menu actions from hero-main-controls to close mobile menu
    this.shadowRoot.addEventListener('hero:menu-action', () => {
      this.closeMobileMenu();
    });

    // Close mobile menu when clicking outside
    document.addEventListener('click', (event) => {
      if (this.#mobileMenuOpen && !this.contains(event.target)) {
        this.closeMobileMenu();
      }
    });
  }

  /**
   * Component unmounted.
   */
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
   * Update title element when session changes.
   */
  _updateTitle() {
    let titleEl = this.shadowRoot.querySelector('.header-title.chat-only');
    if (titleEl) {
      titleEl.textContent = this.title;
    }
  }

  // ---------------------------------------------------------------------------
  // Public Methods (called from template events)
  // ---------------------------------------------------------------------------

  /**
   * Navigate back to sessions.
   */
  goBack() {
    this.dispatchEvent(new CustomEvent('hero:navigate', {
      detail: { path: '/' },
      bubbles: true,
    }));
  }

  /**
   * Toggle mobile menu.
   */
  toggleMobileMenu() {
    this.#mobileMenuOpen = !this.#mobileMenuOpen;

    let menu = this.shadowRoot.querySelector('.mobile-menu');
    if (menu) {
      menu.classList.toggle('open', this.#mobileMenuOpen);
    }

    let hamburger = this.shadowRoot.querySelector('.hamburger-button');
    if (hamburger) {
      hamburger.classList.toggle('active', this.#mobileMenuOpen);
    }
  }

  /**
   * Close mobile menu.
   */
  closeMobileMenu() {
    this.#mobileMenuOpen = false;

    let menu = this.shadowRoot.querySelector('.mobile-menu');
    if (menu) {
      menu.classList.remove('open');
    }

    let hamburger = this.shadowRoot.querySelector('.hamburger-button');
    if (hamburger) {
      hamburger.classList.remove('active');
    }
  }
}

// Register the component
HeroHeader.register();
