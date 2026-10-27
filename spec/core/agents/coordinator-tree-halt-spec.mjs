'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { CancelCommand } from '../../../src/core/commands/cancel-command.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { SessionControlTool } from '../../../src/core/tools/session-control-tool.mjs';
import { checkAgentCommandAuthority } from '../../../src/core/commands/slash-command-frame-plugin.mjs';
import {
  describeHaltResult,
  haltSessionTree,
  resolveHaltScope,
} from '../../../src/core/agents/coordinator-tree-halt.mjs';

// ---------------------------------------------------------------------------
// Three-level tree, real FrameRuntime
// ---------------------------------------------------------------------------
//
//   P (grandparent)  coordinator: z    z is NOT a participant of C or G
//   |- C (child)     participants: c1, c2      no coordinator
//   |- C2 (sibling)  participants: qx          no coordinator
//   |  `- G2 (grandchild of the sibling branch)
//   `- G (grandchild) participants: x, y       no coordinator
//
// These tests exercise the REAL runtime so "the run is frozen" is answered by
// runtime state (`getSessionSuspension`, `listActiveAgentRuns`), not by a mock of
// the module under test.

async function buildTree() {
  let aeordb = createMemoryClient();
  let runtime = new FrameRuntime({
    aeordb,
    clock: () => 1000,
    idGenerator: createIDGenerator([
      'P', 'C', 'C2', 'G', 'G2',
    ]),
  });

  await runtime.createSession({
    id: 'P',
    title: 'Grandparent',
    participantAgentIDs: [ 'z', 'p2' ],
    coordinatorAgentID: 'z',
  });
  await runtime.createSession({
    id: 'C',
    title: 'Child',
    parentSessionID: 'P',
    participantAgentIDs: [ 'c1', 'c2' ],
  });
  await runtime.createSession({
    id: 'C2',
    title: 'Sibling',
    parentSessionID: 'P',
    participantAgentIDs: [ 'qx' ],
  });
  await runtime.createSession({
    id: 'G',
    title: 'Grandchild',
    parentSessionID: 'C',
    participantAgentIDs: [ 'x', 'y' ],
  });
  await runtime.createSession({
    id: 'G2',
    title: 'Sibling grandchild',
    parentSessionID: 'C2',
    participantAgentIDs: [ 'r1' ],
  });

  return runtime;
}

/**
 * Put a real in-flight agent run in `sessionID` so the halt has something to
 * freeze. This drives the runtime's own bookkeeping rather than faking the
 * suspension flags, so `listActiveAgentRuns` and `cancelAgentRuns` are genuine.
 */
function startRun(runtime, sessionID, agentID) {
  let entry = runtime.sessions.get(sessionID);
  assert.ok(entry, `session ${sessionID} must exist`);
  entry.activeAgentRuns ||= new Map();
  entry.activeAgentRuns.set(agentID, { agentID, startedAt: Date.now() });
  return entry;
}

function isRunActive(runtime, sessionID, agentID) {
  return (runtime.listActiveAgentRuns?.(sessionID) || []).includes(agentID);
}

/**
 * Is the agent actually frozen? `cancelAgentRuns` does not delete the entry from
 * `activeAgentRuns` -- it sets a cancellation flag that a running loop polls, and
 * `suspendSession` records the agent in the suspension. The gates that a *new* tool
 * call or a *new* process consults are `isAgentSuspended`
 * (tool-execution-service.mjs:62, process-manager.mjs:105 and :169) and
 * `hasAgentCancellation`. Those are what "frozen" has to mean, so those are what
 * these tests measure.
 */
function isFrozen(runtime, sessionID, agentID) {
  return runtime.isAgentSuspended?.(sessionID, agentID) === true
    && runtime.hasAgentCancellation?.(sessionID, agentID) === true;
}

function suspensionOf(runtime, sessionID) {
  return runtime.getSessionSuspension?.(sessionID) || null;
}

// ---------------------------------------------------------------------------
// The core boundary: down works, up is refused
// ---------------------------------------------------------------------------

