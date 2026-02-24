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
  login:    'hero-login-page',
  sessions: 'hero-session-page',
  session:  'hero-session-page',
  settings: 'hero-settings-page',
};

class HeroApplication extends HTMLElement {
  constructor() {
    super();
    this.removeRouteChangeListener = null;
  }

  connectedCallback() {
    defineRoute('/hero/login',        'login');
    defineRoute('/hero/',             'sessions', { requiresAuthentication: true });
    defineRoute('/hero/sessions/:id', 'session',  { requiresAuthentication: true });
    defineRoute('/hero/settings',     'settings', { requiresAuthentication: true });

    setAuthCheck(() => profile.isAuthenticated());
    setUnauthorizedRedirect('/hero/login');

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

customElements.define('hero-application', HeroApplication);

export default HeroApplication;
