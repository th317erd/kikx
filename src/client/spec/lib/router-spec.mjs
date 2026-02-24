'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals mock — must be set before importing the router.
let pushStateHistory  = [];
let popstateListeners = [];

globalThis.window = {
  location: { pathname: '/hero/' },
  history:  {
    pushState: (state, title, url) => {
      pushStateHistory.push(url);
      globalThis.window.location.pathname = url;
    },
    replaceState: (state, title, url) => {
      globalThis.window.location.pathname = url;
    },
  },
  addEventListener: (event, handler) => {
    if (event === 'popstate')
      popstateListeners.push(handler);
  },
  removeEventListener: (event, handler) => {
    if (event === 'popstate') {
      let index = popstateListeners.indexOf(handler);
      if (index >= 0)
        popstateListeners.splice(index, 1);
    }
  },
};

import {
  defineRoute,
  setAuthCheck,
  setUnauthorizedRedirect,
  navigate,
  resolve,
  onRouteChange,
  getCurrentRoute,
  getParams,
  start,
  stop,
  reset,
} from '../../lib/router.mjs';

// Helper: reset router module state between tests by re-importing is not possible
// with ESM caching, so we manage state by unsubscribing listeners and re-registering
// routes explicitly in each test. We also expose a helper that fires popstate.
function firePopState() {
  for (let listener of popstateListeners)
    listener(new Event('popstate'));
}

