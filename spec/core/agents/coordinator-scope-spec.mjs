'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ancestorSessionIDs,
  hasCoordinatorAuthority,
  nearestAncestorCoordinator,
  resolveCoordinatorChain,
  resolveSessionCoordinator,
} from '../../../src/core/agents/coordinator-scope.mjs';
import { resolveSubtreeSessionIDs } from '../../../src/core/agents/session-subtree.mjs';
import { resolveCoordinatorAgentID as legacyResolveCoordinatorAgentID } from '../../../src/core/agents/agent-route/normalize.mjs';
import { resolveVisibleSessionIDs } from '../../../src/core/questions/question-dedupe.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// The mandatory shape is THREE levels, because two cannot distinguish
// inheritance from promotion or upward authority from downward authority:
//
//   P   (grandparent)  coordinator: Z   -- Z is NOT a participant of C or G
//   |
//   C   (child)        participants: c1, c2   no coordinator of its own
//   |
//   G   (grandchild)   participants: X, Y    no coordinator of its own
//
// With only P -> C, "Z coordinates my parent" and "Z is the first participant
// of my parent" give the same answer, and "authority flows down" and "authority
// flows up" both let Z act on C. The third level is what separates them.
//
// A second branch under P exercises the "unrelated branch is refused" case, and
// `otherRoot` is a separate tree that must never interact with P's.

function session(id, { parentSessionID = null, participants = [], coordinatorAgentID = null } = {}) {
  return {
    id,
    parentSessionID,
    participantAgentIDs: participants.slice(),
    coordinatorAgentID,
  };
}

function makeTree() {
  let sessions = [
    session('P', { participants: ['z', 'p2'], coordinatorAgentID: 'z' }),
    session('C', { parentSessionID: 'P', participants: ['c1', 'c2'] }),
    session('G', { parentSessionID: 'C', participants: ['x', 'y'] }),
    session('C2', { parentSessionID: 'P', participants: ['q1'] }),
    session('otherRoot', { participants: ['o1'], coordinatorAgentID: 'o1' }),
  ];

  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let getSession = (id) => byID.get(id) || null;
  return { sessions, byID, getSession };
}

// A tree in which NO ancestor has a coordinator, so forced promotion must fire.
// `promoSelf` has its own participants; `promoEmpty` has none and must inherit the
// promotion from its parent rather than resolve to null.
function makeUncoordinatedTree() {
  let sessions = [
    session('promoRoot', { participants: ['rootFirst', 'rootSecond'] }),
    session('promoSelf', { parentSessionID: 'promoRoot', participants: ['selfFirst', 'selfSecond'] }),
    session('promoEmpty', { parentSessionID: 'promoRoot', participants: [] }),
  ];

  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  return { sessions, byID, getSession: (id) => byID.get(id) || null };
}

// ---------------------------------------------------------------------------
// a. Inheritance at depth 2, with Z absent from C and G
// ---------------------------------------------------------------------------

test('coordinator of a grandchild is the grandparent coordinator, at depth 2, with no participant presence', () => {
  let { getSession } = makeTree();

  // Precondition that makes the test meaningful: Z is not in C or G at all.
  assert.deepEqual(getSession('C').participantAgentIDs, [ 'c1', 'c2' ]);
  assert.deepEqual(getSession('G').participantAgentIDs, [ 'x', 'y' ]);
  assert.equal(getSession('C').coordinatorAgentID, null);
  assert.equal(getSession('G').coordinatorAgentID, null);

  assert.equal(resolveSessionCoordinator({ sessionID: 'G', getSession }).coordinatorAgentID, 'z');
  assert.equal(resolveSessionCoordinator({ sessionID: 'C', getSession }).coordinatorAgentID, 'z');

  // The answer at depth 2 must be recorded as inherited from P, not promoted.
  let atG = resolveSessionCoordinator({ sessionID: 'G', getSession });
  assert.equal(atG.source, 'inherited');
  assert.equal(atG.ownerSessionID, 'P');
  assert.equal(atG.promoted, false);
  assert.deepEqual(atG.chain, [ 'G', 'C', 'P' ]);
});

