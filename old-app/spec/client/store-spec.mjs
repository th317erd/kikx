'use strict';

// =============================================================================
// Store tests
// =============================================================================
// Tests the Kikx store logic using createStore directly.
// The actual src/client/lib/store.mjs uses a bare `kikx/shared/...` import
// which requires browser-side import maps. To avoid that dependency, we import
// createStore directly and replicate the store definition here.
// =============================================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../../src/shared/lib/create-store.mjs';

// Default values for each scope — matches src/client/lib/store.mjs exactly
const DEFAULTS = {
  sessions:   () => ([]),
  agents:     () => ([]),
  abilities:  () => ({ system: [], user: [] }),
  profile:    () => ({ user: null, authenticated: false, token: null }),
  theme:      () => ({ base: 'black-glass', accent: 'cyan' }),
  connection: () => ({ status: 'disconnected', costs: { global: 0, service: 0, session: 0 } }),
};

function buildStore() {
  let store = createStore({
    sessions: {
      _: DEFAULTS.sessions(),
      addSession({ get, set }, session) { set([...get(), session]); },
      removeSession({ get, set }, sessionID) { set(get().filter((s) => s.id !== sessionID)); },
      updateSession({ get, set }, sessionID, updates) {
        let sessions = get();
        let index = sessions.findIndex((s) => s.id === sessionID);
        if (index < 0) return;
        let updated = sessions.slice();
        updated[index] = { ...sessions[index], ...updates };
        set(updated);
      },
      getSession({ get }, sessionID) { return get().find((s) => s.id === sessionID) ?? null; },
      getActiveSession({ get }) { return get().find((s) => s.active === true) ?? null; },
      setActiveSession({ get, set }, sessionID) {
        set(get().map((s) => ({ ...s, active: s.id === sessionID })));
      },
      getAllSessions({ get }) { return get(); },
    },
    agents: {
      _: DEFAULTS.agents(),
      addAgent({ get, set }, agent) { set([...get(), agent]); },
      removeAgent({ get, set }, agentID) { set(get().filter((a) => a.id !== agentID)); },
      updateAgent({ get, set }, agentID, updates) {
        let agents = get();
        let index = agents.findIndex((a) => a.id === agentID);
        if (index < 0) return;
        let updated = agents.slice();
        updated[index] = { ...agents[index], ...updates };
        set(updated);
      },
      getAgent({ get }, agentID) { return get().find((a) => a.id === agentID) ?? null; },
      getAllAgents({ get }) { return get(); },
    },
    abilities: {
      _: DEFAULTS.abilities(),
      addAbility({ get, set }, ability, category = 'user') {
        let current = get();
        let categoryList = current[category] ?? [];
        set({ ...current, [category]: [...categoryList, ability] });
      },
      removeAbility({ get, set }, abilityID) {
        let current = get();
        set({
          system: current.system.filter((a) => a.id !== abilityID),
          user:   current.user.filter((a) => a.id !== abilityID),
        });
      },
      updateAbility({ get, set }, abilityID, updates) {
        let current = get();
        let updateInList = (list) => {
          let index = list.findIndex((a) => a.id === abilityID);
          if (index < 0) return list;
          let updated = list.slice();
          updated[index] = { ...list[index], ...updates };
          return updated;
        };
        set({ system: updateInList(current.system), user: updateInList(current.user) });
      },
      getAbility({ get }, abilityID) {
        let current = get();
        return current.system.find((a) => a.id === abilityID)
          ?? current.user.find((a) => a.id === abilityID)
          ?? null;
      },
      getSystemAbilities({ get }) { return get().system; },
      getUserAbilities({ get }) { return get().user; },
    },
    profile: {
      _: DEFAULTS.profile(),
      setUser({ get, set }, user, token) { set({ ...get(), user, token, authenticated: true }); },
      getUser({ get }) { return get().user; },
      updateUser({ get, set }, updates) {
        let current = get();
        if (!current.user) return;
        set({ ...current, user: { ...current.user, ...updates } });
      },
      isAuthenticated({ get }) { return get().authenticated; },
      logout({ set }) { set({ user: null, authenticated: false, token: null }); },
    },
    theme: {
      _: DEFAULTS.theme(),
      setBase({ get, set }, base) { set({ ...get(), base }); },
      setAccent({ get, set }, accent) { set({ ...get(), accent }); },
      getBase({ get }) { return get().base; },
      getAccent({ get }) { return get().accent; },
    },
    connection: {
      _: DEFAULTS.connection(),
      setStatus({ get, set }, status) { set({ ...get(), status }); },
      updateCosts({ get, set }, costs) {
        let current = get();
        set({ ...current, costs: { ...current.costs, ...costs } });
      },
      getStatus({ get }) { return get().status; },
      getCosts({ get }) { return get().costs; },
    },
  });

  store.resetStore = () => {
    store.hydrate({
      sessions:   DEFAULTS.sessions(),
      agents:     DEFAULTS.agents(),
      abilities:  DEFAULTS.abilities(),
      profile:    DEFAULTS.profile(),
      theme:      DEFAULTS.theme(),
      connection: DEFAULTS.connection(),
    });
  };

  return store;
}

