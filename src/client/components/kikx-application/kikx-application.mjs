'use strict';

import {
  defineRoute,
  setAuthCheck,
  setUnauthorizedRedirect,
  onRouteChange,
  start,
  stop,
} from '../../lib/router.mjs';

import { profile } from '../../lib/store.mjs';

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
    defineRoute('/kikx/login',        'login');
    defineRoute('/kikx/',             'sessions', { requiresAuthentication: true });
    defineRoute('/kikx/sessions/:id', 'session',  { requiresAuthentication: true });
    defineRoute('/kikx/settings',     'settings', { requiresAuthentication: true });

    setAuthCheck(() => profile.isAuthenticated());
    setUnauthorizedRedirect('/kikx/login');

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
    while (this.firstChild)
      this.removeChild(this.firstChild);

    if (!route)
      return;

    let tagName = PAGE_ELEMENTS[route.name];
    if (!tagName)
      return;

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