test('today\'s resolver returns null for the same grandchild, proving this spec can fail', () => {
  let { getSession } = makeTree();
  let C = getSession('C');
  let G = getSession('G');

  // The pre-existing function has no parent walk: with no explicit coordinator it
  // falls back to the first participant. That is the bug being replaced, and this
  // assertion pins the difference rather than trusting the prose.
  assert.equal(legacyResolveCoordinatorAgentID(C, C.participantAgentIDs), 'c1');
  assert.equal(legacyResolveCoordinatorAgentID(G, G.participantAgentIDs), 'x');
  assert.notEqual(legacyResolveCoordinatorAgentID(G, G.participantAgentIDs), 'z');
});

// ---------------------------------------------------------------------------
// b. Authority flows DOWN, and does not flow UP
// ---------------------------------------------------------------------------

test('the grandparent coordinator may halt a run in the child and in the grandchild', () => {
  let { getSession } = makeTree();

  let atC = hasCoordinatorAuthority({ agentID: 'z', targetSessionID: 'C', getSession });
  assert.equal(atC.allowed, true);
  assert.equal(atC.reason, 'ancestor');
  assert.equal(atC.ownerSessionID, 'P');

  let atG = hasCoordinatorAuthority({ agentID: 'z', targetSessionID: 'G', getSession });
  assert.equal(atG.allowed, true);
  assert.equal(atG.reason, 'ancestor');
  assert.equal(atG.ownerSessionID, 'P');

  // And over its own session, as 'self'.
  let atP = hasCoordinatorAuthority({ agentID: 'z', targetSessionID: 'P', getSession });
  assert.equal(atP.allowed, true);
  assert.equal(atP.reason, 'self');
});

test('authority does not flow UP: the child coordinator may not command its parent', () => {
  // Give C its own coordinator so there is an actor whose authority exists but
  // must stop at the parent boundary. Without this, the "up" case is only testing
  // a missing coordinator rather than a bounded one.
  let sessions = [
    session('P', { participants: ['z', 'p2'], coordinatorAgentID: 'z' }),
    session('C', { parentSessionID: 'P', participants: ['c1', 'c2'], coordinatorAgentID: 'c1' }),
    session('G', { parentSessionID: 'C', participants: ['x', 'y'] }),
  ];
  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let getSession = (id) => byID.get(id) || null;

  // c1 commands its own session and the grandchild below it.
  assert.equal(hasCoordinatorAuthority({ agentID: 'c1', targetSessionID: 'C', getSession }).allowed, true);
  assert.equal(hasCoordinatorAuthority({ agentID: 'c1', targetSessionID: 'G', getSession }).allowed, true);

  // It may not command P, which sits above it.
  let up = hasCoordinatorAuthority({ agentID: 'c1', targetSessionID: 'P', getSession });
  assert.equal(up.allowed, false);
  assert.equal(up.reason, 'not-coordinator');
});

test('authority does not flow SIDEWAYS: a sibling branch is refused', () => {
  let { getSession } = makeTree();

  // q1 coordinates nothing; it is a participant of the sibling branch C2.
  assert.equal(hasCoordinatorAuthority({ agentID: 'q1', targetSessionID: 'G', getSession }).allowed, false);
  assert.equal(hasCoordinatorAuthority({ agentID: 'q1', targetSessionID: 'C', getSession }).allowed, false);

  // Even the sibling branch's coordinator, if it had one, could not reach G.
  let sessions = [
    session('P', { participants: ['z'], coordinatorAgentID: 'z' }),
    session('C', { parentSessionID: 'P', participants: ['c1'], coordinatorAgentID: 'c1' }),
    session('G', { parentSessionID: 'C', participants: ['x', 'y'] }),
    session('C2', { parentSessionID: 'P', participants: ['q1'], coordinatorAgentID: 'q1' }),
  ];
  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let sideGet = (id) => byID.get(id) || null;
  assert.equal(hasCoordinatorAuthority({ agentID: 'q1', targetSessionID: 'G', getSession: sideGet }).allowed, false);

  // A wholly unrelated tree cannot reach in either.
  assert.equal(hasCoordinatorAuthority({ agentID: 'o1', targetSessionID: 'G', getSession }).allowed, false);
});