let store;

beforeEach(() => {
  store = buildStore();
});

// =============================================================================
// Sessions scope
// =============================================================================

describe('Store: sessions scope', { timeout: 5000 }, () => {
  it('should start with empty sessions array', () => {
    assert.deepStrictEqual(store.sessions.getAllSessions(), []);
  });

  it('should add a session', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Test Session' });
    let sessions = store.sessions.getAllSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'ses_1');
    assert.equal(sessions[0].name, 'Test Session');
  });

  it('should add multiple sessions', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'First' });
    store.sessions.addSession({ id: 'ses_2', name: 'Second' });
    assert.equal(store.sessions.getAllSessions().length, 2);
  });

  it('should remove a session by ID', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Keep' });
    store.sessions.addSession({ id: 'ses_2', name: 'Remove' });
    store.sessions.removeSession('ses_2');

    let sessions = store.sessions.getAllSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'ses_1');
  });

  it('should not error when removing a non-existent session', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Only' });
    assert.doesNotThrow(() => store.sessions.removeSession('ses_nonexistent'));
    assert.equal(store.sessions.getAllSessions().length, 1);
  });

  it('should update a session by ID', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Old Name' });
    store.sessions.updateSession('ses_1', { name: 'New Name' });

    let session = store.sessions.getSession('ses_1');
    assert.equal(session.name, 'New Name');
  });

  it('should not mutate other sessions when updating', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'First' });
    store.sessions.addSession({ id: 'ses_2', name: 'Second' });
    store.sessions.updateSession('ses_1', { name: 'Updated First' });

    assert.equal(store.sessions.getSession('ses_2').name, 'Second');
  });

  it('should silently ignore updates to non-existent session', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Only' });
    assert.doesNotThrow(() => store.sessions.updateSession('ses_missing', { name: 'Nope' }));
    assert.equal(store.sessions.getAllSessions().length, 1);
  });

  it('should get a session by ID', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Target' });
    let session = store.sessions.getSession('ses_1');
    assert.equal(session.name, 'Target');
  });

  it('should return null for non-existent session', () => {
    assert.equal(store.sessions.getSession('ses_missing'), null);
  });

  it('should get active session', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Inactive', active: false });
    store.sessions.addSession({ id: 'ses_2', name: 'Active', active: true });

    let active = store.sessions.getActiveSession();
    assert.equal(active.id, 'ses_2');
  });

  it('should return null when no active session', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Inactive', active: false });
    assert.equal(store.sessions.getActiveSession(), null);
  });

  it('should set active session and deactivate others', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'First', active: true });
    store.sessions.addSession({ id: 'ses_2', name: 'Second', active: false });

    store.sessions.setActiveSession('ses_2');

    assert.equal(store.sessions.getSession('ses_1').active, false);
    assert.equal(store.sessions.getSession('ses_2').active, true);
  });
});

// =============================================================================
// Agents scope
// =============================================================================

describe('Store: agents scope', { timeout: 5000 }, () => {
  it('should start with empty agents array', () => {
    assert.deepStrictEqual(store.agents.getAllAgents(), []);
  });

  it('should add an agent', () => {
    store.agents.addAgent({ id: 'agt_1', name: 'Claude' });
    assert.equal(store.agents.getAllAgents().length, 1);
    assert.equal(store.agents.getAgent('agt_1').name, 'Claude');
  });

  it('should remove an agent by ID', () => {
    store.agents.addAgent({ id: 'agt_1', name: 'Keep' });
    store.agents.addAgent({ id: 'agt_2', name: 'Remove' });
    store.agents.removeAgent('agt_2');

    assert.equal(store.agents.getAllAgents().length, 1);
    assert.equal(store.agents.getAgent('agt_2'), null);
  });

  it('should update an agent by ID', () => {
    store.agents.addAgent({ id: 'agt_1', name: 'Old', model: 'gpt-4' });
    store.agents.updateAgent('agt_1', { model: 'claude-3' });

    let agent = store.agents.getAgent('agt_1');
    assert.equal(agent.model, 'claude-3');
    assert.equal(agent.name, 'Old');
  });

  it('should silently ignore updates to non-existent agent', () => {
    assert.doesNotThrow(() => store.agents.updateAgent('agt_missing', { name: 'Nope' }));
  });

  it('should return null for non-existent agent', () => {
    assert.equal(store.agents.getAgent('agt_missing'), null);
  });
});

