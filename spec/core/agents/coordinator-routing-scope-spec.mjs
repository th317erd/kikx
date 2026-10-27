// WHY THIS SPEC EXISTS (read before "fixing" routing to use the tree resolver).
//
// Routing and authority answer two DIFFERENT questions:
//
//   routing   : "who should RUN because of this frame?"      -> participants only
//   authority : "who may COMMAND in this session subtree?"    -> ancestors-or-self
//
// `resolveRouteTargets` filters its output with `participantAgentIDs.includes(...)`
// (src/core/agents/agent-route/targeting.mjs:98). A coordinator inherited from an
// ancestor is by definition NOT a participant of the child session, so it is
// filtered out. Pointing routing at `resolveSessionCoordinator` therefore turns
// an unaddressed message in a coordinated-by-inheritance child into ZERO targets.
//
// That is the blast radius of the "flip all three sites" proposal, and it is why
// the local rule at normalize.mjs:60 is kept for routing. This spec pins the
// constraint so a future contributor cannot flip it without seeing the cost.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSessionCoordinator,
  resolveLocalCoordinatorAgentID,
  hasCoordinatorAuthority,
} from '../../../src/core/agents/coordinator-scope.mjs';
import { resolveRouteTargets } from '../../../src/core/agents/agent-route/targeting.mjs';

// Three-level tree. Z coordinates the ROOT (P) and is not a participant of C.
//
//   P  participants [z, p1]  coordinatorAgentID Z
//   └── C  participants [c1]  coordinatorAgentID null   <-- inherits Z
//
// X and Y are local bots of C in the sibling fixture; here c1 alone is enough
// to show the divergence.
function tree() {
  let sessions = new Map([
    ['P', { id: 'P', parentSessionID: null, participantAgentIDs: ['z', 'p1'], coordinatorAgentID: 'z' }],
    ['C', { id: 'C', parentSessionID: 'P', participantAgentIDs: ['c1'], coordinatorAgentID: null }],
  ]);
  return {
    sessions,
    getSession: (id) => sessions.get(id) || null,
  };
}

function unaddressedUserFrame() {
  return { id: 'f1', sessionID: 'C', authorID: 'user', authorType: 'user', content: { text: 'hello' } };
}

test('tree resolver inherits the root coordinator at depth 1', () => {
  let { getSession } = tree();
  let resolution = resolveSessionCoordinator({ sessionID: 'C', getSession });

  assert.equal(resolution.coordinatorAgentID, 'z');
  assert.equal(resolution.source, 'inherited');
});

test('the local rule answers the routing question with the first participant', () => {
  let { sessions } = tree();
  let local = resolveLocalCoordinatorAgentID(sessions.get('C'), sessions.get('C').participantAgentIDs);

  // This is the disagreement, stated as a fact: two different ids for one session.
  assert.equal(local, 'c1');
});

test('FLIP HAZARD: routing to an inherited non-participant coordinator yields no targets', () => {
  let { sessions, getSession } = tree();
  let inherited = resolveSessionCoordinator({ sessionID: 'C', getSession });
  let participants = sessions.get('C').participantAgentIDs;

  assert.equal(inherited.coordinatorAgentID, 'z');

  let targets = resolveRouteTargets({
    frame: unaddressedUserFrame(),
    participantAgentIDs: participants,
    coordinatorAgentID: inherited.coordinatorAgentID,
  });

  // Nobody runs. The message is accepted and silently unrouted.
  assert.deepEqual(targets, []);
});

test('the local answer still routes the message to a live participant', () => {
  let { sessions } = tree();
  let participants = sessions.get('C').participantAgentIDs;
  let local = resolveLocalCoordinatorAgentID(sessions.get('C'), participants);

  let targets = resolveRouteTargets({
    frame: unaddressedUserFrame(),
    participantAgentIDs: participants,
    coordinatorAgentID: local,
  });

  assert.deepEqual(targets, ['c1']);
});

test('the two answers diverge ONLY because the inherited coordinator is not a participant', () => {
  // Same tree, except Z was also invited to C. Now routing and authority agree.
  let sessions = new Map([
    ['P', { id: 'P', parentSessionID: null, participantAgentIDs: ['z', 'p1'], coordinatorAgentID: 'z' }],
    ['C', { id: 'C', parentSessionID: 'P', participantAgentIDs: ['c1', 'z'], coordinatorAgentID: null }],
  ]);
  let getSession = (id) => sessions.get(id) || null;

  let inherited = resolveSessionCoordinator({ sessionID: 'C', getSession });
  assert.equal(inherited.coordinatorAgentID, 'z');

  let targets = resolveRouteTargets({
    frame: unaddressedUserFrame(),
    participantAgentIDs: sessions.get('C').participantAgentIDs,
    coordinatorAgentID: inherited.coordinatorAgentID,
  });

  assert.deepEqual(targets, ['z']);
});

test('authority flows DOWN: Z may command C, c1 may not', () => {
  let { getSession } = tree();

  let forRootCoordinator = hasCoordinatorAuthority({ agentID: 'z', targetSessionID: 'C', getSession });
  assert.equal(forRootCoordinator.allowed, true);
  assert.equal(forRootCoordinator.reason, 'ancestor');

  let forLocalBot = hasCoordinatorAuthority({ agentID: 'c1', targetSessionID: 'C', getSession });
  assert.equal(forLocalBot.allowed, false);
  assert.equal(forLocalBot.reason, 'not-coordinator');
});

test('INCOHERENCE, pinned: the routing gate admits c1 while authority denies it', () => {
  // This is the live split-brain Zav asked about, reduced to two calls.
  let { sessions, getSession } = tree();
  let participants = sessions.get('C').participantAgentIDs;

  // 1. The forwardFrame gate (agent-route-frame-plugin-base.mjs:328-330) compares
  //    the acting agent against the LOCAL rule. c1 is the local coordinator, so
  //    c1 is admitted to route.
  let local = resolveLocalCoordinatorAgentID(sessions.get('C'), participants);
  assert.equal(local, 'c1');
  let gateAdmits = (agentID) => agentID === local;
  assert.equal(gateAdmits('c1'), true);

  // 2. Halt authority routes through the tree rule, which refuses c1.
  let authority = hasCoordinatorAuthority({ agentID: 'c1', targetSessionID: 'C', getSession });
  assert.equal(authority.allowed, false);

  // 3. The two gates disagree about the same agent in the same session.
  assert.notEqual(gateAdmits('c1'), authority.allowed);
});

test('authority does not flow UP: a child coordinator cannot command its parent', () => {
  let sessions = new Map([
    ['P', { id: 'P', parentSessionID: null, participantAgentIDs: ['p1'], coordinatorAgentID: null }],
    ['C', { id: 'C', parentSessionID: 'P', participantAgentIDs: ['c1'], coordinatorAgentID: 'c1' }],
  ]);
  let getSession = (id) => sessions.get(id) || null;

  let upward = hasCoordinatorAuthority({ agentID: 'c1', targetSessionID: 'P', getSession });
  assert.equal(upward.allowed, false);
  assert.equal(upward.reason, 'not-coordinator');
});
