'use strict';

// Reachability proof for rung 4's session-tree lookup.
//
// `selectCompactor` is a pure function; giving it a `getSession` parameter proves
// nothing unless the production entry point actually supplies one. These tests
// drive `resolveCompactionAgent` -- the only caller of `selectCompactor` in src --
// and assert that an inherited coordinator is selected *through it*, and that a
// service registry without a frame runtime still degrades instead of throwing.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCompactionAgent } from '../../../src/core/compaction/compactor-resolver.mjs';
import { COMPACTOR_REASON, selectCompactor } from '../../../src/core/compaction/select-compactor.mjs';

// Minimal agent manager: knows the agents it is asked to load and nothing else.
function agentManager(ids) {
  let known = new Set(ids);
  return {
    async getAgent(id) {
      return known.has(id) ? { id, pluginID: 'test', enabled: true } : null;
    },
    async refreshCompactionBots() {},
    listModels() {
      return [];
    },
  };
}

// Participant ORDER is deliberate. `resolveSessionWindows` derives every window
// from the provider/catalog, so in this stub both agents resolve the same
// default; rung 5 then ties and breaks by participant order, picking the FIRST.
// With 'big' first, "no tree" answers 'big' and rung 4 answers 'root' -- the two
// paths are distinguishable, so a passing test cannot be a coincidence.
const CHILD = {
  id: 'C',
  parentSessionID: 'P',
  participantAgentIDs: [ 'big', 'root' ],
  coordinatorAgentID: null,
};

const PARENT = {
  id: 'P',
  parentSessionID: null,
  participantAgentIDs: [ 'root' ],
  coordinatorAgentID: 'root',
};

const META = [
  { id: 'root', window: 32768 },
  { id: 'big', window: 200000 },
];

test('resolveCompactionAgent selects a coordinator INHERITED through the frame runtime', async () => {
  let sessions = new Map([[ 'P', PARENT ], [ 'C', CHILD ]]);
  let asked = [];

  let frameRuntime = {
    getSession(id) {
      asked.push(id);
      return sessions.get(id) || null;
    },
  };

  let selected = await resolveCompactionAgent({
    agentManager: agentManager([ 'root', 'big' ]),
    pluginRegistry: { getAgentProvider: () => null },
    catalog: [],
    input: {
      session: CHILD,
      services: { frameRuntime },
      participantAgentsWithMeta: META,
    },
  });

  // If `getSession` were never threaded through, rung 5 would tie and return the
  // first participant ('big') -- the exact residue being closed.
  assert.equal(selected?.id, 'root');
  // The ancestor really was consulted; this is not a lucky local answer.
  assert.ok(asked.includes('P'), `expected the parent to be looked up, saw ${JSON.stringify(asked)}`);
});

test('resolveCompactionAgent degrades to rung 5 when no frame runtime is available', async () => {
  let selected = await resolveCompactionAgent({
    agentManager: agentManager([ 'root', 'big' ]),
    pluginRegistry: { getAgentProvider: () => null },
    catalog: [],
    // No frameRuntime, no getSession: the tree is unknowable here.
    input: {
      session: CHILD,
      services: {},
      participantAgentsWithMeta: META,
    },
  });

  // First participant, not the inherited coordinator: the tree was unknowable.
  assert.equal(selected?.id, 'big');
});

test('the resolver accepts an injected getSession without a frame runtime', async () => {
  let sessions = new Map([[ 'P', PARENT ], [ 'C', CHILD ]]);

  let selected = await resolveCompactionAgent({
    agentManager: agentManager([ 'root', 'big' ]),
    pluginRegistry: { getAgentProvider: () => null },
    catalog: [],
    input: {
      session: CHILD,
      getSession: (id) => sessions.get(id) || null,
      participantAgentsWithMeta: META,
    },
  });

  assert.equal(selected?.id, 'root');
});

test('selectCompactor itself returns the coordinator reason for an inherited owner', () => {
  let sessions = new Map([[ 'P', PARENT ], [ 'C', CHILD ]]);

  let result = selectCompactor({
    session: CHILD,
    participantAgentsWithMeta: META,
    getSession: (id) => sessions.get(id) || null,
  });

  assert.deepEqual(result, { agentID: 'root', reason: COMPACTOR_REASON.COORDINATOR });
});
