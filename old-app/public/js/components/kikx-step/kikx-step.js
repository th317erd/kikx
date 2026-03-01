'use strict';

/**
 * Kikx Step Component
 *
 * Container for step content in multi-step modals.
 * Visibility is controlled by parent KikxStepModal via CSS.
 *
 * @example
 * <kikx-step label="Basic Info">
 *   <div class="form-group">
 *     <label>Name</label>
 *     <input type="text" name="name" required>
 *   </div>
 * </kikx-step>
 */

export class KikxStep extends HTMLElement {
  static tagName = 'kikx-step';

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
// Note: KikxStep extends HTMLElement directly (not MythixUIComponent)
// so we use customElements.define instead of .register()
if (typeof customElements !== 'undefined' && !customElements.get('kikx-step')) {
  customElements.define('kikx-step', KikxStep);
}
