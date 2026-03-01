'use strict';

/**
 * Kikx Login - Login Page Component
 *
 * Self-contained login form. Calls API.auth.login() on submit,
 * dispatches kikx:authenticated on success, shows errors inline.
 */

import {
  KikxComponent,
  GlobalState,
  DynamicProperty,
} from '../kikx-base.js';

// ============================================================================
// KikxLogin Component
// ============================================================================

export class KikxLogin extends KikxComponent {
  static tagName = 'kikx-login';

  #submitting = false;

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
    let form = this.shadowRoot.querySelector('#login-form');
    if (form) {
      form.addEventListener('submit', (event) => this._handleSubmit(event));
    }
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Reset the form (clear inputs and error).
   */
  reset() {
    let form = this.shadowRoot.querySelector('#login-form');
    if (form)
      form.reset();

    this._setError('');
  }

  /**
   * Focus the username input.
   */
  focusInput() {
    let input = this.shadowRoot.querySelector('#username');
    if (input)
      input.focus();
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Handle form submission.
   * @param {Event} event
   */
  async _handleSubmit(event) {
    event.preventDefault();

    if (this.#submitting)
      return;

    let username = this.shadowRoot.querySelector('#username')?.value?.trim();
    let password = this.shadowRoot.querySelector('#password')?.value;

    if (!username || !password) {
      this._setError('Username and password are required.');
      return;
    }

    this.#submitting = true;
    this._setError('');
    this._setLoading(true);

    try {
      // Use global login function (sets JWT token in cookie + localStorage)
      let login = window.login || window.API?.auth?.login;
      if (!login)
        throw new Error('Login API not available');

      await login(username, password);

      // Notify the app shell
      this.dispatchEvent(new CustomEvent('kikx:authenticated', {
        bubbles:  true,
        composed: true,
      }));
    } catch (error) {
      this._setError(error.message || 'Login failed');
    } finally {
      this.#submitting = false;
      this._setLoading(false);
    }
  }

  /**
   * Set error message.
   * @param {string} message
   */
  _setError(message) {
    let errorElement = this.shadowRoot.querySelector('#login-error');
    if (errorElement)
      errorElement.textContent = message;
  }

  /**
   * Set loading state on submit button.
   * @param {boolean} loading
   */
  _setLoading(loading) {
    let button = this.shadowRoot.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = loading;
      button.textContent = (loading) ? 'Logging in...' : 'Log In';
    }
  }
}

// Register the component
KikxLogin.register();