test('a coordinator halting a descendant actually freezes that session\'s agent', async () => {
  let runtime = await buildTree();

  // A real run in the grandchild, in a session z is not a participant of.
  startRun(runtime, 'G', 'x');
  assert.equal(isRunActive(runtime, 'G', 'x'), true, 'precondition: the run is live');
  assert.deepEqual(runtime.getSession('G').participantAgentIDs, [ 'x', 'y' ]);
  assert.equal(runtime.getSession('G').coordinatorAgentID, null);

  let result = await haltSessionTree({
    actorAgentID: 'z',
    targetSessionID: 'G',
    currentSessionID: 'P',
    includeSubtree: false,
    services: { frameRuntime: runtime },
  });

  assert.equal(result.allowed, true);

  // The freeze is measured on the gates the runtime consults, not on the returned
  // boolean and not on `activeAgentRuns` (which cancellation does not clear).
  assert.equal(isFrozen(runtime, 'G', 'x'), true,
    'x must be suspended AND cancelled in G, or a new tool call would still start');

  let suspension = suspensionOf(runtime, 'G');
  assert.ok(suspension, 'the grandchild session must now carry a suspension');
  assert.equal([ ...suspension.suspendedAgentIDs ].includes('x'), true);

  // Nothing was frozen in a session that was not named.
  assert.equal(isFrozen(runtime, 'C', 'c1'), false);
  assert.equal(suspensionOf(runtime, 'C'), null);
});