// =============================================================================
// Abilities scope
// =============================================================================

describe('Store: abilities scope', { timeout: 5000 }, () => {
  it('should start with empty system and user arrays', () => {
    assert.deepStrictEqual(store.abilities.getSystemAbilities(), []);
    assert.deepStrictEqual(store.abilities.getUserAbilities(), []);
  });

  it('should add ability to user category by default', () => {
    store.abilities.addAbility({ id: 'abl_1', name: 'Test Ability' });
    assert.equal(store.abilities.getUserAbilities().length, 1);
    assert.equal(store.abilities.getSystemAbilities().length, 0);
  });

  it('should add ability to system category', () => {
    store.abilities.addAbility({ id: 'abl_1', name: 'System' }, 'system');
    assert.equal(store.abilities.getSystemAbilities().length, 1);
    assert.equal(store.abilities.getUserAbilities().length, 0);
  });

  it('should get ability by ID across categories', () => {
    store.abilities.addAbility({ id: 'abl_sys', name: 'System' }, 'system');
    store.abilities.addAbility({ id: 'abl_usr', name: 'User' }, 'user');

    assert.equal(store.abilities.getAbility('abl_sys').name, 'System');
    assert.equal(store.abilities.getAbility('abl_usr').name, 'User');
  });

  it('should return null for non-existent ability', () => {
    assert.equal(store.abilities.getAbility('abl_missing'), null);
  });

  it('should remove ability from any category', () => {
    store.abilities.addAbility({ id: 'abl_1', name: 'System' }, 'system');
    store.abilities.addAbility({ id: 'abl_2', name: 'User' }, 'user');

    store.abilities.removeAbility('abl_1');
    assert.equal(store.abilities.getSystemAbilities().length, 0);
    assert.equal(store.abilities.getUserAbilities().length, 1);
  });

  it('should update ability across categories', () => {
    store.abilities.addAbility({ id: 'abl_1', name: 'Old Name' }, 'system');
    store.abilities.updateAbility('abl_1', { name: 'New Name' });

    assert.equal(store.abilities.getAbility('abl_1').name, 'New Name');
  });

  it('should silently ignore updates to non-existent ability', () => {
    assert.doesNotThrow(() => store.abilities.updateAbility('abl_missing', { name: 'Nope' }));
  });
});

// =============================================================================
// Profile scope
// =============================================================================

describe('Store: profile scope', { timeout: 5000 }, () => {
  it('should start unauthenticated with null user', () => {
    assert.equal(store.profile.getUser(), null);
    assert.equal(store.profile.isAuthenticated(), false);
  });

  it('should set user and mark as authenticated', () => {
    store.profile.setUser({ id: '1', email: 'test@test.com' }, 'token123');
    assert.equal(store.profile.isAuthenticated(), true);
    assert.equal(store.profile.getUser().email, 'test@test.com');
  });

  it('should update user properties', () => {
    store.profile.setUser({ firstName: 'Old', lastName: 'Name' }, 'tok');
    store.profile.updateUser({ firstName: 'New' });

    let user = store.profile.getUser();
    assert.equal(user.firstName, 'New');
    assert.equal(user.lastName, 'Name');
  });

  it('should do nothing on updateUser if no user set', () => {
    store.profile.updateUser({ firstName: 'New' });
    assert.equal(store.profile.getUser(), null);
  });

  it('should logout and clear user state', () => {
    store.profile.setUser({ id: '1' }, 'token');
    assert.equal(store.profile.isAuthenticated(), true);

    store.profile.logout();
    assert.equal(store.profile.isAuthenticated(), false);
    assert.equal(store.profile.getUser(), null);
  });
});

// =============================================================================
// Theme scope
// =============================================================================

describe('Store: theme scope', { timeout: 5000 }, () => {
  it('should have default theme values', () => {
    assert.equal(store.theme.getBase(), 'black-glass');
    assert.equal(store.theme.getAccent(), 'cyan');
  });

  it('should set base theme', () => {
    store.theme.setBase('dark-blue');
    assert.equal(store.theme.getBase(), 'dark-blue');
  });

  it('should set accent color', () => {
    store.theme.setAccent('purple');
    assert.equal(store.theme.getAccent(), 'purple');
  });

  it('should preserve other theme values when setting base', () => {
    store.theme.setAccent('red');
    store.theme.setBase('midnight');
    assert.equal(store.theme.getAccent(), 'red');
  });
});

// =============================================================================
// Connection scope
// =============================================================================

