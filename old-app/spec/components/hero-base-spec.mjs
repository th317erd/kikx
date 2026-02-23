/**
 * Tests for hero-base.js
 *
 * Tests GlobalState and HeroComponent base class.
 * Uses JSDOM for DOM environment simulation.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// Mock the mythix-ui-core module since we can't load it in Node
const mockDynamicProperty = {
  set: Symbol('DynamicProperty.set'),
};

// Create mock dynamic properties
function createMockDynamicProp(initialValue) {
  let value      = initialValue;
  let listeners  = [];

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
    _getListenerCount() {
      return listeners.length;
    },
  };

  return prop;
}

// Mock Utils.dynamicPropID
const mockUtils = {
  dynamicPropID: (id, defaultValue) => createMockDynamicProp(defaultValue),
};

// Mock MythixUIComponent
class MockMythixUIComponent {
  constructor() {
    // shadow starts undefined until createShadowDOM is called
  }

  static get tagName() {
    return 'mock-component';
  }

  createShadowDOM() {
    this.shadow = { mode: 'open' };
    return this.shadow;
  }
}

describe('GlobalState', () => {
  let GlobalState;

  beforeEach(() => {
    // Create fresh GlobalState for each test
    GlobalState = {
      user:               mockUtils.dynamicPropID('heroUser', null),
      sessions:           mockUtils.dynamicPropID('heroSessions', []),
      agents:             mockUtils.dynamicPropID('heroAgents', []),
      abilities:          mockUtils.dynamicPropID('heroAbilities', { system: [], user: [] }),
      currentSession:     mockUtils.dynamicPropID('heroCurrentSession', null),
      wsConnected:        mockUtils.dynamicPropID('heroWsConnected', false),
      globalSpend:        mockUtils.dynamicPropID('heroGlobalSpend', { cost: 0, inputTokens: 0, outputTokens: 0 }),
      showHiddenSessions: mockUtils.dynamicPropID('heroShowHiddenSessions', false),
    };
  });

  it('should have all expected state keys', () => {
    let expectedKeys = [
      'user',
      'sessions',
      'agents',
      'abilities',
      'currentSession',
      'wsConnected',
      'globalSpend',
      'showHiddenSessions',
    ];

    for (let key of expectedKeys) {
      assert.ok(GlobalState[key], `GlobalState should have ${key}`);
    }
  });

  it('should initialize with default values', () => {
    assert.strictEqual(GlobalState.user.valueOf(), null);
    assert.deepStrictEqual(GlobalState.sessions.valueOf(), []);
    assert.deepStrictEqual(GlobalState.agents.valueOf(), []);
    assert.deepStrictEqual(GlobalState.abilities.valueOf(), { system: [], user: [] });
    assert.strictEqual(GlobalState.currentSession.valueOf(), null);
    assert.strictEqual(GlobalState.wsConnected.valueOf(), false);
    assert.deepStrictEqual(GlobalState.globalSpend.valueOf(), { cost: 0, inputTokens: 0, outputTokens: 0 });
    assert.strictEqual(GlobalState.showHiddenSessions.valueOf(), false);
  });

  it('should update values via DynamicProperty.set', () => {
    let newSessions = [{ id: 1, name: 'Test' }];
    GlobalState.sessions[mockDynamicProperty.set](newSessions);

    assert.deepStrictEqual(GlobalState.sessions.valueOf(), newSessions);
  });

  it('should notify listeners on update', () => {
    let called    = false;
    let received  = null;

    GlobalState.user.addEventListener('update', (event) => {
      called   = true;
      received = event;
    });

    let newUser = { id: 1, username: 'test' };
    GlobalState.user[mockDynamicProperty.set](newUser);

    assert.strictEqual(called, true);
    assert.deepStrictEqual(received.value, newUser);
    assert.strictEqual(received.oldValue, null);
  });

  it('should allow removing listeners', () => {
    let callCount = 0;
    let handler = () => { callCount++; };

    GlobalState.user.addEventListener('update', handler);
    GlobalState.user[mockDynamicProperty.set]({ id: 1 });
    assert.strictEqual(callCount, 1);

    GlobalState.user.removeEventListener('update', handler);
    GlobalState.user[mockDynamicProperty.set]({ id: 2 });
    assert.strictEqual(callCount, 1); // Should not increase
  });
});

describe('HeroComponent', () => {
  let HeroComponent;
  let GlobalState;

  beforeEach(() => {
    // Create fresh GlobalState
    GlobalState = {
      user:               mockUtils.dynamicPropID('heroUser', null),
      sessions:           mockUtils.dynamicPropID('heroSessions', []),
      agents:             mockUtils.dynamicPropID('heroAgents', []),
      abilities:          mockUtils.dynamicPropID('heroAbilities', { system: [], user: [] }),
      currentSession:     mockUtils.dynamicPropID('heroCurrentSession', null),
      wsConnected:        mockUtils.dynamicPropID('heroWsConnected', false),
      globalSpend:        mockUtils.dynamicPropID('heroGlobalSpend', { cost: 0, inputTokens: 0, outputTokens: 0 }),
      showHiddenSessions: mockUtils.dynamicPropID('heroShowHiddenSessions', false),
    };

    // Create HeroComponent class
    HeroComponent = class extends MockMythixUIComponent {
      get global() {
        return GlobalState;
      }

      get user() {
        return GlobalState.user.valueOf();
      }

      get isAuthenticated() {
        return GlobalState.user.valueOf() !== null;
      }

      get currentSession() {
        return GlobalState.currentSession.valueOf();
      }

      createShadowDOM() {
        // Light DOM by default
      }

      setGlobal(key, value) {
        if (GlobalState[key]) {
          GlobalState[key][mockDynamicProperty.set](value);
        }
      }

      subscribeGlobal(key, callback) {
        if (!GlobalState[key]) {
          return () => {};
        }

        let handler = (event) => callback({ value: event.value, oldValue: event.oldValue });
        GlobalState[key].addEventListener('update', handler);
        return () => GlobalState[key].removeEventListener('update', handler);
      }
    };
  });

  it('should provide access to GlobalState via global getter', () => {
    let component = new HeroComponent();
    assert.strictEqual(component.global, GlobalState);
  });

  it('should return null user when not authenticated', () => {
    let component = new HeroComponent();
    assert.strictEqual(component.user, null);
    assert.strictEqual(component.isAuthenticated, false);
  });

  it('should return user when authenticated', () => {
    let user = { id: 1, username: 'test' };
    GlobalState.user[mockDynamicProperty.set](user);

    let component = new HeroComponent();
    assert.deepStrictEqual(component.user, user);
    assert.strictEqual(component.isAuthenticated, true);
  });

  it('should use Light DOM by default', () => {
    let component = new HeroComponent();
    component.createShadowDOM();
    assert.strictEqual(component.shadow, undefined);
  });

  it('should update GlobalState via setGlobal', () => {
    let component   = new HeroComponent();
    let newSessions = [{ id: 1, name: 'Test Session' }];

    component.setGlobal('sessions', newSessions);
    assert.deepStrictEqual(GlobalState.sessions.valueOf(), newSessions);
  });

  it('should subscribe to GlobalState changes', () => {
    let component = new HeroComponent();
    let received  = null;

    let unsubscribe = component.subscribeGlobal('user', (event) => {
      received = event;
    });

    let user = { id: 1, username: 'test' };
    GlobalState.user[mockDynamicProperty.set](user);

    assert.deepStrictEqual(received.value, user);
    assert.strictEqual(received.oldValue, null);

    // Test unsubscribe
    unsubscribe();
    GlobalState.user[mockDynamicProperty.set]({ id: 2 });
    assert.deepStrictEqual(received.value, user); // Should not have changed
  });

  it('should handle subscribing to non-existent key gracefully', () => {
    let component   = new HeroComponent();
    let unsubscribe = component.subscribeGlobal('nonExistent', () => {});

    assert.strictEqual(typeof unsubscribe, 'function');
    // Should not throw when called
    unsubscribe();
  });

  it('should return currentSession from GlobalState', () => {
    let component = new HeroComponent();
    assert.strictEqual(component.currentSession, null);

    let session = { id: 1, name: 'Test' };
    GlobalState.currentSession[mockDynamicProperty.set](session);

    assert.deepStrictEqual(component.currentSession, session);
  });
});

describe('State updates propagation', () => {
  let GlobalState;

  beforeEach(() => {
    GlobalState = {
      sessions: mockUtils.dynamicPropID('heroSessions', []),
    };
  });

  it('should support multiple listeners on same property', () => {
    let calls = [];

    GlobalState.sessions.addEventListener('update', (e) => calls.push(['a', e.value]));
    GlobalState.sessions.addEventListener('update', (e) => calls.push(['b', e.value]));

    let newValue = [{ id: 1 }];
    GlobalState.sessions[mockDynamicProperty.set](newValue);

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0], ['a', newValue]);
    assert.deepStrictEqual(calls[1], ['b', newValue]);
  });

  it('should provide oldValue in update events', () => {
    let history = [];

    GlobalState.sessions.addEventListener('update', (e) => {
      history.push({ old: e.oldValue, new: e.value });
    });

    GlobalState.sessions[mockDynamicProperty.set]([{ id: 1 }]);
    GlobalState.sessions[mockDynamicProperty.set]([{ id: 1 }, { id: 2 }]);

    assert.deepStrictEqual(history[0].old, []);
    assert.deepStrictEqual(history[0].new, [{ id: 1 }]);
    assert.deepStrictEqual(history[1].old, [{ id: 1 }]);
    assert.deepStrictEqual(history[1].new, [{ id: 1 }, { id: 2 }]);
  });
});
