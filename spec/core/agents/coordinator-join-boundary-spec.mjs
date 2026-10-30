'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import * as coordinatorScope from '../../../src/core/agents/coordinator-scope.mjs';

const {
  hasCoordinatorAuthority,
  resolveSessionCoordinator,
} = coordinatorScope;

// ---------------------------------------------------------------------------
// P3 boundary: "If a coordinator is added to a child frame, then that coordinator
// takes over responsibility for itself, and all child bots."
//
// This file used to test `applyJoinCoordinatorOverride`, a pure helper that was
// never wired to any production caller. It is now a guard on the LIVE resolver,
// and it exists to keep one decision from being undone by accident:
//
//   A bot that coordinates an UNRELATED branch must NOT gain authority over a
//   session merely by joining it. Authority flows DOWN the ancestry chain.
//
// That is why `applyJoinCoordinatorOverride` was DELETED rather than wired
// (coordinator-scope.mjs used to export it). Wiring it would have written
// `coordinatorAgentID` on join, letting an unrelated joiner take a session
// laterally -- the opposite of the ruling. The first test below fails the moment
// anyone reintroduces such an export.
//
// The three shapes a join can take, measured on the read path:
//
//   JOIN-A  joiner coordinates C's PARENT      -> inherited, covered.
//   JOIN-B  joiner from an UNRELATED branch    -> promoted to p1, joiner DENIED.
//   JOIN-C  joiner unrelated, C inherits       -> ancestor wins, joiner DENIED.
//
// JOIN-B and JOIN-C are deliberately UNSUPPORTED; they are pinned here so the
// limitation is executable rather than folklore.
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

// --- The deleted override must stay deleted --------------------------------

test('no export can crown a joining bot: the join-override helper is gone', () => {
  // Not merely "unused" -- absent. An unwired helper that encodes lateral
  // takeover is a loaded gun: the next caller to find it wires it, and the
  // authority rule silently inverts.
  assert.equal(
    Object.hasOwn(coordinatorScope, 'applyJoinCoordinatorOverride'),
    false,
    'applyJoinCoordinatorOverride must not be exported: joining a session must never grant coordinator authority',
  );
});

test('the resolver still exposes the read path the join boundary depends on', () => {
  // Guards the other direction: if a refactor removed resolveSessionCoordinator
  // or hasCoordinatorAuthority, the tests below would error rather than fail
  // meaningfully, and the boundary would be unenforced rather than broken.
  assert.equal(typeof resolveSessionCoordinator, 'function');
  assert.equal(typeof hasCoordinatorAuthority, 'function');
});

// --- JOIN-A: joiner coordinates C's parent; read path covers it ------------

test('JOIN-A: a joiner that coordinates the child\'s PARENT is reported as coordinating that child', () => {
  // X coordinates root session X. C is a CHILD of X. X is invited into C.
  let sessions = [
    session('X', { participants: [ 'X', 'q' ], coordinatorAgentID: 'X' }),
    session('C', { parentSessionID: 'X', participants: [ 'X', 'a' ] }),
  ];
  let { getSession } = tree(sessions);

  let resolved = resolveSessionCoordinator({ sessionID: 'C', getSession });

  assert.equal(resolved.coordinatorAgentID, 'X');
  assert.equal(resolved.source, 'inherited');
  assert.equal(resolved.ownerSessionID, 'X');
  // Nothing was written: C's stored field stays null, because resolution is
  // derived. This is the "resolve instead of store" rule that the deleted
  // override would have violated by writing on join.
  assert.equal(getSession('C').coordinatorAgentID, null);
  assert.equal(resolved.persisted, false);
});

// --- JOIN-B: unrelated joiner is DENIED ------------------------------------

test('JOIN-B: a coordinator from an UNRELATED branch gains nothing by joining C', () => {
  // X coordinates U, which is neither an ancestor nor a descendant of C. C's
  // parent P has no coordinator. X joins C as a participant.
  let sessions = [
    session('U', { participants: [ 'X', 'u1' ], coordinatorAgentID: 'X' }),
    session('P', { participants: [ 'p1', 'p2' ] }),
    session('C', { parentSessionID: 'P', participants: [ 'X', 'a' ] }),
  ];
  let { getSession } = tree(sessions);

  let resolved = resolveSessionCoordinator({ sessionID: 'C', getSession });

  // The joiner X does not win; forced promotion crowns P's first participant.
  assert.equal(resolved.coordinatorAgentID, 'p1');
  assert.equal(resolved.source, 'promoted');
  assert.notEqual(resolved.coordinatorAgentID, 'X');

  let authority = hasCoordinatorAuthority({ agentID: 'X', targetSessionID: 'C', getSession });
  assert.equal(authority.allowed, false);
  assert.equal(authority.reason, 'not-coordinator');
});

// --- JOIN-C: unrelated joiner vs an inherited ancestor; ancestor wins ------

test('JOIN-C: an inherited ancestor coordinator outranks a joining coordinator from an unrelated branch', () => {
  // C's parent P is coordinated by Z. X coordinates unrelated U and joins C.
  // The literal reading of P3 would hand C to X; the read path keeps Z, and X
  // has no authority over C.
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

// --- Requirement 1 stays legal --------------------------------------------

test('a session of pure non-coordinator bots is legal and crowns nobody', () => {
  // Requirement 1: a session may hold five bots, none of which coordinates
  // anything. The old override had a test for this; the guarantee belongs to
  // the read path now, so it is asserted here rather than dropped with the code.
  let sessions = [ session('C', { participants: [ 'a', 'b', 'c', 'd', 'e' ] }) ];
  let { getSession } = tree(sessions);

  let resolved = resolveSessionCoordinator({ sessionID: 'C', getSession });

  // Nothing above it has a coordinator, so promotion names ONE accountable bot
  // rather than leaving the run ownerless -- and it is marked as promotion, not
  // as a designation, which is what keeps select-compactor's rung 5 reachable.
  assert.equal(resolved.source, 'promoted');
  assert.equal(resolved.coordinatorAgentID, 'a');
  assert.equal(getSession('C').coordinatorAgentID, null, 'resolution must not write the record');
});