test('the upward and downward relations are not the same set (the 3-level disambiguation)', () => {
  let { sessions, getSession } = makeTree();
  let tree = sessions.map((entry) => ({ ...entry }));

  // resolveVisibleSessionIDs gives {V} u descendants(V) -- the DOWNWARD set.
  let fromP = new Set(resolveVisibleSessionIDs('P', tree));
  assert.deepEqual([ ...fromP ].sort(), [ 'C', 'C2', 'G', 'P' ]);
  assert.equal(fromP.has('G'), true);

  // From the GRANDCHILD the downward set is just itself, yet authority still
  // reaches P's coordinator over it. If authority were implemented with this
  // helper, `hasCoordinatorAuthority('z', 'G')` would have to walk the opposite
  // way and the assertion below would invert.
  let fromG = new Set(resolveVisibleSessionIDs('G', tree));
  assert.deepEqual([ ...fromG ], [ 'G' ]);

  assert.equal(hasCoordinatorAuthority({ agentID: 'z', targetSessionID: 'G', getSession }).allowed, true);
  assert.deepEqual(ancestorSessionIDs('G', getSession), [ 'G', 'C', 'P' ]);
});

test('the subtree fan-out and the question-visibility walk agree on the same fixture', () => {
  // Two implementations of "what is below this session" now exist; pin them so
  // they cannot drift into two different answers.
  let { sessions } = makeTree();
  let tree = sessions.map((entry) => ({ ...entry }));

  for (let root of [ 'P', 'C', 'G', 'C2', 'otherRoot' ]) {
    let subtree = resolveSubtreeSessionIDs(root, { sessions: tree }).sessionIDs.slice().sort();
    let visible = resolveVisibleSessionIDs(root, tree).slice().sort();
    assert.deepEqual(subtree, visible, `subtree differs from question visibility at ${root}`);
  }
});

// ---------------------------------------------------------------------------
// c. Non-coordinator bots are legal
// ---------------------------------------------------------------------------

test('a session full of bots that coordinate nothing is legal and is not crowned', () => {
  let { getSession } = makeTree();

  let resolution = resolveSessionCoordinator({ sessionID: 'G', getSession });
  assert.equal(resolution.coordinatorAgentID, 'z');
  assert.equal(resolution.promoted, false);

  // X and Y are not the coordinator of G, nor of anywhere else in the tree.
  assert.notEqual(resolution.coordinatorAgentID, 'x');
  assert.notEqual(resolution.coordinatorAgentID, 'y');

  for (let sessionID of [ 'P', 'C', 'G', 'C2', 'otherRoot' ]) {
    let coordinatorAgentID = resolveSessionCoordinator({ sessionID, getSession }).coordinatorAgentID;
    assert.notEqual(coordinatorAgentID, 'x');
    assert.notEqual(coordinatorAgentID, 'y');
  }

  // The record is untouched: no promotion happened, so nothing was written.
  assert.equal(getSession('G').coordinatorAgentID, null);
});

// ---------------------------------------------------------------------------
// Forced promotion, persisted, and stable on a second call
// ---------------------------------------------------------------------------

test('with no coordinator anywhere above, promotion fires, persists, and is stable', () => {
  let { getSession, byID } = makeUncoordinatedTree();
  let writes = [];
  let persistCoordinator = (sessionID, agentID) => {
    writes.push([ sessionID, agentID ]);
    let target = byID.get(sessionID);
    if (target)
      target.coordinatorAgentID = agentID;
  };

  let first = resolveSessionCoordinator({ sessionID: 'promoSelf', getSession, persistCoordinator });
  assert.equal(first.coordinatorAgentID, 'rootFirst');
  assert.equal(first.source, 'promoted');
  assert.equal(first.promoted, true);
  assert.equal(first.persisted, true);
  assert.equal(first.ownerSessionID, 'promoRoot', 'promotion prefers the highest participant-holding session');

  // The write actually landed on the session record, not just in the return value.
  assert.equal(getSession('promoRoot').coordinatorAgentID, 'rootFirst');
  assert.deepEqual(writes, [ [ 'promoRoot', 'rootFirst' ] ]);

  // A second call resolves the same id. It now reports 'inherited' rather than
  // 'promoted' because the write landed on promoRoot and rule 2 finds it there.
  // Either label is fine; what matters is the SAME agent and no second write.
  // This is the "two calls agree" property that a return-only promotion would
  // break, and the property a naive per-session promotion would break differently.
  let second = resolveSessionCoordinator({ sessionID: 'promoSelf', getSession, persistCoordinator });
  assert.equal(second.coordinatorAgentID, first.coordinatorAgentID);
  assert.equal(second.ownerSessionID, 'promoRoot');
  assert.equal(second.promoted, false);
  assert.equal(writes.length, 1, 'the second call must not promote again');
});

