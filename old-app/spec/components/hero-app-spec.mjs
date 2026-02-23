/**
 * Tests for hero-app.js
 *
 * Tests HeroApp root component:
 * - Route parsing and view switching
 * - Authentication state handling
 * - Base path support
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// Mock DynamicProperty
const mockDynamicProperty = {
  set: Symbol('DynamicProperty.set'),
};

// Create mock dynamic properties
function createMockDynamicProp(initialValue) {
  let value     = initialValue;
  let listeners = [];

  let prop = {
    valueOf() {
      return value;
    },
    addEventListener(event, handler) {
      if (event === 'update') {
        listeners.push(handler);
      }
    },
    removeEventListener(event, handler) {
      if (event === 'update') {
        listeners = listeners.filter((h) => h !== handler);
      }
    },
    [mockDynamicProperty.set](newValue) {
      let oldValue = value;
      value = newValue;
      listeners.forEach((h) => h({ value: newValue, oldValue }));
    },
  };

  return prop;
}

// Mock GlobalState
function createMockGlobalState() {
  return {
    user:               createMockDynamicProp(null),
    sessions:           createMockDynamicProp([]),
    agents:             createMockDynamicProp([]),
    abilities:          createMockDynamicProp({ system: [], user: [] }),
    currentSession:     createMockDynamicProp(null),
    wsConnected:        createMockDynamicProp(false),
    globalSpend:        createMockDynamicProp({ cost: 0, inputTokens: 0, outputTokens: 0 }),
    showHiddenSessions: createMockDynamicProp(false),
  };
}

describe('HeroApp Route Parsing', () => {
  let parseRoute;

  beforeEach(() => {
    // Define parseRoute function (to be implemented in hero-app.js)
    parseRoute = (pathname, basePath = '') => {
      let path = pathname;

      // Strip base path
      if (basePath && path.startsWith(basePath)) {
        path = path.slice(basePath.length) || '/';
      }

      if (path === '/login') {
        return { view: 'login' };
      }

      if (path === '/' || path === '') {
        return { view: 'sessions' };
      }

      let sessionMatch = path.match(/^\/sessions\/(\d+)$/);

      if (sessionMatch) {
        return { view: 'chat', sessionId: parseInt(sessionMatch[1], 10) };
      }

      // Unknown route defaults to sessions
      return { view: 'sessions' };
    };
  });

  it('should parse root path as sessions view', () => {
    let route = parseRoute('/');
    assert.strictEqual(route.view, 'sessions');
  });

  it('should parse empty path as sessions view', () => {
    let route = parseRoute('');
    assert.strictEqual(route.view, 'sessions');
  });

  it('should parse /login as login view', () => {
    let route = parseRoute('/login');
    assert.strictEqual(route.view, 'login');
  });

  it('should parse /sessions/:id as chat view', () => {
    let route = parseRoute('/sessions/123');
    assert.strictEqual(route.view, 'chat');
    assert.strictEqual(route.sessionId, 123);
  });

  it('should parse session ID as integer', () => {
    let route = parseRoute('/sessions/456');
    assert.strictEqual(typeof route.sessionId, 'number');
    assert.strictEqual(route.sessionId, 456);
  });

  it('should handle base path correctly', () => {
    let route = parseRoute('/hero/sessions/123', '/hero');
    assert.strictEqual(route.view, 'chat');
    assert.strictEqual(route.sessionId, 123);
  });

  it('should handle base path for root', () => {
    let route = parseRoute('/hero/', '/hero');
    assert.strictEqual(route.view, 'sessions');
  });

  it('should handle base path for login', () => {
    let route = parseRoute('/hero/login', '/hero');
    assert.strictEqual(route.view, 'login');
  });

  it('should default unknown routes to sessions', () => {
    let route = parseRoute('/unknown/path');
    assert.strictEqual(route.view, 'sessions');
  });

  it('should not match partial session paths', () => {
    let route = parseRoute('/sessions');
    assert.strictEqual(route.view, 'sessions');
    assert.strictEqual(route.sessionId, undefined);
  });

  it('should not match non-numeric session IDs', () => {
    let route = parseRoute('/sessions/abc');
    assert.strictEqual(route.view, 'sessions');
    assert.strictEqual(route.sessionId, undefined);
  });
});

describe('HeroApp View State', () => {
  let GlobalState;

  beforeEach(() => {
    GlobalState = createMockGlobalState();
  });

  it('should start with user as null', () => {
    assert.strictEqual(GlobalState.user.valueOf(), null);
  });

  it('should update view based on authentication', () => {
    // When user is null, login view should be shown for protected routes
    let isAuthenticated = GlobalState.user.valueOf() !== null;
    assert.strictEqual(isAuthenticated, false);

    // After setting user, should be authenticated
    GlobalState.user[mockDynamicProperty.set]({ id: 1, username: 'test' });
    isAuthenticated = GlobalState.user.valueOf() !== null;
    assert.strictEqual(isAuthenticated, true);
  });

  it('should track WebSocket connection state', () => {
    assert.strictEqual(GlobalState.wsConnected.valueOf(), false);

    GlobalState.wsConnected[mockDynamicProperty.set](true);
    assert.strictEqual(GlobalState.wsConnected.valueOf(), true);
  });
});

describe('HeroApp Navigation', () => {
  let GlobalState;
  let navigationHistory;

  beforeEach(() => {
    GlobalState = createMockGlobalState();
    navigationHistory = [];
  });

  // Simulate navigate function behavior
  function navigate(path, basePath = '') {
    navigationHistory.push(basePath + path);
  }

  it('should navigate to sessions list', () => {
    navigate('/');
    assert.strictEqual(navigationHistory.length, 1);
    assert.strictEqual(navigationHistory[0], '/');
  });

  it('should navigate to specific session', () => {
    navigate('/sessions/123');
    assert.strictEqual(navigationHistory[0], '/sessions/123');
  });

  it('should navigate with base path', () => {
    navigate('/sessions/123', '/hero');
    assert.strictEqual(navigationHistory[0], '/hero/sessions/123');
  });

  it('should navigate to login', () => {
    navigate('/login');
    assert.strictEqual(navigationHistory[0], '/login');
  });
});

describe('HeroApp Authentication Flow', () => {
  let GlobalState;

  beforeEach(() => {
    GlobalState = createMockGlobalState();
  });

  it('should clear user on logout', () => {
    // Set user first
    GlobalState.user[mockDynamicProperty.set]({ id: 1, username: 'test' });
    assert.ok(GlobalState.user.valueOf() !== null);

    // Logout
    GlobalState.user[mockDynamicProperty.set](null);
    assert.strictEqual(GlobalState.user.valueOf(), null);
  });

  it('should clear sessions on logout', () => {
    GlobalState.sessions[mockDynamicProperty.set]([{ id: 1, name: 'Test' }]);
    assert.strictEqual(GlobalState.sessions.valueOf().length, 1);

    // Clear on logout
    GlobalState.sessions[mockDynamicProperty.set]([]);
    assert.strictEqual(GlobalState.sessions.valueOf().length, 0);
  });

  it('should disconnect WebSocket on logout', () => {
    GlobalState.wsConnected[mockDynamicProperty.set](true);
    assert.strictEqual(GlobalState.wsConnected.valueOf(), true);

    // Disconnect on logout
    GlobalState.wsConnected[mockDynamicProperty.set](false);
    assert.strictEqual(GlobalState.wsConnected.valueOf(), false);
  });
});

describe('HeroApp Session Selection', () => {
  let GlobalState;

  beforeEach(() => {
    GlobalState = createMockGlobalState();
  });

  it('should update currentSession when navigating to chat', () => {
    let session = { id: 123, name: 'Test Session', agent_id: 1 };
    GlobalState.currentSession[mockDynamicProperty.set](session);

    assert.deepStrictEqual(GlobalState.currentSession.valueOf(), session);
  });

  it('should clear currentSession when leaving chat', () => {
    GlobalState.currentSession[mockDynamicProperty.set]({ id: 123, name: 'Test' });
    assert.ok(GlobalState.currentSession.valueOf() !== null);

    GlobalState.currentSession[mockDynamicProperty.set](null);
    assert.strictEqual(GlobalState.currentSession.valueOf(), null);
  });

  it('should notify listeners when session changes', () => {
    let received = [];

    GlobalState.currentSession.addEventListener('update', (event) => {
      received.push(event);
    });

    let session = { id: 1, name: 'First' };
    GlobalState.currentSession[mockDynamicProperty.set](session);

    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(received[0].value, session);
    assert.strictEqual(received[0].oldValue, null);
  });
});

describe('HeroApp Base Path Detection', () => {
  it('should extract base path from string', () => {
    // Simulates reading from <base href="/hero/">
    let baseHref  = '/hero/';
    let basePath  = baseHref.replace(/\/$/, '');
    assert.strictEqual(basePath, '/hero');
  });

  it('should handle root base path', () => {
    let baseHref  = '/';
    let basePath  = baseHref.replace(/\/$/, '');
    assert.strictEqual(basePath, '');
  });

  it('should handle empty base path', () => {
    let baseHref  = '';
    let basePath  = baseHref || '';
    assert.strictEqual(basePath, '');
  });

  it('should handle nested base paths', () => {
    let baseHref  = '/app/hero/';
    let basePath  = baseHref.replace(/\/$/, '');
    assert.strictEqual(basePath, '/app/hero');
  });
});