describe('Store: connection scope', { timeout: 5000 }, () => {
  it('should start with disconnected status', () => {
    assert.equal(store.connection.getStatus(), 'disconnected');
  });

  it('should start with zero costs', () => {
    let costs = store.connection.getCosts();
    assert.equal(costs.global, 0);
    assert.equal(costs.service, 0);
    assert.equal(costs.session, 0);
  });

  it('should set connection status', () => {
    store.connection.setStatus('connected');
    assert.equal(store.connection.getStatus(), 'connected');
  });

  it('should update costs partially', () => {
    store.connection.updateCosts({ global: 1.50 });
    let costs = store.connection.getCosts();
    assert.equal(costs.global, 1.50);
    assert.equal(costs.service, 0);
    assert.equal(costs.session, 0);
  });

  it('should update costs cumulatively', () => {
    store.connection.updateCosts({ global: 1.00 });
    store.connection.updateCosts({ service: 0.50, session: 0.25 });

    let costs = store.connection.getCosts();
    assert.equal(costs.global, 1.00);
    assert.equal(costs.service, 0.50);
    assert.equal(costs.session, 0.25);
  });
});

// =============================================================================
// Store: resetStore (hydrate)
// =============================================================================

describe('Store: resetStore', { timeout: 5000 }, () => {
  it('should reset all scopes to defaults', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Session' });
    store.agents.addAgent({ id: 'agt_1', name: 'Agent' });
    store.abilities.addAbility({ id: 'abl_1', name: 'Ability' });
    store.profile.setUser({ id: '1' }, 'token');
    store.theme.setBase('custom');
    store.connection.setStatus('connected');
    store.connection.updateCosts({ global: 5 });

    store.resetStore();

    assert.deepStrictEqual(store.sessions.getAllSessions(), []);
    assert.deepStrictEqual(store.agents.getAllAgents(), []);
    assert.deepStrictEqual(store.abilities.getSystemAbilities(), []);
    assert.deepStrictEqual(store.abilities.getUserAbilities(), []);
    assert.equal(store.profile.getUser(), null);
    assert.equal(store.profile.isAuthenticated(), false);
    assert.equal(store.theme.getBase(), 'black-glass');
    assert.equal(store.theme.getAccent(), 'cyan');
    assert.equal(store.connection.getStatus(), 'disconnected');
    assert.equal(store.connection.getCosts().global, 0);
  });
});

// =============================================================================
// Store: event emission (microtask batching)
// =============================================================================

describe('Store: event emission', { timeout: 5000 }, () => {
  it('should emit update event on session add', async () => {
    let updated = false;
    store.on('update', () => { updated = true; });

    store.sessions.addSession({ id: 'ses_1', name: 'Test' });

    // Events are async via microtask
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(updated, 'update event should have fired');
  });

  it('should emit update event on profile change', async () => {
    let updated = false;
    store.on('update', () => { updated = true; });

    store.profile.setUser({ id: '1' }, 'token');

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(updated, 'update event should have fired');
  });

  it('should batch multiple rapid updates into one event', async () => {
    let callCount = 0;
    store.on('update', () => { callCount++; });

    store.sessions.addSession({ id: 'ses_1', name: 'First' });
    store.sessions.addSession({ id: 'ses_2', name: 'Second' });
    store.agents.addAgent({ id: 'agt_1', name: 'Agent' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callCount, 1, 'Multiple sync updates should batch into one event');
  });

  it('should report modified scopes in update event', async () => {
    let modified = null;
    store.on('update', (data) => { modified = data.modified; });

    store.sessions.addSession({ id: 'ses_1', name: 'Test' });
    store.profile.setUser({ id: '1' }, 'token');

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(modified.includes('sessions'));
    assert.ok(modified.includes('profile'));
  });

  it('should allow unsubscribing from events', async () => {
    let callCount = 0;
    let listener = () => { callCount++; };
    store.on('update', listener);

    store.sessions.addSession({ id: 'ses_1', name: 'First' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callCount, 1);

    store.off('update', listener);
    store.sessions.addSession({ id: 'ses_2', name: 'Second' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callCount, 1, 'Should not fire after unsubscribe');
  });
});

// =============================================================================
// createStore: getState
// =============================================================================

describe('Store: getState', { timeout: 5000 }, () => {
  it('should return a snapshot of all scopes', () => {
    store.sessions.addSession({ id: 'ses_1', name: 'Test' });
    let state = store.getState();

    assert.ok(Array.isArray(state.sessions));
    assert.equal(state.sessions.length, 1);
    assert.ok(state.profile);
    assert.ok(state.theme);
    assert.ok(state.connection);
  });

  it('should return a copy that does not affect the store', () => {
    let state = store.getState();
    state.sessions = 'mutated';

    assert.deepStrictEqual(store.sessions.getAllSessions(), []);
  });
});
