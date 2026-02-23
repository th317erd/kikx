'use strict';

/**
 * Hero Step Component
 *
 * Container for step content in multi-step modals.
 * Visibility is controlled by parent HeroStepModal via CSS.
 *
 * @example
 * <hero-step label="Basic Info">
 *   <div class="form-group">
 *     <label>Name</label>
 *     <input type="text" name="name" required>
 *   </div>
 * </hero-step>
 */

export class HeroStep extends HTMLElement {
  static tagName = 'hero-step';

  /**
   * Get the step label.
   * @returns {string}
   */
  get label() {
    return this.getAttribute('label') || '';
  }

  /**
   * Set the step label.
   * @param {string} value
   */
  set label(value) {
    this.setAttribute('label', value);
  }

  connectedCallback() {
    // Steps start hidden, parent modal controls visibility
    this.style.visibility = 'hidden';
  }
}

// Register component
// Note: HeroStep extends HTMLElement directly (not MythixUIComponent)
// so we use customElements.define instead of .register()
if (typeof customElements !== 'undefined' && !customElements.get('hero-step')) {
  customElements.define('hero-step', HeroStep);
}
