'use strict';

import { describe, it, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — must happen before importing the component module, because
// customElements.define() runs at import time and requires browser globals.
// ESM static imports are hoisted, so we use dynamic import() after setup.
//
// We create ONE jsdom instance for the entire test suite. Recreating it would
// lose the custom element registration (which happens once on module load).
// ---------------------------------------------------------------------------

let dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url:               'http://localhost/kikx/',
  pretendToBeVisual: true,
});

globalThis.window          = dom.window;
globalThis.document        = dom.window.document;
globalThis.HTMLElement      = dom.window.HTMLElement;
globalThis.customElements   = dom.window.customElements;
globalThis.Node             = dom.window.Node;
globalThis.Event            = dom.window.Event;
globalThis.CustomEvent      = dom.window.CustomEvent;

// Module-level references filled in by before() hook.
let navigate;
let getCurrentRoute;
let resetRouter;
let stopRouter;
let profile;
let resetStore;
let KikxApplication;

describe('kikx-application', () => {
  let element;

  before(async () => {
    // Dynamic imports run after the DOM globals are assigned above.
    let routerModule    = await import('../../lib/router.mjs');
    let storeModule     = await import('../../lib/store.mjs');
    let componentModule = await import('../../components/kikx-application/kikx-application.mjs');

    navigate        = routerModule.navigate;
    getCurrentRoute = routerModule.getCurrentRoute;
    resetRouter     = routerModule.reset;
    stopRouter      = routerModule.stop;
    profile         = storeModule.profile;
    resetStore      = storeModule.resetStore;
    KikxApplication = componentModule.default;
  });

  beforeEach(() => {
    resetRouter();
    resetStore();

    // Reset the URL to the base path.
    dom.window.history.replaceState(null, '', '/kikx/');

    // Clear the body for a fresh DOM.
    dom.window.document.body.innerHTML = '';

    element = dom.window.document.createElement('kikx-application');
  });

  afterEach(() => {
    if (element && element.parentNode)
      element.parentNode.removeChild(element);

    stopRouter();
  });

  // --------------------------------------------------------- registration

  it('registers as a custom element', () => {
    let Constructor = dom.window.customElements.get('kikx-application');
    assert.ok(Constructor);
    assert.equal(Constructor, KikxApplication);
  });

  // --------------------------------------------------------- route definitions

  it('defines routes on connect', () => {
    dom.window.document.body.appendChild(element);

    // Authenticate so we can test protected routes.
    profile.setUser({ id: 1 }, 'token');

    navigate('/kikx/login');
    assert.equal(getCurrentRoute().route.name, 'login');

    navigate('/kikx/');
    assert.equal(getCurrentRoute().route.name, 'sessions');

    navigate('/kikx/sessions/abc');
    assert.equal(getCurrentRoute().route.name, 'session');
    assert.equal(getCurrentRoute().params.id, 'abc');

    navigate('/kikx/settings');
    assert.equal(getCurrentRoute().route.name, 'settings');
  });

  // --------------------------------------------------------- page rendering

  it('renders kikx-login-page when route changes to login', () => {
    dom.window.document.body.appendChild(element);

    navigate('/kikx/login');

    let page = element.querySelector('kikx-login-page');
    assert.ok(page, 'expected kikx-login-page to be rendered');
  });

  it('renders sessions page placeholder when route changes to sessions', () => {
    profile.setUser({ id: 1 }, 'token');
    dom.window.document.body.appendChild(element);

    navigate('/kikx/');

    let page = element.querySelector('kikx-session-page');
    assert.ok(page, 'expected kikx-session-page to be rendered');
  });

  it('renders sessions page placeholder with params when route changes to session', () => {
    profile.setUser({ id: 1 }, 'token');
    dom.window.document.body.appendChild(element);

    navigate('/kikx/sessions/xyz-789');

    let page = element.querySelector('kikx-session-page');
    assert.ok(page, 'expected kikx-session-page to be rendered');
    assert.equal(page.getAttribute('data-id'), 'xyz-789');
  });

  it('renders settings page placeholder when route changes to settings', () => {
    profile.setUser({ id: 1 }, 'token');
    dom.window.document.body.appendChild(element);

    navigate('/kikx/settings');

    let page = element.querySelector('kikx-settings-page');
    assert.ok(page, 'expected kikx-settings-page to be rendered');
  });

  // --------------------------------------------------------- auth guard

  it('redirects to login when not authenticated and navigating to a protected route', () => {
    dom.window.document.body.appendChild(element);

    navigate('/kikx/settings');

    let { route } = getCurrentRoute();
    assert.equal(route.name, 'login');

    let page = element.querySelector('kikx-login-page');
    assert.ok(page, 'expected kikx-login-page after redirect');
  });

  it('allows navigation to protected routes when authenticated', () => {
    profile.setUser({ id: 1, name: 'Test' }, 'test-token');
    dom.window.document.body.appendChild(element);

    navigate('/kikx/settings');

    let { route } = getCurrentRoute();
    assert.equal(route.name, 'settings');

    let page = element.querySelector('kikx-settings-page');
    assert.ok(page, 'expected kikx-settings-page when authenticated');
  });

  // --------------------------------------------------------- disconnect

  it('stops the router on disconnect', () => {
    dom.window.document.body.appendChild(element);
    dom.window.document.body.removeChild(element);

    // The initial connect rendered a page (auth redirect to login).
    // Clear the element so we can verify no new renders happen.
    element.innerHTML = '';

    // After disconnect, navigating should not trigger page rendering
    // in the (now detached) element.
    navigate('/kikx/login');

    assert.equal(element.children.length, 0, 'no new page should render after disconnect');
  });

  // --------------------------------------------------------- page switching

  it('clears previous page when switching routes', () => {
    profile.setUser({ id: 1 }, 'token');
    dom.window.document.body.appendChild(element);

    navigate('/kikx/settings');
    assert.ok(element.querySelector('kikx-settings-page'));

    navigate('/kikx/');
    assert.ok(element.querySelector('kikx-session-page'));
    assert.equal(element.querySelector('kikx-settings-page'), null, 'previous page should be removed');
    assert.equal(element.children.length, 1);
  });
});
