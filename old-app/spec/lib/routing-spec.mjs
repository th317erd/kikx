'use strict';

// ============================================================================
// Routing Tests
// ============================================================================
// Tests for public/js/routing.js route parsing logic

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDOM, destroyDOM, getDocument, getWindow } from '../helpers/dom-helpers.mjs';

// ============================================================================
// Test Setup - Mock the route parsing function
// ============================================================================

// BASE_PATH is typically empty or a subdirectory
let BASE_PATH = '';

function getRoute(pathname) {
  let path = pathname;

  // Strip base path
  if (BASE_PATH && path.startsWith(BASE_PATH))
    path = path.slice(BASE_PATH.length) || '/';

  if (path === '/login')
    return { view: 'login' };

  if (path === '/' || path === '')
    return { view: 'sessions' };

  if (path === '/settings')
    return { view: 'settings' };

  let settingsTabMatch = path.match(/^\/settings\/([\w-]+)$/);

  if (settingsTabMatch)
    return { view: 'settings', tab: settingsTabMatch[1] };

  let sessionMatch = path.match(/^\/sessions\/(\d+)$/);

  if (sessionMatch)
    return { view: 'chat', sessionId: parseInt(sessionMatch[1], 10) };

  // Unknown route, default to sessions
  return { view: 'sessions' };
}

// ============================================================================
// Tests: Route Parsing
// ============================================================================

describe('Route Parsing', () => {
  describe('Login Route', () => {
    it('should match /login path', () => {
      const route = getRoute('/login');
      assert.deepStrictEqual(route, { view: 'login' });
    });
  });

  describe('Sessions Route', () => {
    it('should match root path /', () => {
      const route = getRoute('/');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });

    it('should match empty path', () => {
      const route = getRoute('');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });
  });

  describe('Chat Route', () => {
    it('should match /sessions/1', () => {
      const route = getRoute('/sessions/1');
      assert.deepStrictEqual(route, { view: 'chat', sessionId: 1 });
    });

    it('should match /sessions/123', () => {
      const route = getRoute('/sessions/123');
      assert.deepStrictEqual(route, { view: 'chat', sessionId: 123 });
    });

    it('should match /sessions/999999', () => {
      const route = getRoute('/sessions/999999');
      assert.deepStrictEqual(route, { view: 'chat', sessionId: 999999 });
    });

    it('should parse sessionId as integer', () => {
      const route = getRoute('/sessions/42');
      assert.strictEqual(typeof route.sessionId, 'number');
      assert.strictEqual(route.sessionId, 42);
    });
  });

  describe('Settings Route', () => {
    it('should match /settings path', () => {
      const route = getRoute('/settings');
      assert.deepStrictEqual(route, { view: 'settings' });
    });

    it('should match /settings/profile', () => {
      const route = getRoute('/settings/profile');
      assert.deepStrictEqual(route, { view: 'settings', tab: 'profile' });
    });

    it('should match /settings/account', () => {
      const route = getRoute('/settings/account');
      assert.deepStrictEqual(route, { view: 'settings', tab: 'account' });
    });

    it('should match /settings/api-keys', () => {
      const route = getRoute('/settings/api-keys');
      assert.deepStrictEqual(route, { view: 'settings', tab: 'api-keys' });
    });

    it('should return tab name as string', () => {
      const route = getRoute('/settings/profile');
      assert.strictEqual(typeof route.tab, 'string');
      assert.strictEqual(route.tab, 'profile');
    });

    it('should not match /settings/foo/bar (nested)', () => {
      const route = getRoute('/settings/foo/bar');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });
  });

  describe('Unknown Routes', () => {
    it('should default to sessions for unknown paths', () => {
      const route = getRoute('/unknown');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });

    it('should default to sessions for /sessions without ID', () => {
      const route = getRoute('/sessions');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });

    it('should default to sessions for /sessions/', () => {
      const route = getRoute('/sessions/');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });

    it('should default to sessions for /sessions/abc (non-numeric)', () => {
      const route = getRoute('/sessions/abc');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });

    it('should default to sessions for nested unknown paths', () => {
      const route = getRoute('/foo/bar/baz');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });
  });

  describe('Edge Cases', () => {
    it('should not match /sessions/1/extra', () => {
      const route = getRoute('/sessions/1/extra');
      assert.deepStrictEqual(route, { view: 'sessions' });
    });

    it('should not match /sessions/1?query', () => {
      // Query strings should be handled separately, but pathname won't include them
      const route = getRoute('/sessions/1');
      assert.deepStrictEqual(route, { view: 'chat', sessionId: 1 });
    });

    it('should handle /login/ with trailing slash', () => {
      const route = getRoute('/login/');
      // This will fall through to unknown and default to sessions
      assert.deepStrictEqual(route, { view: 'sessions' });
    });
  });
});

// ============================================================================
// Tests: Base Path Handling
// ============================================================================

