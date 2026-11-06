'use strict';

// =============================================================================
// KikxSettingsPage — the base class plugin authors subclass (campaign S2)
// =============================================================================
// Owner ask, verbatim from the plan: plugins "register their own Settings
// page to the sidebar via a SettingsPage component base class". This is that
// base. It is intentionally thin: identity (label/description/section), the
// app/state slot the rest of the client contract already uses (`mountApp`),
// and teardown that survives the shell's repaint cadence.
//
// Import path for plugins (documented in S6): absolute same-origin
// `/client/lib/settings-page.mjs`, resolved from the plugin's `moduleURL`
// module — one module instance per page, so the guarded registration below
// makes a double import harmless.
//
// Teardown contract: `addTeardown(fn)` registrations run EXACTLY ONCE on the
// first disconnect and the list is cleared before execution, so a reconnect →
// disconnect cycle cannot replay stale work. Subclasses that override
// `disconnectedCallback` must call `super.disconnectedCallback()`.

export class KikxSettingsPage extends HTMLElement {
  constructor() {
    super();
    this.label = '';
    this.description = '';
    this.section = 'General';
    this.app = null;
    this.appState = null;
    this.__teardowns = [];
  }

  configure({ label = '', description = '', section = 'General' } = {}) {
    if (typeof label === 'string' && label.trim() !== '')
      this.label = label.trim();
    if (typeof description === 'string')
      this.description = description;
    if (typeof section === 'string' && section.trim() !== '')
      this.section = section.trim();
    return this;
  }

  // The frame-component/view convention: handlers live on the app, live state
  // on `appState`. Provided together on purpose — a page handed only one of
  // the two renders once and then cannot update.
  mountApp(app) {
    this.app = app || null;
    this.appState = app && app._state ? app._state : null;
    return this;
  }

  addTeardown(fn) {
    if (typeof fn === 'function')
      this.__teardowns.push(fn);
    return fn;
  }

  disconnectedCallback() {
    const pending = Array.isArray(this.__teardowns) ? this.__teardowns : [];
    this.__teardowns = [];
    for (const fn of pending) {
      try {
        fn();
      } catch (error) {
        console.error('[settings-page] teardown failed', error);
      }
    }
  }
}

if (!customElements.get('kikx-settings-page'))
  customElements.define('kikx-settings-page', KikxSettingsPage);
