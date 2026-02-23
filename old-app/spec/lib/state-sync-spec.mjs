'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

/**
 * State Sync Tests
 *
 * Tests the bidirectional sync between state.* (Proxy) and GlobalState (setGlobal).
 *
 * The actual logic lives in:
 *   - public/js/state.js (Proxy set trap → calls window.setGlobal)
 *   - public/js/components/index.js (setGlobal → writes window.state)
 *
 * We recreate both mechanisms here to test the sync contract in isolation,
 * without needing MythixUI or jsdom.
 */

const SYNCED_KEYS = new Set([
  'user', 'sessions', 'agents', 'abilities',
  'currentSession', 'globalSpend', 'serviceSpend', 'sessionSpend',
]);

/**
 * Build a state Proxy matching state.js behavior.
 */
function createStateProxy(backing, win) {
  return new Proxy(backing, {
    set(target, key, value) {
      target[key] = value;

      if (SYNCED_KEYS.has(key) && !win.__stateSyncing && typeof win.setGlobal === 'function') {
        win.__stateSyncing = true;
        try {
          win.setGlobal(key, value);
        } finally {
          win.__stateSyncing = false;
        }
      }

      return true;
    },
  });
}

/**
 * Build a setGlobal function matching components/index.js behavior.
 * Uses `gsStore` as a stand-in for GlobalState + DynamicProperty.
 */
function createSetGlobal(gsStore, stateProxy, win) {
  return (key, value) => {
    if (gsStore[key] !== undefined) {
      gsStore[key] = value;

      // Reverse-sync to state
      if (SYNCED_KEYS.has(key) && !win.__stateSyncing && stateProxy) {
        win.__stateSyncing = true;
        try {
          stateProxy[key] = value;
        } finally {
          win.__stateSyncing = false;
        }
      }
    }
  };
}

