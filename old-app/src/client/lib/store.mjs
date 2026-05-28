'use strict';

// Global state store for Kikx V2 client.
// Wraps a lightweight store with typed scopes for each domain.
// Components subscribe to update events for reactive re-rendering.

import { createStore } from 'kikx/shared/lib/create-store.mjs';

// Default values for each scope, kept as constants so resetStore() can
// reproduce fresh copies without mutation.
const DEFAULTS = {
  sessions:   () => ([]),
  agents:     () => ([]),
  models:     () => ([]),
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

    removeSession({ get, set }, sessionID) {
      set(get().filter((session) => session.id !== sessionID));
    },

    updateSession({ get, set }, sessionID, updates) {
      const sessions = get();
      const index = sessions.findIndex((session) => session.id === sessionID);
      if (index < 0) return;

      const updated = sessions.slice();
      updated[index] = { ...sessions[index], ...updates };
      set(updated);
    },

    getSession({ get }, sessionID) {
      return get().find((session) => session.id === sessionID) ?? null;
    },

    getActiveSession({ get }) {
      return get().find((session) => session.active === true) ?? null;
    },

    setActiveSession({ get, set }, sessionID) {
      const sessions = get().map((session) => ({
        ...session,
        active: session.id === sessionID,
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

    removeAgent({ get, set }, agentID) {
      set(get().filter((agent) => agent.id !== agentID));
    },

    updateAgent({ get, set }, agentID, updates) {
      const agents = get();
      const index = agents.findIndex((agent) => agent.id === agentID);
      if (index < 0) return;

      const updated = agents.slice();
      updated[index] = { ...agents[index], ...updates };
      set(updated);
    },

    getAgent({ get }, agentID) {
      return get().find((agent) => agent.id === agentID) ?? null;
    },

    getAllAgents({ get }) {
      return get();
    },
  },

  // ------------------------------------------------------------------- models
  models: {
    _: DEFAULTS.models(),

    setModels({ set }, list) {
      set(Array.isArray(list) ? list : []);
    },

    getModels({ get }) {
      return get();
    },

    getModel({ get }, modelID) {
      return get().find((m) => m.id === modelID) ?? null;
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

    updateUser({ get, set }, updates) {
      let current = get();
      if (!current.user)
        return;

      set({ ...current, user: { ...current.user, ...updates } });
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
    models:     DEFAULTS.models(),
    profile:    DEFAULTS.profile(),
    theme:      DEFAULTS.theme(),
    connection: DEFAULTS.connection(),
  });
}

// Named scope accessors for ergonomic imports.
const sessions   = store.sessions;
const agents     = store.agents;
const models     = store.models;
const profile    = store.profile;
const theme      = store.theme;
const connection = store.connection;

export default store;
export {
  resetStore,
  sessions,
  agents,
  models,
  profile,
  theme,
  connection,
};
