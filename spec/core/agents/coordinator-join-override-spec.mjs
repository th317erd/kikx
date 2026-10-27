'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyJoinCoordinatorOverride,
  hasCoordinatorAuthority,
  resolveSessionCoordinator,
} from '../../../src/core/agents/coordinator-scope.mjs';

// ---------------------------------------------------------------------------
// P3: "If a coordinator is added to a child frame, then that coordinator takes
// over responsibility for itself, and all child bots."
//
// The coordinator asked me to prove the READ path already covers this, so that
// `applyJoinCoordinatorOverride` can stay unwired (or be deleted) on the grounds
// that it is redundant. That premise holds for only ONE of the three shapes a
// join can take. These tests separate the three so the difference is not lost:
//
//   JOIN-A  joiner coordinates C's PARENT.   Read path covers it -> inheritance.
//   JOIN-B  joiner coordinates an UNRELATED  Read path DOES NOT cover it -> the
//           branch (or nothing).                parent's first bot is crowned.
//   JOIN-C  joiner unrelated, C also         Read path DOES NOT cover it -> the
//           INHERITS from a parent.            ancestor wins; joiner has no
//                                              authority over C at all.
//
// Measured at d402558, not assumed: JOIN-B resolves `promoted` to the parent's
// first participant, JOIN-C resolves `inherited` to the ancestor coordinator and
// hasCoordinatorAuthority({agentID:'X', targetSessionID:'C'}) returns
// {allowed:false, reason:'not-coordinator'}.
// ---------------------------------------------------------------------------

function session(id, { parentSessionID = null, participants = [], coordinatorAgentID = null } = {}) {
  return {
    id,
    parentSessionID,
    participantAgentIDs: participants.slice(),
    coordinatorAgentID,
  };
}

function tree(sessions) {
  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let getSession = (id) => byID.get(id) || null;
  return { byID, getSession };
}

// --- JOIN-A: joiner coordinates C's parent; read path covers it -------------

test('JOIN-A: a coordinator joined into a child of the session it coordinates is reported as coordinating that child (read path, no write)', () => {
  // X coordinates root session X. C is a CHILD of X, holding bots that are
  // coordinators of nothing. X is invited into C.
  let sessions = [
    session('X', { participants: [ 'X', 'q' ], coordinatorAgentID: 'X' }),
    session('C', { parentSessionID: 'X', participants: [ 'X', 'a' ] }),
  ];
  let { getSession } = tree(sessions);

  let resolved = resolveSessionCoordinator({ sessionID: 'C', getSession });

  assert.equal(resolved.coordinatorAgentID, 'X');
  assert.equal(resolved.source, 'inherited');
  assert.equal(resolved.ownerSessionID, 'X');
  // Nothing was written: C's stored field is still null, which is correct
  // because resolution is derived. This is the "resolve instead of store" rule.
  assert.equal(getSession('C').coordinatorAgentID, null);
  assert.equal(resolved.persisted, false);
});

// --- JOIN-B: joiner coordinates an UNRELATED branch; read path fails -------

test('JOIN-B: a coordinator from an UNRELATED branch joining C is NOT reported as coordinating C by the read path (documents the gap)', () => {
  // X coordinates U, which is not an ancestor of C, not a descendant, not
  // related at all. X joins C. C's own parent P has no coordinator.
  let sessions = [
    session('U', { participants: [ 'X', 'u1' ], coordinatorAgentID: 'X' }),
    session('P', { participants: [ 'p1', 'p2' ] }),
    session('C', { parentSessionID: 'P', participants: [ 'X', 'a' ] }),
  ];
  let { getSession } = tree(sessions);

  let resolved = resolveSessionCoordinator({ sessionID: 'C', getSession });

  // The joiner X does NOT win. Forced promotion crowns P's first participant.
  // This is the exact case the read path does not cover, and it is why
  // applyJoinCoordinatorOverride is not redundant.
  assert.equal(resolved.coordinatorAgentID, 'p1');
  assert.equal(resolved.source, 'promoted');
  assert.notEqual(resolved.coordinatorAgentID, 'X');

  let authority = hasCoordinatorAuthority({ agentID: 'X', targetSessionID: 'C', getSession });
  assert.equal(authority.allowed, false);
  assert.equal(authority.reason, 'not-coordinator');
});

