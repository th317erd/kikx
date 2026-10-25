'use strict';

// Minimal in-memory frame store for preference/runtime tests. Each save/load is
// cloned so tests cannot accidentally pass by sharing the runtime's live object
// instead of proving durable persistence.
export function createMemoryFrameStore(initialSessions = []) {
  let sessions = new Map(initialSessions.map((session) => [ session.id, clone(session) ]));
  return {
    sessions,
    async saveSession(session) {
      sessions.set(session.id, clone(session));
      return session;
    },
    async saveSessionManifest(session) {
      sessions.set(session.id, clone(session));
      return session;
    },
    async loadSession(sessionID) {
      let session = sessions.get(sessionID);
      return session ? clone(session) : null;
    },
    async listSessions() {
      return [ ...sessions.values() ].map(clone);
    },
    async listFrames() {
      return [];
    },
    async ensureIndexConfigs() {},
    connect() {
      return () => {};
    },
    async flush() {},
  };
}

export function createIDGenerator(ids = []) {
  let values = ids.slice();
  let index = 0;
  return () => values.shift() || `generated_${++index}`;
}

export function quietLogger() {
  return {
    error() {},
    warn() {},
    log() {},
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
