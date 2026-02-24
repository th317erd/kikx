'use strict';

// Global state store for Hero V2 client.
// Wraps a seqda store with typed scopes for each domain.
// Components subscribe to update events for reactive re-rendering.

import { createStore } from 'seqda';

// Default values for each scope, kept as constants so resetStore() can
// reproduce fresh copies without mutation.
const DEFAULTS = {
  sessions:   () => ([]),
  agents:     () => ([]),
  abilities:  () => ({ system: [], user: [] }),
  profile:    () => ({ user: null, authenticated: false, token: null }),
  theme:      () => ({ base: 'black-glass', accent: 'cyan' }),
  connection: () => ({ status: 'disconnected', costs: { global: 0, service: 0, session: 0 } }),
};

const store = createStore({
  // ------------------------------------------------------------------ sessions
  sessions: {
    _: DEFAULTS.sessions(),

    addSession({ get, set }, session) {
      set([...get(), session]);
    },

    removeSession({ get, set }, sessionId) {
      set(get().filter((session) => session.id !== sessionId));
    },

    updateSession({ get, set }, sessionId, updates) {
      const sessions = get();
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index < 0) return;

      const updated = sessions.slice();
      updated[index] = { ...sessions[index], ...updates };
      set(updated);
    },

    getSession({ get }, sessionId) {
      return get().find((session) => session.id === sessionId) ?? null;
    },

    getActiveSession({ get }) {
      return get().find((session) => session.active === true) ?? null;
    },

    setActiveSession({ get, set }, sessionId) {
      const sessions = get().map((session) => ({
        ...session,
        active: session.id === sessionId,
      }));
      set(sessions);
    },

    getAllSessions({ get }) {
      return get();
    },
  },

  // ------------------------------------------------------------------- agents
  agents: {
    _: DEFAULTS.agents(),

    addAgent({ get, set }, agent) {
      set([...get(), agent]);
    },

    removeAgent({ get, set }, agentId) {
      set(get().filter((agent) => agent.id !== agentId));
    },

    updateAgent({ get, set }, agentId, updates) {
      const agents = get();
      const index = agents.findIndex((agent) => agent.id === agentId);
      if (index < 0) return;

      const updated = agents.slice();
      updated[index] = { ...agents[index], ...updates };
      set(updated);
    },

    getAgent({ get }, agentId) {
      return get().find((agent) => agent.id === agentId) ?? null;
    },

    getAllAgents({ get }) {
      return get();
    },
  },

  // ---------------------------------------------------------------- abilities
  abilities: {
    _: DEFAULTS.abilities(),

    addAbility({ get, set }, ability, category = 'user') {
      const current = get();
      const categoryList = current[category] ?? [];
      set({ ...current, [category]: [...categoryList, ability] });
    },

    removeAbility({ get, set }, abilityId) {
      const current = get();
      set({
        system: current.system.filter((ability) => ability.id !== abilityId),
        user:   current.user.filter((ability) => ability.id !== abilityId),
      });
    },

    updateAbility({ get, set }, abilityId, updates) {
      const current = get();
      const updateInList = (list) => {
        const index = list.findIndex((ability) => ability.id === abilityId);
        if (index < 0) return list;
        const updated = list.slice();
        updated[index] = { ...list[index], ...updates };
        return updated;
      };
      set({
        system: updateInList(current.system),
        user:   updateInList(current.user),
      });
    },

    getAbility({ get }, abilityId) {
      const current = get();
      return (
        current.system.find((ability) => ability.id === abilityId) ??
        current.user.find((ability) => ability.id === abilityId) ??
        null
      );
    },

    getSystemAbilities({ get }) {
      return get().system;
    },

    getUserAbilities({ get }) {
      return get().user;
    },
  },

  // ------------------------------------------------------------------ profile
  profile: {
    _: DEFAULTS.profile(),

    setUser({ get, set }, user, token) {
      set({ ...get(), user, token, authenticated: true });
    },

    getUser({ get }) {
      return get().user;
    },

    isAuthenticated({ get }) {
      return get().authenticated;
    },

    logout({ set }) {
      set({ user: null, authenticated: false, token: null });
    },
  },

  // -------------------------------------------------------------------- theme
  theme: {
    _: DEFAULTS.theme(),

    setBase({ get, set }, base) {
      set({ ...get(), base });
    },

    setAccent({ get, set }, accent) {
      set({ ...get(), accent });
    },

    getBase({ get }) {
      return get().base;
    },

    getAccent({ get }) {
      return get().accent;
    },
  },

  // --------------------------------------------------------------- connection
  connection: {
    _: DEFAULTS.connection(),

    setStatus({ get, set }, status) {
      set({ ...get(), status });
    },

    updateCosts({ get, set }, costs) {
      const current = get();
      set({ ...current, costs: { ...current.costs, ...costs } });
    },

    getStatus({ get }) {
      return get().status;
    },

    getCosts({ get }) {
      return get().costs;
    },
  },
});

// Resets all scopes to their default values.
// Intended for use in tests to restore a clean baseline between cases.
// Uses hydrate() to atomically replace the entire state tree in one shot.
function resetStore() {
  store.hydrate({
    sessions:   DEFAULTS.sessions(),
    agents:     DEFAULTS.agents(),
    abilities:  DEFAULTS.abilities(),
    profile:    DEFAULTS.profile(),
    theme:      DEFAULTS.theme(),
    connection: DEFAULTS.connection(),
  });
}

// Named scope accessors for ergonomic imports.
const sessions   = store.sessions;
const agents     = store.agents;
const abilities  = store.abilities;
const profile    = store.profile;
const theme      = store.theme;
const connection = store.connection;

export default store;
export {
  resetStore,
  sessions,
  agents,
  abilities,
  profile,
  theme,
  connection,
};