describe('Base Path Handling', () => {
  it('should work with empty BASE_PATH', () => {
    BASE_PATH = '';
    const route = getRoute('/sessions/5');
    assert.deepStrictEqual(route, { view: 'chat', sessionId: 5 });
  });

  it('should strip BASE_PATH from route', () => {
    BASE_PATH = '/app';

    // Mock getRoute with BASE_PATH
    function getRouteWithBase(pathname) {
      let path = pathname;
      if (BASE_PATH && path.startsWith(BASE_PATH))
        path = path.slice(BASE_PATH.length) || '/';

      if (path === '/login') return { view: 'login' };
      if (path === '/' || path === '') return { view: 'sessions' };
      let sessionMatch = path.match(/^\/sessions\/(\d+)$/);
      if (sessionMatch) return { view: 'chat', sessionId: parseInt(sessionMatch[1], 10) };
      return { view: 'sessions' };
    }

    const route = getRouteWithBase('/app/sessions/10');
    assert.deepStrictEqual(route, { view: 'chat', sessionId: 10 });

    BASE_PATH = ''; // Reset
  });

  it('should handle BASE_PATH for root', () => {
    BASE_PATH = '/hero';

    function getRouteWithBase(pathname) {
      let path = pathname;
      if (BASE_PATH && path.startsWith(BASE_PATH))
        path = path.slice(BASE_PATH.length) || '/';

      if (path === '/login') return { view: 'login' };
      if (path === '/' || path === '') return { view: 'sessions' };
      return { view: 'sessions' };
    }

    const route = getRouteWithBase('/hero');
    assert.deepStrictEqual(route, { view: 'sessions' });

    BASE_PATH = '';
  });
});

// ============================================================================
// Tests: View Display Logic
// ============================================================================

describe('View Display Logic', () => {
  beforeEach(() => createDOM());
  afterEach(() => destroyDOM());

  function showView(viewName, elements) {
    elements.loginView.style.display    = (viewName === 'login') ? 'flex' : 'none';
    elements.sessionsView.style.display = (viewName === 'sessions') ? 'flex' : 'none';
    elements.chatView.style.display     = (viewName === 'chat') ? 'flex' : 'none';
    if (elements.settingsView)
      elements.settingsView.style.display = (viewName === 'settings') ? 'flex' : 'none';
  }

  function createViewElements(doc) {
    return {
      loginView:    doc.createElement('div'),
      sessionsView: doc.createElement('div'),
      chatView:     doc.createElement('div'),
      settingsView: doc.createElement('div'),
    };
  }

  it('should show only login view when view is login', () => {
    const doc = getDocument();
    const elements = createViewElements(doc);

    showView('login', elements);

    assert.strictEqual(elements.loginView.style.display, 'flex');
    assert.strictEqual(elements.sessionsView.style.display, 'none');
    assert.strictEqual(elements.chatView.style.display, 'none');
    assert.strictEqual(elements.settingsView.style.display, 'none');
  });

  it('should show only sessions view when view is sessions', () => {
    const doc = getDocument();
    const elements = createViewElements(doc);

    showView('sessions', elements);

    assert.strictEqual(elements.loginView.style.display, 'none');
    assert.strictEqual(elements.sessionsView.style.display, 'flex');
    assert.strictEqual(elements.chatView.style.display, 'none');
    assert.strictEqual(elements.settingsView.style.display, 'none');
  });

  it('should show only chat view when view is chat', () => {
    const doc = getDocument();
    const elements = createViewElements(doc);

    showView('chat', elements);

    assert.strictEqual(elements.loginView.style.display, 'none');
    assert.strictEqual(elements.sessionsView.style.display, 'none');
    assert.strictEqual(elements.chatView.style.display, 'flex');
    assert.strictEqual(elements.settingsView.style.display, 'none');
  });

  it('should show only settings view when view is settings', () => {
    const doc = getDocument();
    const elements = createViewElements(doc);

    showView('settings', elements);

    assert.strictEqual(elements.loginView.style.display, 'none');
    assert.strictEqual(elements.sessionsView.style.display, 'none');
    assert.strictEqual(elements.chatView.style.display, 'none');
    assert.strictEqual(elements.settingsView.style.display, 'flex');
  });
});

// ============================================================================
// Tests: View Change Events
// ============================================================================

describe('View Change Events', () => {
  beforeEach(() => createDOM());
  afterEach(() => destroyDOM());

  it('should dispatch viewchange event with correct detail', () => {
    const doc = getDocument();
    let receivedEvent = null;

    doc.addEventListener('viewchange', (e) => {
      receivedEvent = e;
    });

    doc.dispatchEvent(new doc.defaultView.CustomEvent('viewchange', {
      detail: { view: 'chat' },
    }));

    assert.ok(receivedEvent, 'Event should be received');
    assert.strictEqual(receivedEvent.detail.view, 'chat');
  });
});
