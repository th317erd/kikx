'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM } from './jsdom-helper.mjs';

let router;

before(async () => {
  setupDOM();
  router = await import('../../src/client/lib/router.mjs');
});

after(() => {
  teardownDOM();
});

beforeEach(() => {
  router.reset();
});

// =============================================================================
// defineRoute
// =============================================================================

describe('Router: defineRoute', { timeout: 5000 }, () => {
  it('should register a static route', () => {
    router.defineRoute('/kikx/', 'home');
    window.history.pushState(null, '', '/kikx/');
    router.resolve();

    let current = router.getCurrentRoute();
    assert.equal(current.route.name, 'home');
  });

  it('should register a route with parameters', () => {
    router.defineRoute('/kikx/sessions/:id', 'session');
    window.history.pushState(null, '', '/kikx/sessions/ses_abc123');
    router.resolve();

    let current = router.getCurrentRoute();
    assert.equal(current.route.name, 'session');
    assert.equal(current.params.id, 'ses_abc123');
  });

  it('should support multiple parameters', () => {
    router.defineRoute('/kikx/users/:userID/sessions/:sessionID', 'user-session');
    window.history.pushState(null, '', '/kikx/users/usr_1/sessions/ses_2');
    router.resolve();

    let current = router.getCurrentRoute();
    assert.equal(current.params.userID, 'usr_1');
    assert.equal(current.params.sessionID, 'ses_2');
  });
});

// =============================================================================
// navigate
// =============================================================================

describe('Router: navigate', { timeout: 5000 }, () => {
  it('should change window.location.pathname via pushState', () => {
    router.defineRoute('/kikx/', 'home');
    router.defineRoute('/kikx/settings', 'settings');
    router.navigate('/kikx/settings');

    assert.equal(window.location.pathname, '/kikx/settings');
  });

  it('should resolve the route after navigation', () => {
    router.defineRoute('/kikx/settings', 'settings');
    router.navigate('/kikx/settings');

    let current = router.getCurrentRoute();
    assert.equal(current.route.name, 'settings');
  });

  it('should support replace option', () => {
    router.defineRoute('/kikx/', 'home');
    router.defineRoute('/kikx/login', 'login');

    router.navigate('/kikx/');
    router.navigate('/kikx/login', { replace: true });

    assert.equal(window.location.pathname, '/kikx/login');
  });
});

// =============================================================================
// resolve
// =============================================================================

describe('Router: resolve', { timeout: 5000 }, () => {
  it('should set currentRoute to null for unmatched path', () => {
    router.defineRoute('/kikx/', 'home');
    window.history.pushState(null, '', '/unknown/path');
    router.resolve();

    let current = router.getCurrentRoute();
    assert.equal(current.route, null);
    assert.deepStrictEqual(current.params, {});
  });

  it('should match first matching route', () => {
    router.defineRoute('/kikx/', 'home');
    router.defineRoute('/kikx/settings', 'settings');
    window.history.pushState(null, '', '/kikx/');
    router.resolve();

    assert.equal(router.getCurrentRoute().route.name, 'home');
  });
});

// =============================================================================
// Auth guard
// =============================================================================

describe('Router: auth guard', { timeout: 5000 }, () => {
  it('should redirect to login when auth check fails', () => {
    router.setAuthCheck(() => false);
    router.defineRoute('/kikx/', 'home', { requiresAuthentication: true });
    router.defineRoute('/kikx/login', 'login');

    router.navigate('/kikx/');

    // Should have been redirected
    assert.equal(window.location.pathname, '/kikx/login');
  });

  it('should allow navigation when auth check passes', () => {
    router.setAuthCheck(() => true);
    router.defineRoute('/kikx/', 'home', { requiresAuthentication: true });

    router.navigate('/kikx/');

    assert.equal(window.location.pathname, '/kikx/');
    assert.equal(router.getCurrentRoute().route.name, 'home');
  });

  it('should not guard routes without requiresAuthentication', () => {
    router.setAuthCheck(() => false);
    router.defineRoute('/kikx/login', 'login');

    router.navigate('/kikx/login');

    assert.equal(window.location.pathname, '/kikx/login');
    assert.equal(router.getCurrentRoute().route.name, 'login');
  });

  it('should use custom unauthorized redirect', () => {
    router.setAuthCheck(() => false);
    router.setUnauthorizedRedirect('/kikx/custom-login');
    router.defineRoute('/kikx/', 'home', { requiresAuthentication: true });
    router.defineRoute('/kikx/custom-login', 'custom-login');

    router.navigate('/kikx/');

    assert.equal(window.location.pathname, '/kikx/custom-login');
  });
});

// =============================================================================
// onRouteChange
// =============================================================================

describe('Router: onRouteChange', { timeout: 5000 }, () => {
  it('should notify listeners on navigation', () => {
    router.defineRoute('/kikx/', 'home');
    router.defineRoute('/kikx/settings', 'settings');

    let received = null;
    router.onRouteChange((data) => { received = data; });

    router.navigate('/kikx/settings');

    assert.ok(received);
    assert.equal(received.route.name, 'settings');
  });

  it('should return unsubscribe function', () => {
    router.defineRoute('/kikx/', 'home');
    router.defineRoute('/kikx/settings', 'settings');

    let callCount = 0;
    let unsubscribe = router.onRouteChange(() => { callCount++; });

    router.navigate('/kikx/');
    assert.equal(callCount, 1);

    unsubscribe();
    router.navigate('/kikx/settings');
    assert.equal(callCount, 1, 'Should not call after unsubscribe');
  });

  it('should notify multiple listeners', () => {
    router.defineRoute('/kikx/', 'home');

    let count1 = 0;
    let count2 = 0;
    router.onRouteChange(() => { count1++; });
    router.onRouteChange(() => { count2++; });

    router.navigate('/kikx/');

    assert.equal(count1, 1);
    assert.equal(count2, 1);
  });
});

// =============================================================================
// getParams
// =============================================================================

describe('Router: getParams', { timeout: 5000 }, () => {
  it('should return empty object when no params', () => {
    router.defineRoute('/kikx/', 'home');
    router.navigate('/kikx/');
    assert.deepStrictEqual(router.getParams(), {});
  });

  it('should return a copy of params (not the original)', () => {
    router.defineRoute('/kikx/sessions/:id', 'session');
    router.navigate('/kikx/sessions/ses_1');

    let params = router.getParams();
    params.id = 'mutated';

    assert.equal(router.getParams().id, 'ses_1', 'Should not be affected by mutation');
  });
});

// =============================================================================
// reset
// =============================================================================

describe('Router: reset', { timeout: 5000 }, () => {
  it('should clear all routes and listeners', () => {
    router.defineRoute('/kikx/', 'home');
    let callCount = 0;
    router.onRouteChange(() => { callCount++; });

    router.reset();

    // After reset, route should not match
    window.history.pushState(null, '', '/kikx/');
    router.resolve();

    assert.equal(router.getCurrentRoute().route, null);
    // Listener was cleared by reset, but resolve still calls notifyListeners
    // (which iterates an empty array), so callCount stays 0 from the reset
  });
});