test('a child with no participants at all does not fall through to null when the parent promotes', () => {
  let { getSession, byID } = makeUncoordinatedTree();
  let persistCoordinator = (sessionID, agentID) => {
    let target = byID.get(sessionID);
    if (target)
      target.coordinatorAgentID = agentID;
  };

  let empty = resolveSessionCoordinator({ sessionID: 'promoEmpty', getSession, persistCoordinator });
  assert.equal(empty.coordinatorAgentID, 'rootFirst');
  assert.equal(empty.source, 'promoted');
  assert.equal(empty.ownerSessionID, 'promoRoot');
});

test('a chain with no participants anywhere resolves to null, and nothing is written', () => {
  let sessions = [ session('lonely', { participants: [] }) ];
  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let getSession = (id) => byID.get(id) || null;
  let writes = [];
  let persistCoordinator = (sessionID, agentID) => writes.push([ sessionID, agentID ]);

  let resolution = resolveSessionCoordinator({ sessionID: 'lonely', getSession, persistCoordinator });
  assert.equal(resolution.coordinatorAgentID, null);
  assert.equal(resolution.source, 'none');
  assert.deepEqual(writes, []);
});

test('promotion is deterministic without persistence, so a read-only check cannot disagree', () => {
  // hasCoordinatorAuthority never writes. It must still agree with what a
  // persisting resolve would have chosen, or a permission check and the next
  // resolution would contradict each other.
  let { getSession: writeGet } = makeUncoordinatedTree();
  let writeTree = makeUncoordinatedTree();
  let persisted = resolveSessionCoordinator({
    sessionID: 'promoSelf',
    getSession: writeGet,
    persistCoordinator: (sessionID, agentID) => {
      let target = writeTree.byID.get(sessionID);
      if (target)
        target.coordinatorAgentID = agentID;
    },
  });

  let { getSession: readGet } = makeUncoordinatedTree();
  let authority = hasCoordinatorAuthority({
    agentID: 'rootFirst',
    targetSessionID: 'promoSelf',
    getSession: readGet,
  });

  assert.equal(authority.allowed, true);
  assert.equal(authority.promoted, true);
  assert.equal(authority.ownerSessionID, persisted.ownerSessionID);
});

test('a bot that coordinates nothing anywhere has no authority over a promoted subtree', () => {
  let { getSession } = makeUncoordinatedTree();

  // selfSecond is a participant of promoSelf but promotion went to rootFirst.
  let resolution = resolveSessionCoordinator({ sessionID: 'promoSelf', getSession });
  assert.equal(resolution.coordinatorAgentID, 'rootFirst');

  let denied = hasCoordinatorAuthority({ agentID: 'selfSecond', targetSessionID: 'promoSelf', getSession });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'not-coordinator');
});

// ---------------------------------------------------------------------------
// Termination: cycles and dangling parents
// ---------------------------------------------------------------------------

test('a parent cycle terminates with a defined result and does not hang', () => {
  // A malformed write has made P -> Q -> P.
  let sessions = [
    session('P', { parentSessionID: 'Q', participants: ['p1'], coordinatorAgentID: 'p1' }),
    session('Q', { parentSessionID: 'P', participants: ['q1'], coordinatorAgentID: 'q1' }),
  ];
  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let getSession = (id) => byID.get(id) || null;

  let walked = resolveSessionCoordinator({ sessionID: 'P', getSession });
  assert.equal(walked.cycleDetected, true);
  assert.equal(walked.stopped, 'cycle');
  assert.deepEqual(walked.chain, [ 'P', 'Q' ]);

  // The session's own coordinator still wins, so a cycle does not make a session
  // uncommandable.
  assert.equal(walked.coordinatorAgentID, 'p1');
  assert.equal(walked.source, 'explicit');

  // Authority still answers, and does not loop.
  assert.equal(hasCoordinatorAuthority({ agentID: 'p1', targetSessionID: 'P', getSession }).allowed, true);

  // DELIBERATE: in a cycle, authority from the sessions the walk DID reach still
  // applies. Q is P's declared parent, so q1 genuinely holds authority over P
  // under the written-down rule -- the corruption is the cycle itself, not the
  // parent link. Refusing here would silently strip authority from every session
  // in a corrupt cycle; granting it from a reachable, recorded coordinator is the
  // recoverable failure. What must never happen is a hang, and that is asserted
  // above via `stopped: 'cycle'`.
  let fromQ = hasCoordinatorAuthority({ agentID: 'q1', targetSessionID: 'P', getSession });
  assert.equal(fromQ.allowed, true);
  assert.equal(fromQ.reason, 'ancestor');
  assert.equal(fromQ.ownerSessionID, 'Q');

  // An actor outside the cycle gets nothing, so the cycle cannot be used to widen
  // authority beyond the sessions on it.
  assert.equal(hasCoordinatorAuthority({ agentID: 'outsider', targetSessionID: 'P', getSession }).allowed, false);
});

