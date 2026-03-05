'use strict';

// =============================================================================
// createStore — lightweight drop-in replacement for seqda
// =============================================================================
// Provides scoped state management with microtask-batched update events.
// Works in both Node.js and browser (no node:events dependency).
//
// Usage:
//   const store = createStore({
//     myScope: {
//       _: defaultValue,
//       myMethod({ get, set, store }, ...args) { ... },
//     },
//   });
//
//   store.myScope.myMethod(arg1, arg2);
//   store.on('update', ({ modified }) => { ... });
//   store.hydrate({ myScope: newValue });
// =============================================================================

export function createStore(template) {
  let state           = {};
  let listeners       = [];
  let pendingModified = null;

  // Initialize state from template defaults
  let scopeNames = Object.keys(template);
  for (let i = 0; i < scopeNames.length; i++)
    state[scopeNames[i]] = template[scopeNames[i]]._;

  // Queue a microtask-batched 'update' event
  function queueUpdate(scopeName) {
    if (!pendingModified) {
      pendingModified = new Set();

      Promise.resolve().then(() => {
        let modified = Array.from(pendingModified);
        pendingModified = null;

        for (let i = 0; i < listeners.length; i++)
          listeners[i]({ modified });
      });
    }

    pendingModified.add(scopeName);
  }

  // Build the store object with on/off/hydrate/getState
  let store = {
    on(event, listener) {
      if (event === 'update')
        listeners.push(listener);
    },

    off(event, listener) {
      if (event === 'update')
        listeners = listeners.filter((l) => l !== listener);
    },

    hydrate(newState) {
      let keys = Object.keys(newState);
      for (let i = 0; i < keys.length; i++)
        state[keys[i]] = newState[keys[i]];
    },

    getState() {
      return { ...state };
    },
  };

  // Build scope objects with bound methods
  for (let i = 0; i < scopeNames.length; i++) {
    let scopeName = scopeNames[i];
    let scopeDef  = template[scopeName];
    let scope     = {};

    let context = {
      get()      { return state[scopeName]; },
      set(value) { state[scopeName] = value; queueUpdate(scopeName); },
      store,
    };

    let methodNames = Object.keys(scopeDef);
    for (let j = 0; j < methodNames.length; j++) {
      let methodName = methodNames[j];

      if (methodName === '_')
        continue;

      let method = scopeDef[methodName];
      scope[methodName] = (...args) => method(context, ...args);
    }

    store[scopeName] = scope;
  }

  return store;
}
