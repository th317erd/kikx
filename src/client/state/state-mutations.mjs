'use strict';

// A small typed ledger for user-owned client state. It exists so tests can
// assert the whole state transition (scope, breadth, containment, value and
// order) instead of only the final rendered text.

let nextMutationSequence = 0;

export function createMutationLedger({ scope = 'unknown', owner = 'unknown', max = 2000, now = Date.now } = {}) {
  let entries = [];
  let revision = 0;

  return {
    scope,
    owner,
    maxEntries: max,
    get revision() {
      return revision;
    },
    get size() {
      return entries.length;
    },
    record(mutation = {}) {
      revision++;
      let entry = {
        scope: mutation.scope || scope,
        owner: mutation.owner || owner,
        key: mutation.key || '',
        previous: mutation.previous,
        next: mutation.next,
        operation: mutation.operation || 'set',
        cause: mutation.cause || '',
        revision: mutation.revision ?? revision,
        sequence: ++nextMutationSequence,
        epoch: mutation.epoch ?? 0,
        sessionID: mutation.sessionID ?? null,
        frameID: mutation.frameID ?? null,
        questionID: mutation.questionID ?? null,
        at: mutation.at ?? now(),
      };
      entries.push(entry);
      if (entries.length > max)
        entries = entries.slice(entries.length - max);
      return entry;
    },
    entries() {
      return entries.slice();
    },
    clear() {
      entries = [];
      revision = 0;
    },
  };
}
