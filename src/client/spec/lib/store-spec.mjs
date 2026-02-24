'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Import the store module under test.  The spec runner executes under Node.js
// where the browser importmap is not available, but seqda is installed in the
// project's node_modules so the bare-specifier import inside store.mjs will
// resolve correctly via Node's normal module resolution.
import store, {
  resetStore,
  sessions,
  agents,
  abilities,
  profile,
  theme,
  connection,
} from '../../lib/store.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForUpdate() {
  // seqda batches update events on the next microtask; returning a resolved
  // promise lets callers await that tick before asserting.
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('store', () => {
  beforeEach(() => {
    resetStore();
  });

  // ---------------------------------------------------------------- sessions
  describe('sessions scope', () => {
    it('default sessions is an empty array', () => {
      assert.deepEqual(sessions.getAllSessions(), []);
    });

    it('addSession() appends a session to the list', () => {
      sessions.addSession({ id: 's1', name: 'Session 1' });
      const all = sessions.getAllSessions();
      assert.equal(all.length, 1);
      assert.equal(all[0].id, 's1');
    });

    it('removeSession() removes a session by ID', () => {
      sessions.addSession({ id: 's1', name: 'Session 1' });
      sessions.addSession({ id: 's2', name: 'Session 2' });
      sessions.removeSession('s1');
      const all = sessions.getAllSessions();
      assert.equal(all.length, 1);
      assert.equal(all[0].id, 's2');
    });

    it('updateSession() merges updates into the matching session', () => {
      sessions.addSession({ id: 's1', name: 'Original', status: 'idle' });
      sessions.updateSession('s1', { name: 'Updated' });
      const session = sessions.getSession('s1');
      assert.equal(session.name, 'Updated');
      assert.equal(session.status, 'idle');
    });

    it('getSession() returns the session with the given ID', () => {
      sessions.addSession({ id: 's1', name: 'Session 1' });
      sessions.addSession({ id: 's2', name: 'Session 2' });
      const found = sessions.getSession('s2');
      assert.equal(found.id, 's2');
    });

    it('getSession() returns null when the ID does not exist', () => {
      assert.equal(sessions.getSession('missing'), null);
    });

    it('setActiveSession() marks the matching session as active', () => {
      sessions.addSession({ id: 's1', name: 'Session 1' });
      sessions.addSession({ id: 's2', name: 'Session 2' });
      sessions.setActiveSession('s1');
      const active = sessions.getActiveSession();
      assert.equal(active.id, 's1');
    });

    it('setActiveSession() clears the active flag from previously active sessions', () => {
      sessions.addSession({ id: 's1', name: 'Session 1' });
      sessions.addSession({ id: 's2', name: 'Session 2' });
      sessions.setActiveSession('s1');
      sessions.setActiveSession('s2');
      const active = sessions.getActiveSession();
      assert.equal(active.id, 's2');

      const s1 = sessions.getSession('s1');
      assert.equal(s1.active, false);
    });

    it('getActiveSession() returns null when no session is active', () => {
      sessions.addSession({ id: 's1', name: 'Session 1' });
      assert.equal(sessions.getActiveSession(), null);
    });

    it('getAllSessions() returns every session', () => {
      sessions.addSession({ id: 's1' });
      sessions.addSession({ id: 's2' });
      sessions.addSession({ id: 's3' });
      assert.equal(sessions.getAllSessions().length, 3);
    });
  });

  // ------------------------------------------------------------------ agents
  describe('agents scope', () => {
    it('default agents is an empty array', () => {
      assert.deepEqual(agents.getAllAgents(), []);
    });

    it('addAgent() appends an agent', () => {
      agents.addAgent({ id: 'a1', name: 'Agent 1' });
      assert.equal(agents.getAllAgents().length, 1);
    });

    it('removeAgent() removes the agent with the given ID', () => {
      agents.addAgent({ id: 'a1', name: 'Agent 1' });
      agents.addAgent({ id: 'a2', name: 'Agent 2' });
      agents.removeAgent('a1');
      const all = agents.getAllAgents();
      assert.equal(all.length, 1);
      assert.equal(all[0].id, 'a2');
    });

    it('updateAgent() merges updates into the matching agent', () => {
      agents.addAgent({ id: 'a1', name: 'Original', model: 'gpt-4' });
      agents.updateAgent('a1', { name: 'Updated' });
      const agent = agents.getAgent('a1');
      assert.equal(agent.name, 'Updated');
      assert.equal(agent.model, 'gpt-4');
    });

    it('getAgent() returns the agent with the given ID', () => {
      agents.addAgent({ id: 'a1', name: 'Agent 1' });
      const found = agents.getAgent('a1');
      assert.equal(found.id, 'a1');
    });

    it('getAgent() returns null when the ID does not exist', () => {
      assert.equal(agents.getAgent('missing'), null);
    });

    it('getAllAgents() returns every agent', () => {
      agents.addAgent({ id: 'a1' });
      agents.addAgent({ id: 'a2' });
      assert.equal(agents.getAllAgents().length, 2);
    });
  });

  // --------------------------------------------------------------- abilities
  describe('abilities scope', () => {
    it('default abilities has empty system and user arrays', () => {
      assert.deepEqual(abilities.getSystemAbilities(), []);
      assert.deepEqual(abilities.getUserAbilities(), []);
    });

    it('addAbility() with "system" category adds to the system list', () => {
      abilities.addAbility({ id: 'ab1', name: 'Websearch' }, 'system');
      assert.equal(abilities.getSystemAbilities().length, 1);
      assert.equal(abilities.getUserAbilities().length, 0);
    });

    it('addAbility() with "user" category adds to the user list', () => {
      abilities.addAbility({ id: 'ab2', name: 'Custom' }, 'user');
      assert.equal(abilities.getUserAbilities().length, 1);
      assert.equal(abilities.getSystemAbilities().length, 0);
    });

    it('addAbility() defaults to "user" category when none is specified', () => {
      abilities.addAbility({ id: 'ab3', name: 'Default' });
      assert.equal(abilities.getUserAbilities().length, 1);
    });

    it('removeAbility() removes the ability from whichever list it is in', () => {
      abilities.addAbility({ id: 'ab1', name: 'System Ability' }, 'system');
      abilities.addAbility({ id: 'ab2', name: 'User Ability' }, 'user');
      abilities.removeAbility('ab1');
      assert.equal(abilities.getSystemAbilities().length, 0);
      assert.equal(abilities.getUserAbilities().length, 1);
    });

    it('updateAbility() merges updates into the matching ability', () => {
      abilities.addAbility({ id: 'ab1', name: 'Original', enabled: false }, 'system');
      abilities.updateAbility('ab1', { name: 'Updated', enabled: true });
      const found = abilities.getAbility('ab1');
      assert.equal(found.name, 'Updated');
      assert.equal(found.enabled, true);
    });

    it('getAbility() finds an ability from the system list', () => {
      abilities.addAbility({ id: 'ab1', name: 'Sys' }, 'system');
      const found = abilities.getAbility('ab1');
      assert.equal(found.id, 'ab1');
    });

    it('getAbility() finds an ability from the user list', () => {
      abilities.addAbility({ id: 'ab2', name: 'Usr' }, 'user');
      const found = abilities.getAbility('ab2');
      assert.equal(found.id, 'ab2');
    });

    it('getAbility() returns null when the ID does not exist', () => {
      assert.equal(abilities.getAbility('missing'), null);
    });

    it('getSystemAbilities() returns only system abilities', () => {
      abilities.addAbility({ id: 'ab1' }, 'system');
      abilities.addAbility({ id: 'ab2' }, 'user');
      const sys = abilities.getSystemAbilities();
      assert.equal(sys.length, 1);
      assert.equal(sys[0].id, 'ab1');
    });

    it('getUserAbilities() returns only user abilities', () => {
      abilities.addAbility({ id: 'ab1' }, 'system');
      abilities.addAbility({ id: 'ab2' }, 'user');
      const usr = abilities.getUserAbilities();
      assert.equal(usr.length, 1);
      assert.equal(usr[0].id, 'ab2');
    });
  });

  // ----------------------------------------------------------------- profile
  describe('profile scope', () => {
    it('default profile is not authenticated', () => {
      assert.equal(profile.isAuthenticated(), false);
    });

    it('default profile user is null', () => {
      assert.equal(profile.getUser(), null);
    });

    it('setUser() sets the user and token and marks authenticated as true', () => {
      profile.setUser({ id: 'u1', name: 'Alice' }, 'tok-abc');
      assert.equal(profile.isAuthenticated(), true);
      assert.deepEqual(profile.getUser(), { id: 'u1', name: 'Alice' });
    });

    it('isAuthenticated() returns true after setUser()', () => {
      profile.setUser({ id: 'u1' }, 'tok-abc');
      assert.equal(profile.isAuthenticated(), true);
    });

    it('isAuthenticated() returns false before setUser()', () => {
      assert.equal(profile.isAuthenticated(), false);
    });

    it('logout() clears the user and token and sets authenticated to false', () => {
      profile.setUser({ id: 'u1', name: 'Alice' }, 'tok-abc');
      profile.logout();
      assert.equal(profile.isAuthenticated(), false);
      assert.equal(profile.getUser(), null);
    });
  });

  // ------------------------------------------------------------------- theme
  describe('theme scope', () => {
    it('default base is "black-glass"', () => {
      assert.equal(theme.getBase(), 'black-glass');
    });

    it('default accent is "cyan"', () => {
      assert.equal(theme.getAccent(), 'cyan');
    });

    it('setBase() updates the base theme', () => {
      theme.setBase('dark-matter');
      assert.equal(theme.getBase(), 'dark-matter');
    });

    it('setAccent() updates the accent colour', () => {
      theme.setAccent('amber');
      assert.equal(theme.getAccent(), 'amber');
    });

    it('setBase() does not affect the accent', () => {
      theme.setBase('midnight');
      assert.equal(theme.getAccent(), 'cyan');
    });

    it('setAccent() does not affect the base', () => {
      theme.setAccent('rose');
      assert.equal(theme.getBase(), 'black-glass');
    });

    it('getBase() returns the current base value', () => {
      theme.setBase('glass');
      assert.equal(theme.getBase(), 'glass');
    });

    it('getAccent() returns the current accent value', () => {
      theme.setAccent('emerald');
      assert.equal(theme.getAccent(), 'emerald');
    });
  });

  // -------------------------------------------------------------- connection
  describe('connection scope', () => {
    it('default status is "disconnected"', () => {
      assert.equal(connection.getStatus(), 'disconnected');
    });

    it('default costs are all zero', () => {
      assert.deepEqual(connection.getCosts(), { global: 0, service: 0, session: 0 });
    });

    it('setStatus() updates the connection status', () => {
      connection.setStatus('connected');
      assert.equal(connection.getStatus(), 'connected');
    });

    it('setStatus() to "connecting" is reflected by getStatus()', () => {
      connection.setStatus('connecting');
      assert.equal(connection.getStatus(), 'connecting');
    });

    it('updateCosts() merges the provided cost values', () => {
      connection.updateCosts({ global: 1.5, session: 0.75 });
      const costs = connection.getCosts();
      assert.equal(costs.global, 1.5);
      assert.equal(costs.service, 0);
      assert.equal(costs.session, 0.75);
    });

    it('updateCosts() preserves existing cost keys not included in the update', () => {
      connection.updateCosts({ global: 2 });
      connection.updateCosts({ service: 3 });
      const costs = connection.getCosts();
      assert.equal(costs.global, 2);
      assert.equal(costs.service, 3);
    });

    it('getCosts() returns the full costs object', () => {
      connection.updateCosts({ global: 10, service: 5, session: 2 });
      assert.deepEqual(connection.getCosts(), { global: 10, service: 5, session: 2 });
    });
  });

  // ----------------------------------------------------------------- general
  describe('general store behaviour', () => {
    it('resetStore() resets sessions to an empty array', () => {
      sessions.addSession({ id: 's1' });
      resetStore();
      assert.deepEqual(sessions.getAllSessions(), []);
    });

    it('resetStore() resets agents to an empty array', () => {
      agents.addAgent({ id: 'a1' });
      resetStore();
      assert.deepEqual(agents.getAllAgents(), []);
    });

    it('resetStore() resets abilities to empty system and user arrays', () => {
      abilities.addAbility({ id: 'ab1' }, 'system');
      resetStore();
      assert.deepEqual(abilities.getSystemAbilities(), []);
      assert.deepEqual(abilities.getUserAbilities(), []);
    });

    it('resetStore() resets profile to unauthenticated', () => {
      profile.setUser({ id: 'u1' }, 'tok');
      resetStore();
      assert.equal(profile.isAuthenticated(), false);
      assert.equal(profile.getUser(), null);
    });

    it('resetStore() resets theme to defaults', () => {
      theme.setBase('midnight');
      theme.setAccent('rose');
      resetStore();
      assert.equal(theme.getBase(), 'black-glass');
      assert.equal(theme.getAccent(), 'cyan');
    });

    it('resetStore() resets connection to disconnected with zero costs', () => {
      connection.setStatus('connected');
      connection.updateCosts({ global: 99 });
      resetStore();
      assert.equal(connection.getStatus(), 'disconnected');
      assert.deepEqual(connection.getCosts(), { global: 0, service: 0, session: 0 });
    });

    it('store emits an "update" event when a scope value changes', async () => {
      let eventFired = false;
      let modifiedScopes = [];

      const handler = ({ modified }) => {
        eventFired = true;
        modifiedScopes = modified;
      };

      store.on('update', handler);
      sessions.addSession({ id: 's-event-test' });

      await waitForUpdate();

      store.off('update', handler);

      assert.equal(eventFired, true);
      assert.ok(modifiedScopes.includes('sessions'), `expected "sessions" in modified, got: ${JSON.stringify(modifiedScopes)}`);
    });

    it('store emits a single batched "update" event for multiple synchronous writes', async () => {
      let updateCount = 0;
      let lastModified = [];

      const handler = ({ modified }) => {
        updateCount++;
        lastModified = modified;
      };

      store.on('update', handler);

      // Two writes in the same synchronous block — seqda should batch them.
      sessions.addSession({ id: 'batch-1' });
      agents.addAgent({ id: 'batch-agent-1' });

      await waitForUpdate();

      store.off('update', handler);

      assert.equal(updateCount, 1, 'expected exactly one batched update event');
      assert.ok(lastModified.includes('sessions'));
      assert.ok(lastModified.includes('agents'));
    });
  });
});