test('JOIN-B with the override applied: the joining coordinator wins over forced promotion', () => {
  let sessions = [
    session('U', { participants: [ 'X', 'u1' ], coordinatorAgentID: 'X' }),
    session('P', { participants: [ 'p1', 'p2' ] }),
    session('C', { parentSessionID: 'P', participants: [ 'X', 'a' ] }),
  ];
  let { getSession } = tree(sessions);

  let override = applyJoinCoordinatorOverride({
    sessionID: 'C',
    agentID: 'X',
    getSession,
    isCoordinatorOfSomeSession: (agentID) => agentID === 'X',
  });

  assert.equal(override.coordinatorAgentID, 'X');
  assert.equal(override.changed, true);

  // Applying it (the caller's job) makes the read path agree.
  getSession('C').coordinatorAgentID = 'X';
  let resolved = resolveSessionCoordinator({ sessionID: 'C', getSession });
  assert.equal(resolved.coordinatorAgentID, 'X');
  assert.equal(resolved.source, 'explicit');
});

// --- JOIN-C: joiner unrelated + C inherits; the ancestor wins ---------------

test('JOIN-C: an inherited ancestor coordinator outranks a joining coordinator from an unrelated branch (read path, documents the gap)', () => {
  // C's parent P is coordinated by Z. X coordinates unrelated U and joins C.
  // Under the owner's sentence X "takes over responsibility for itself and all
  // child bots" -- but the read path keeps Z, because rule 2 (ancestors) is
  // consulted before anything that could look at X.
  let sessions = [
    session('U', { participants: [ 'X', 'u1' ], coordinatorAgentID: 'X' }),
    session('P', { participants: [ 'Z', 'p2' ], coordinatorAgentID: 'Z' }),
    session('C', { parentSessionID: 'P', participants: [ 'X', 'a' ] }),
  ];
  let { getSession } = tree(sessions);

  let resolved = resolveSessionCoordinator({ sessionID: 'C', getSession });

  assert.equal(resolved.coordinatorAgentID, 'Z');
  assert.equal(resolved.source, 'inherited');

  let xOnC = hasCoordinatorAuthority({ agentID: 'X', targetSessionID: 'C', getSession });
  assert.equal(xOnC.allowed, false);
  assert.equal(xOnC.reason, 'not-coordinator');
});

// --- The override must not fire on a guess ---------------------------------

test('override declines when the joiner is a coordinator of nothing', () => {
  let sessions = [ session('C', { participants: [ 'a', 'b' ] }) ];
  let { getSession } = tree(sessions);

  let override = applyJoinCoordinatorOverride({
    sessionID: 'C',
    agentID: 'a',
    getSession,
    isCoordinatorOfSomeSession: () => false,
  });

  assert.equal(override.changed, false);
  assert.equal(override.coordinatorAgentID, null);
});

test('override declines when the oracle is not supplied at all (never crown a stranger)', () => {
  let sessions = [ session('C', { participants: [ 'a', 'b' ] }) ];
  let { getSession } = tree(sessions);

  let override = applyJoinCoordinatorOverride({ sessionID: 'C', agentID: 'a', getSession });

  assert.equal(override.changed, false);
  assert.equal(override.coordinatorAgentID, null);
});

test('override declines when the named bot is not actually a participant of the session', () => {
  let sessions = [ session('C', { participants: [ 'a', 'b' ] }) ];
  let { getSession } = tree(sessions);

  let override = applyJoinCoordinatorOverride({
    sessionID: 'C',
    agentID: 'outsider',
    getSession,
    isCoordinatorOfSomeSession: () => true,
  });

  assert.equal(override.changed, false);
  assert.equal(override.coordinatorAgentID, null);
});

// --- Regression guard: the override must not resurrect req-1 violations ----

test('override leaves a session of pure non-coordinator bots alone (requirement 1 stays legal)', () => {
  // Requirement 1: a session may hold five bots, none of which coordinates
  // anything. Adding one more non-coordinator must not crown anybody.
  let sessions = [ session('C', { participants: [ 'a', 'b', 'c', 'd', 'e' ] }) ];
  let { getSession } = tree(sessions);

  for (let joiner of [ 'a', 'b', 'c', 'd', 'e' ]) {
    let override = applyJoinCoordinatorOverride({
      sessionID: 'C',
      agentID: joiner,
      getSession,
      isCoordinatorOfSomeSession: () => false,
    });
    assert.equal(override.changed, false, `joining bot ${joiner} must not be crowned`);
  }

  assert.equal(getSession('C').coordinatorAgentID, null);
});