describe('state-sync', () => {
  let win;        // Simulated window
  let backing;    // Raw state object
  let state;      // Proxied state
  let gsStore;    // Simulated GlobalState store

  beforeEach(() => {
    win = { __stateSyncing: false };

    backing = {
      user: null,
      sessions: [],
      agents: [],
      abilities: { system: [], user: [] },
      currentSession: null,
      isLoading: false,
      globalSpend: { cost: 0 },
      serviceSpend: { cost: 0 },
      sessionSpend: { cost: 0 },
    };

    // GlobalState stand-in (all synced keys + some extras)
    gsStore = {
      user: null,
      sessions: [],
      agents: [],
      abilities: { system: [], user: [] },
      currentSession: null,
      globalSpend: { cost: 0 },
      serviceSpend: { cost: 0 },
      sessionSpend: { cost: 0 },
    };

    state = createStateProxy(backing, win);
    win.setGlobal = createSetGlobal(gsStore, state, win);
  });

  afterEach(() => {
    win = null;
    backing = null;
    state = null;
    gsStore = null;
  });

  // ===========================================================================
  // state.* → GlobalState sync (Proxy → setGlobal)
  // ===========================================================================
  describe('state.* → GlobalState sync', () => {
    it('should forward synced key writes to GlobalState', () => {
      let agents = [{ id: 1, name: 'test-agent' }];
      state.agents = agents;

      assert.strictEqual(gsStore.agents, agents);
    });

    it('should sync all 8 synced keys', () => {
      let user = { id: 1, username: 'claude' };
      let sessions = [{ id: 1 }];
      let agents = [{ id: 2 }];
      let abilities = { system: ['a'], user: ['b'] };
      let currentSession = { id: 3 };
      let globalSpend = { cost: 1.5 };
      let serviceSpend = { cost: 0.5 };
      let sessionSpend = { cost: 0.2 };

      state.user = user;
      state.sessions = sessions;
      state.agents = agents;
      state.abilities = abilities;
      state.currentSession = currentSession;
      state.globalSpend = globalSpend;
      state.serviceSpend = serviceSpend;
      state.sessionSpend = sessionSpend;

      assert.strictEqual(gsStore.user, user);
      assert.strictEqual(gsStore.sessions, sessions);
      assert.strictEqual(gsStore.agents, agents);
      assert.strictEqual(gsStore.abilities, abilities);
      assert.strictEqual(gsStore.currentSession, currentSession);
      assert.strictEqual(gsStore.globalSpend, globalSpend);
      assert.strictEqual(gsStore.serviceSpend, serviceSpend);
      assert.strictEqual(gsStore.sessionSpend, sessionSpend);
    });

    it('should NOT forward non-synced keys to GlobalState', () => {
      state.isLoading = true;

      // isLoading is not in SYNCED_KEYS, so gsStore shouldn't have it
      assert.strictEqual(gsStore.isLoading, undefined);
      // But the backing store should have it
      assert.strictEqual(backing.isLoading, true);
    });

    it('should always write to the backing object regardless of sync', () => {
      state.isLoading = true;
      state.agents = [{ id: 1 }];

      assert.strictEqual(backing.isLoading, true);
      assert.deepStrictEqual(backing.agents, [{ id: 1 }]);
    });
  });

  // ===========================================================================
  // GlobalState → state.* sync (setGlobal → Proxy)
  // ===========================================================================
  describe('GlobalState → state.* sync', () => {
    it('should reverse-sync setGlobal writes to state.*', () => {
      let sessions = [{ id: 10 }, { id: 20 }];
      win.setGlobal('sessions', sessions);

      assert.strictEqual(backing.sessions, sessions);
    });

    it('should reverse-sync all synced keys', () => {
      win.setGlobal('user', { id: 5 });
      win.setGlobal('currentSession', { id: 99 });

      assert.deepStrictEqual(backing.user, { id: 5 });
      assert.deepStrictEqual(backing.currentSession, { id: 99 });
    });

    it('should ignore unknown keys in setGlobal', () => {
      // setGlobal should only write keys that exist in gsStore
      win.setGlobal('nonExistentKey', 'value');

      assert.strictEqual(backing.nonExistentKey, undefined);
    });
  });

  // ===========================================================================
  // Recursion prevention
  // ===========================================================================
  describe('recursion prevention', () => {
    it('should not infinitely recurse between state and setGlobal', () => {
      // If the re-entry guard fails, this would stack overflow
      state.sessions = [{ id: 1 }];

      assert.strictEqual(gsStore.sessions, backing.sessions);
      assert.strictEqual(win.__stateSyncing, false);
    });

    it('should not re-enter when setGlobal triggers state write', () => {
      let callCount = 0;
      let originalSetGlobal = win.setGlobal;

      win.setGlobal = (key, value) => {
        callCount++;
        originalSetGlobal(key, value);
      };

      state.agents = [{ id: 1 }];

      // setGlobal should be called exactly once (not recursively)
      assert.strictEqual(callCount, 1);
    });

    it('should clear the syncing flag even if setGlobal throws', () => {
      win.setGlobal = () => {
        throw new Error('boom');
      };

      assert.throws(() => {
        state.sessions = [];
      });

      // Flag should be cleared by finally block
      assert.strictEqual(win.__stateSyncing, false);
    });
  });

  // ===========================================================================
  // Nested property replacement (mutation pattern fix)
  // ===========================================================================
  describe('nested property replacement', () => {
    it('should detect object replacement for spend keys', () => {
      // Simulates the fixed mutation pattern from streaming.js:
      //   state.sessionSpend = { cost: state.sessionSpend.cost + 0.5 }
      state.sessionSpend = { cost: backing.sessionSpend.cost + 0.5 };

      assert.deepStrictEqual(gsStore.sessionSpend, { cost: 0.5 });
      assert.deepStrictEqual(backing.sessionSpend, { cost: 0.5 });
    });

    it('should NOT detect nested property mutation (Proxy limitation)', () => {
      // This is the pattern we FIXED - direct nested mutation is NOT detected
      // by the Proxy set trap. This test documents the limitation.
      let original = gsStore.sessionSpend;
      backing.sessionSpend.cost += 0.5;

      // gsStore was NOT updated because Proxy.set was never triggered
      assert.strictEqual(gsStore.sessionSpend, original);
    });
  });

  // ===========================================================================
  // Early writes (before setGlobal is available)
  // ===========================================================================
  describe('early writes', () => {
    it('should not throw when setGlobal is not yet defined', () => {
      // Simulate state.js loaded before components/index.js
      let earlyWin = { __stateSyncing: false };
      let earlyBacking = { sessions: [] };
      let earlyState = createStateProxy(earlyBacking, earlyWin);

      // No setGlobal on earlyWin - should not throw
      assert.doesNotThrow(() => {
        earlyState.sessions = [{ id: 1 }];
      });

      // Value should still be written to backing
      assert.deepStrictEqual(earlyBacking.sessions, [{ id: 1 }]);
    });

    it('should start syncing once setGlobal becomes available', () => {
      let earlyWin = { __stateSyncing: false };
      let earlyBacking = { sessions: [], agents: [] };
      let earlyGsStore = { sessions: [], agents: [] };
      let earlyState = createStateProxy(earlyBacking, earlyWin);

      // Write before setGlobal exists
      earlyState.sessions = [{ id: 1 }];
      assert.deepStrictEqual(earlyGsStore.sessions, []); // Not synced

      // Now install setGlobal
      earlyWin.setGlobal = createSetGlobal(earlyGsStore, earlyState, earlyWin);

      // Write after setGlobal exists
      earlyState.agents = [{ id: 2 }];
      assert.deepStrictEqual(earlyGsStore.agents, [{ id: 2 }]); // Synced!
    });
  });
});