test('a dangling parentSessionID terminates and reports the missing session', () => {
  let sessions = [
    session('orphan', { parentSessionID: 'deletedSession', participants: ['a1'] }),
  ];
  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let getSession = (id) => byID.get(id) || null;

  let walked = resolveSessionCoordinator({ sessionID: 'orphan', getSession });
  assert.equal(walked.stopped, 'missing');
  assert.equal(walked.missingSessionID, 'deletedSession');
  assert.deepEqual(walked.chain, [ 'orphan' ]);

  // It still resolves: the orphan promotes from its own participants rather than
  // throwing or returning null.
  assert.equal(walked.coordinatorAgentID, 'a1');
  assert.equal(walked.source, 'promoted');
});

test('an unknown session id resolves to null with the walk reported, not a throw', () => {
  let { getSession } = makeTree();
  let walked = resolveSessioncoordinatorOrNull(getSession);
  assert.equal(walked.coordinatorAgentID, null);
  assert.equal(walked.source, 'none');
  assert.deepEqual(walked.chain, []);
  assert.equal(walked.stopped, 'missing');
  assert.equal(walked.missingSessionID, 'doesNotExist');

  function resolveSessioncoordinatorOrNull(lookup) {
    return resolveSessionCoordinator({ sessionID: 'doesNotExist', getSession: lookup });
  }
});

test('the ancestor walk is depth-capped', () => {
  let sessions = [];
  for (let index = 0; index < 80; index += 1)
    sessions.push(session(`s${index}`, { parentSessionID: index === 0 ? null : `s${index - 1}` }));

  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let getSession = (id) => byID.get(id) || null;

  let walked = resolveSessionCoordinator({ sessionID: 's79', getSession, maxDepth: 10 });
  assert.equal(walked.stopped, 'depth');
  assert.equal(walked.chain.length, 10);
  assert.equal(walked.chain[0], 's79');
});

// ---------------------------------------------------------------------------
// Chain reporting
// ---------------------------------------------------------------------------

test('resolveCoordinatorChain lists each distinct coordinator nearest first', () => {
  let sessions = [
    session('P', { participants: ['z'], coordinatorAgentID: 'z' }),
    session('C', { parentSessionID: 'P', participants: ['c1'], coordinatorAgentID: 'c1' }),
    session('G', { parentSessionID: 'C', participants: ['x', 'y'] }),
  ];
  let byID = new Map(sessions.map((entry) => [ entry.id, entry ]));
  let getSession = (id) => byID.get(id) || null;

  let chain = resolveCoordinatorChain({ sessionID: 'G', getSession });
  assert.deepEqual(chain.chain.map((entry) => entry.agentID), [ 'c1', 'z' ]);
  assert.deepEqual(chain.chain.map((entry) => entry.sessionID), [ 'C', 'P' ]);
});

test('nearestAncestorCoordinator names the session that grants authority, for refusal text', () => {
  let { getSession } = makeTree();

  let found = nearestAncestorCoordinator({ sessionID: 'G', agentID: 'z', getSession });
  assert.equal(found.found, true);
  assert.equal(found.sessionID, 'P');

  let missing = nearestAncestorCoordinator({ sessionID: 'G', agentID: 'nobody', getSession });
  assert.equal(missing.found, false);
  assert.equal(missing.sessionID, null);
});

// ---------------------------------------------------------------------------
// Guard: this module must not import anything
// ---------------------------------------------------------------------------

test('coordinator-scope.mjs is pure: it imports nothing', async () => {
  let fs = await import('node:fs/promises');
  let source = await fs.readFile(new URL('../../../src/core/agents/coordinator-scope.mjs', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false, 'coordinator-scope.mjs gained an import; it must stay pure');
});
