'use strict';

import {
  defineRoute,
  setAuthCheck,
  setUnauthorizedRedirect,
  onRouteChange,
  navigate,
  start,
  stop,
} from '../../lib/router.mjs';

import { BASE_PATH } from '../../lib/config.mjs';
import { profile, theme } from '../../lib/store.mjs';
import { setLocale } from '../../lib/i18n.mjs';
import { setAuthToken, loadPersistedAuth, clearPersistedAuth, setOnUnauthorized } from '../../lib/api.mjs';
import { init as initDebug } from '../../lib/debug.mjs';
import en from '../../lib/locales/en.mjs';

// Pre-import all custom element components
import '../registry.mjs';

const PAGE_ELEMENTS = {
  login:    'kikx-login-page',
  sessions: 'kikx-session-page',
  session:  'kikx-session-page',
  settings: 'kikx-settings-page',
};

class KikxApplication extends HTMLElement {
  constructor() {
    super();
    this.removeRouteChangeListener = null;
  }

  connectedCallback() {
    setLocale(en, 'en');
    initDebug();

    // Restore auth from localStorage
    let saved = loadPersistedAuth();
    if (saved) {
      setAuthToken(saved.token);
      profile.setUser(saved.user, saved.token);
    }

    // Restore accent color from localStorage
    try {
      let savedAccent = localStorage.getItem('kikx_accent');
      if (savedAccent) {
        theme.setAccent(savedAccent);
        document.documentElement.setAttribute('data-accent', savedAccent);
      }
    } catch (_e) { /* storage unavailable */ }

    // On 401, clear persisted auth and redirect to login immediately
    setOnUnauthorized(() => {
      clearPersistedAuth();
      profile.logout();
      navigate(BASE_PATH + '/login', { replace: true });
    });

    defineRoute(BASE_PATH + '/login',        'login');
    defineRoute(BASE_PATH + '/',             'sessions', { requiresAuthentication: true });
    defineRoute(BASE_PATH + '/sessions/:id', 'session',  { requiresAuthentication: true });
    defineRoute(BASE_PATH + '/settings',     'settings', { requiresAuthentication: true });

    setAuthCheck(() => profile.isAuthenticated());
    setUnauthorizedRedirect(BASE_PATH + '/login');

    this.removeRouteChangeListener = onRouteChange(({ route, params }) => {
      this.renderPage(route, params);
    });

    start();
  }

  disconnectedCallback() {
    if (this.removeRouteChangeListener) {
      this.removeRouteChangeListener();
      this.removeRouteChangeListener = null;
    }

    stop();
  }

  renderPage(route, params) {
    if (!route) {
      while (this.firstChild)
        this.removeChild(this.firstChild);

      return;
    }

    let tagName = PAGE_ELEMENTS[route.name];
    if (!tagName)
      return;

    // Reuse existing page element if the tag name matches (e.g., navigating
    // between sessions). This avoids destroying and rebuilding the sidebar,
    // friends list, etc. — just update the attributes so the page can swap
    // its content without a full teardown.
    let existing = this.firstChild;
    if (existing && existing.tagName === tagName.toUpperCase()) {
      if (params) {
        for (let [key, value] of Object.entries(params))
          existing.setAttribute(`data-${key}`, value);
      }

      return;
    }

    // Different page type — full swap
    while (this.firstChild)
      this.removeChild(this.firstChild);

    let page = document.createElement(tagName);

    if (params) {
      for (let [key, value] of Object.entries(params))
        page.setAttribute(`data-${key}`, value);
    }

    this.appendChild(page);
  }
}

customElements.define('kikx-application', KikxApplication);

export default KikxApplication;