test('a coordinator halting an ancestor is refused, with a named reason', async () => {
  let runtime = await buildTree();

  // Give the child its own coordinator so the actor has authority that must stop
  // at the parent boundary rather than authority that does not exist at all.
  runtime.sessions.get('C').session.coordinatorAgentID = 'c1';
  startRun(runtime, 'P', 'p2');

  let result = await haltSessionTree({
    actorAgentID: 'c1',
    targetSessionID: 'P',
    currentSessionID: 'C',
    includeSubtree: true,
    services: { frameRuntime: runtime },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'not-coordinator');

  // The refusal names the reason and who does hold authority.
  assert.match(result.message, /Refused/);
  assert.match(result.message, /not the coordinator/);
  assert.match(result.message, /The coordinator responsible for P is z/);
  assert.match(result.message, /never a parent or a sibling branch/);

  // And nothing was frozen: the parent's run is still live and ungated.
  assert.equal(isRunActive(runtime, 'P', 'p2'), true, 'a refused halt must not touch the ancestor');
  assert.equal(isFrozen(runtime, 'P', 'p2'), false);
  assert.equal(suspensionOf(runtime, 'P'), null);
});

test('the grandchild coordinator cannot reach the sibling branch', async () => {
  let runtime = await buildTree();
  runtime.sessions.get('C').session.coordinatorAgentID = 'c1';
  startRun(runtime, 'G2', 'r1');

  let result = await haltSessionTree({
    actorAgentID: 'c1',
    targetSessionID: 'G2',
    currentSessionID: 'C',
    includeSubtree: true,
    services: { frameRuntime: runtime },
  });

  assert.equal(result.allowed, false);
  assert.equal(isRunActive(runtime, 'G2', 'r1'), true, 'the sibling branch must be untouched');
  assert.equal(isFrozen(runtime, 'G2', 'r1'), false);
});

// ---------------------------------------------------------------------------
// Subtree fan-out
// ---------------------------------------------------------------------------

test('halting a descendant fans out over the whole subtree beneath it', async () => {
  let runtime = await buildTree();
  startRun(runtime, 'C', 'c1');
  startRun(runtime, 'G', 'x');
  startRun(runtime, 'G', 'y');
  startRun(runtime, 'C2', 'qx'); // sibling of C: must NOT be reached

  let scope = await haltSessionTree({
    actorAgentID: 'z',
    targetSessionID: 'C',
    currentSessionID: 'P',
    includeSubtree: true,
    services: { frameRuntime: runtime },
  });

  assert.equal(scope.allowed, true);
  assert.deepEqual(scope.sessionIDs.slice().sort(), [ 'C', 'G' ], 'C and its descendant G, not the sibling C2');

  assert.equal(isFrozen(runtime, 'C', 'c1'), true);
  assert.equal(isFrozen(runtime, 'G', 'x'), true);
  assert.equal(isFrozen(runtime, 'G', 'y'), true);
  assert.equal(isFrozen(runtime, 'C2', 'qx'), false, 'sibling branch keeps running');

  // The summary names every session it reached.
  let message = describeHaltResult(scope);
  assert.match(message, /Suspended 3 active agents/);
  assert.match(message, /C \(c1\)/);
  assert.match(message, /G \(x, y\)/);
});

test('a halt that reaches a session with nothing running says so instead of claiming success', async () => {
  let runtime = await buildTree();

  // Nothing is running anywhere in the subtree.
  let result = await haltSessionTree({
    actorAgentID: 'z',
    targetSessionID: 'C',
    currentSessionID: 'P',
    includeSubtree: true,
    services: { frameRuntime: runtime },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(result.cancelled.map((entry) => entry.agentIDs), [ [], [] ]);
  assert.deepEqual(result.emptySessions.slice().sort(), [ 'C', 'G' ]);

  let message = describeHaltResult(result);
  assert.match(message, /No active runs in any of 2 sessions/);
  assert.equal(/Suspended \d+ active/.test(message), false, 'must not claim a suspension that did not happen');
});

test('a caller that cannot enumerate children is told the walk was incomplete', async () => {
  let runtime = await buildTree();

  // A runtime view with only a point lookup: no listSessions, no session cache.
  // This is the case where a subtree halt CANNOT be honest about its reach, and the
  // result must say so rather than report a one-session success as a subtree halt.
  let blindRuntime = {
    getSession: (id) => runtime.getSession(id),
  };

  let scope = await resolveHaltScope({
    actorAgentID: 'z',
    targetSessionID: 'C',
    currentSessionID: 'P',
    includeSubtree: true,
    frameRuntime: blindRuntime,
  });

  assert.equal(scope.allowed, true);
  assert.deepEqual(scope.sessionIDs, [ 'C' ]);
  assert.equal(scope.incomplete, true);
  assert.match(describeHaltResult({ ...scope, cancelled: [], emptySessions: [] }), /Only the named session was reached/);
});

// ---------------------------------------------------------------------------
// The two entry points reach the same implementation
// ---------------------------------------------------------------------------

test('session-control names a descendant session and freezes it', async () => {
  let runtime = await buildTree();
  startRun(runtime, 'G', 'x');

  let tool = new SessionControlTool({
    isCoordinator: true,
    agent: { id: 'z' },
    session: { id: 'P' },
    frameRuntime: runtime,
    agentManager: { async resolveAgent() { return null; }, async getAgent() { return null; } },
    processManager: { async suspendSession() { return []; } },
  });

  let result = await tool.execute({ action: 'suspend', sessionID: 'G', includeSubtree: false });
  assert.equal(result.allowed, true);
  assert.equal(isFrozen(runtime, 'G', 'x'), true, 'the named session\'s agent must be frozen');
  assert.equal(result.sessionIDs.includes('G'), true);
});

test('session-control refuses an ancestor session and names who holds authority', async () => {
  let runtime = await buildTree();
  runtime.sessions.get('C').session.coordinatorAgentID = 'c1';

  let tool = new SessionControlTool({
    isCoordinator: true,
    agent: { id: 'c1' },
    session: { id: 'C' },
    frameRuntime: runtime,
    agentManager: { async resolveAgent() { return null; }, async getAgent() { return null; } },
    processManager: { async suspendSession() { return []; } },
  });

  await assert.rejects(
    () => tool.execute({ action: 'suspend', sessionID: 'P' }),
    (error) => {
      assert.match(error.message, /session-control refused for P/);
      assert.match(error.message, /Its coordinator is z/);
      return true;
    },
  );
});

test('/halt session:<id> from a bot reaches into the named descendant', async () => {
  let runtime = await buildTree();
  startRun(runtime, 'G', 'x');

  let command = new CancelCommand({});
  let result = await command.execute({
    args: 'session:G',
    frame: { sessionID: 'P', authorType: 'agent', authorID: 'z' },
    services: {
      frameRuntime: runtime,
      agentManager: { async resolveAgent() { return null; } },
      processManager: { async suspendSession() { return []; } },
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(isFrozen(runtime, 'G', 'x'), true);
  assert.match(result.message, /Suspended 1 active agent/);
});

test('/halt session:<ancestor> from a bot is refused, and freezes nothing', async () => {
  let runtime = await buildTree();
  runtime.sessions.get('C').session.coordinatorAgentID = 'c1';
  startRun(runtime, 'P', 'p2');

  let command = new CancelCommand({});
  let result = await command.execute({
    args: 'session:P',
    frame: { sessionID: 'C', authorType: 'agent', authorID: 'c1' },
    services: {
      frameRuntime: runtime,
      agentManager: { async resolveAgent() { return null; } },
      processManager: { async suspendSession() { return []; } },
    },
  });

  assert.equal(result.status, 'error');
  assert.match(result.message, /Refused/);
  assert.equal(isRunActive(runtime, 'P', 'p2'), true);
  assert.equal(isFrozen(runtime, 'P', 'p2'), false);
});

test('a human /halt with no session argument keeps the original single-session behaviour', async () => {
  let runtime = await buildTree();
  let calls = [];
  startRun(runtime, 'P', 'p2');

  let command = new CancelCommand({});
  let result = await command.execute({
    args: '',
    frame: { sessionID: 'P', authorType: 'user' },
    services: {
      frameRuntime: {
        ...runtime,
        requireSessionEntry: (id) => runtime.sessions.get(id) || null,
        suspendSession: (id, options) => runtime.suspendSession(id, options),
        cancelAgentRuns: (id, agentID) => runtime.cancelAgentRuns(id, agentID),
        persistSessionSuspension: async () => {},
      },
      agentManager: { async resolveAgent() { return null; } },
      processManager: {
        async suspendSession(sessionID) {
          calls.push(sessionID);
          return [ 'proc_1' ];
        },
      },
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.message, 'Suspension requested for 1 active agent.');
  assert.deepEqual(calls, [ 'P' ]);
});

// ---------------------------------------------------------------------------
// G2: bot-authored slash commands
// ---------------------------------------------------------------------------

test('a bot may not type a non-halt command at all', () => {
  let gate = checkAgentCommandAuthority({
    parsed: { name: 'compact', args: '' },
    frame: { sessionID: 'P', authorType: 'agent', authorID: 'z' },
    context: { services: {} },
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.message, /not available to bots/);
});

test('a bot that coordinates nothing cannot type /halt; the coordinator of an ancestor can', async () => {
  let runtime = await buildTree();
  let context = { services: { frameRuntime: runtime } };

  // x is a participant of G but coordinates nothing.
  let denied = checkAgentCommandAuthority({
    parsed: { name: 'halt', args: '' },
    frame: { sessionID: 'G', authorType: 'agent', authorID: 'x' },
    context,
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.message, /does not coordinate/);

  // z coordinates the grandparent, so its authority reaches down to G.
  let allowed = checkAgentCommandAuthority({
    parsed: { name: 'halt', args: '' },
    frame: { sessionID: 'G', authorType: 'agent', authorID: 'z' },
    context,
  });
  assert.equal(allowed.allowed, true);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createMemoryClient() {
  return {
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
    async listDirectory() {
      return { items: [] };
    },
    async deleteFile(path) {
      this.files.delete(path);
      return true;
    },
    async searchFiles() {
      return [];
    },
  };
}

function createIDGenerator(ids) {
  let values = ids.slice();
  let index = 0;
  return () => values.shift() || `generated_${++index}`;
}

// ---------------------------------------------------------------------------
// F3: reach and run-targeting must agree, even when the runtime cache is cold
// ---------------------------------------------------------------------------
//
// `FrameRuntime.getSession` is cache-only (frame-runtime.mjs:227-229) and
// `evictOverflowSessionRuntimes` really does evict non-running sessions
// (frame-runtime.mjs:346-368). So a coordinator reaching into a descendant more
// than `sessionRuntimeLimit` sessions away sees `null` through a plain
// `getSession` lookup. That is the "stop reports success over a live run" failure
// in its natural habitat: the descendant is never walked, so nothing is frozen.

test('coordinator authority over a descendant survives that descendant being evicted', async () => {
  let runtime = await buildTree();

  runtime.evictSession('G');
  assert.equal(runtime.getSession('G'), null, 'precondition: G is not in the runtime cache');

  let scope = await resolveHaltScope({
    actorAgentID: 'z',
    targetSessionID: 'G',
    currentSessionID: 'P',
    includeSubtree: false,
    frameRuntime: runtime,
  });

  assert.equal(scope.allowed, true,
    'evicting a descendant runtime must not revoke the coordinator\'s authority over it');
});

test('halting an evicted descendant records a suspension that survives the reload', async () => {
  let runtime = await buildTree();

  startRun(runtime, 'G', 'x');
  runtime.evictSession('G');
  assert.equal(runtime.getSession('G'), null, 'precondition: G is not in the runtime cache');

  let result = await haltSessionTree({
    actorAgentID: 'z',
    targetSessionID: 'G',
    currentSessionID: 'P',
    includeSubtree: false,
    services: { frameRuntime: runtime },
  });

  assert.equal(result.allowed, true);

  // The proof that the halt was real rather than skipped: bring the session back
  // and check the gate a fresh tool call would consult.
  await runtime.ensureSessionEntry('G');
  assert.equal(runtime.isAgentSuspended('G', 'x'), true,
    'a cold descendant must come back suspended; otherwise the halt skipped it and a later run is live');
});