describe('router', () => {
  let cleanupFunctions = [];

  beforeEach(() => {
    // Reset mock state.
    pushStateHistory.length  = 0;
    popstateListeners.length = 0;
    globalThis.window.location.pathname = '/hero/';
    cleanupFunctions.length = 0;

    // Reset all router module state so routes, listeners, and auth config
    // do not bleed between tests (ESM modules are cached and only run once).
    reset();
  });

  afterEach(() => {
    for (let cleanup of cleanupFunctions)
      cleanup();

    stop();
  });

  // ------------------------------------------------------------------ helpers

  function setupRoutes() {
    defineRoute('/hero/login',        'login');
    defineRoute('/hero/',             'home');
    defineRoute('/hero/sessions/:id', 'session');
    defineRoute('/hero/settings',     'settings');
  }

  // ------------------------------------------------------------------ tests

  it('defineRoute() registers a route that is matched when navigate() is called', () => {
    defineRoute('/hero/', 'home');
    navigate('/hero/');
    let { route } = getCurrentRoute();
    assert.equal(route.name, 'home');
  });

  it('navigate() pushes the path to history', () => {
    defineRoute('/hero/', 'home');
    navigate('/hero/');
    assert.ok(pushStateHistory.includes('/hero/'));
  });

  it('navigate() resolves to the correct route', () => {
    setupRoutes();
    navigate('/hero/settings');
    let { route } = getCurrentRoute();
    assert.equal(route.name, 'settings');
  });

  it('navigate() extracts named params from the URL', () => {
    setupRoutes();
    navigate('/hero/sessions/abc123');
    let { params } = getCurrentRoute();
    assert.equal(params.id, 'abc123');
  });

  it('getCurrentRoute() returns current matched route and params together', () => {
    setupRoutes();
    navigate('/hero/sessions/xyz');
    let { route, params } = getCurrentRoute();
    assert.equal(route.name, 'session');
    assert.equal(params.id, 'xyz');
  });

  it('getParams() returns a copy of the current params', () => {
    setupRoutes();
    navigate('/hero/sessions/copy-test');
    let params = getParams();
    assert.equal(params.id, 'copy-test');

    // Verify it is a copy — mutating it does not affect internal state.
    params.id = 'mutated';
    assert.equal(getParams().id, 'copy-test');
  });

  it('onRouteChange() callback fires when navigate() is called', () => {
    setupRoutes();

    let callCount = 0;
    let unsubscribe = onRouteChange(() => {
      callCount++;
    });
    cleanupFunctions.push(unsubscribe);

    navigate('/hero/settings');
    assert.equal(callCount, 1);
  });

  it('onRouteChange() returns an unsubscribe function that stops future notifications', () => {
    setupRoutes();

    let callCount   = 0;
    let unsubscribe = onRouteChange(() => {
      callCount++;
    });

    navigate('/hero/settings');
    assert.equal(callCount, 1);

    unsubscribe();
    navigate('/hero/');
    assert.equal(callCount, 1);
  });

  it('multiple listeners all receive route change notifications', () => {
    setupRoutes();

    let firstCallCount  = 0;
    let secondCallCount = 0;
    let thirdCallCount  = 0;

    let unsubscribeFirst  = onRouteChange(() => { firstCallCount++; });
    let unsubscribeSecond = onRouteChange(() => { secondCallCount++; });
    let unsubscribeThird  = onRouteChange(() => { thirdCallCount++; });
    cleanupFunctions.push(unsubscribeFirst, unsubscribeSecond, unsubscribeThird);

    navigate('/hero/settings');
    assert.equal(firstCallCount, 1);
    assert.equal(secondCallCount, 1);
    assert.equal(thirdCallCount, 1);
  });

  it('auth guard redirects to login when route requiresAuthentication and user is not authenticated', () => {
    defineRoute('/hero/login',        'login');
    defineRoute('/hero/',             'home');
    defineRoute('/hero/sessions/:id', 'session', { requiresAuthentication: true });
    defineRoute('/hero/settings',     'settings');

    setAuthCheck(() => false);

    navigate('/hero/sessions/secret');
    let { route } = getCurrentRoute();
    assert.equal(route.name, 'login');
  });

  it('auth guard allows navigation when route requiresAuthentication and user is authenticated', () => {
    defineRoute('/hero/login',        'login');
    defineRoute('/hero/',             'home');
    defineRoute('/hero/sessions/:id', 'session', { requiresAuthentication: true });
    defineRoute('/hero/settings',     'settings');

    setAuthCheck(() => true);
    navigate('/hero/sessions/permitted');
    let { route, params } = getCurrentRoute();
    assert.equal(route.name, 'session');
    assert.equal(params.id, 'permitted');
  });

  it('navigate() with replace:true uses replaceState instead of pushState', () => {
    setupRoutes();
    let beforeLength = pushStateHistory.length;
    navigate('/hero/', { replace: true });
    assert.equal(pushStateHistory.length, beforeLength);
    assert.equal(globalThis.window.location.pathname, '/hero/');
  });

  it('unmatched route sets currentRoute to null', () => {
    setupRoutes();
    navigate('/hero/does-not-exist');
    let { route } = getCurrentRoute();
    assert.equal(route, null);
  });

  it('start() resolves the initial URL immediately', () => {
    setupRoutes();
    globalThis.window.location.pathname = '/hero/settings';
    start();
    let { route } = getCurrentRoute();
    assert.equal(route.name, 'settings');
  });

  it('popstate event triggers resolve (simulates browser back/forward)', () => {
    setupRoutes();
    start();

    // Simulate the browser changing the URL and firing popstate.
    globalThis.window.location.pathname = '/hero/sessions/back-nav';
    firePopState();

    let { route, params } = getCurrentRoute();
    assert.equal(route.name, 'session');
    assert.equal(params.id, 'back-nav');
  });

  it('stop() removes the popstate listener so browser back no longer triggers resolve', () => {
    setupRoutes();
    start();
    stop();

    // Confirm listener was removed.
    assert.equal(popstateListeners.length, 0);
  });

  it('route matching: more specific routes registered first match before less specific ones', () => {
    // Register a catch-all-like pattern last to confirm order matters.
    defineRoute('/hero/sessions/new',  'new-session');
    defineRoute('/hero/sessions/:id',  'session');

    navigate('/hero/sessions/new');
    let { route } = getCurrentRoute();
    assert.equal(route.name, 'new-session');
  });

  it('route without :params matches exactly (no partial matching)', () => {
    defineRoute('/hero/', 'home');
    navigate('/hero/');
    let { route, params } = getCurrentRoute();
    assert.equal(route.name, 'home');
    assert.deepEqual(params, {});
  });
});
