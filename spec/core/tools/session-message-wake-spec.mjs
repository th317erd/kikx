'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { SessionMessageTool } from '../../../src/core/tools/session-tools.mjs';
import {
  isCoordinationWakeFrame,
  isThreadVisibleFrame,
} from '../../../src/shared/coordination-visibility.mjs';

// WHY THIS SPEC EXISTS
//
// The owner's report was "I would have liked to see Zav messaging this bot, and
// what instructions were given." The first fix surfaced the INVITE wake, which
// proves a bot arrived but says nothing about what it was told.
//
// Underneath that display gap was a worse one: `session-message` could not start
// anyone. `_execute` called `postAgentSessionMessage` and returned — no wake, and
// no field in the result that could reveal a wake never happened. A coordinator
// posting "your assignment is X" saw `posted: true` and had no way to learn that
// no bot ever read it. This spec pins the wake, and pins that the same message is
// the visible coordination card, because a worker appearing with an instruction
// nobody can see is the original complaint.

function createClient() {
  let files = new Map();
  return {
    files,
    async putFile(path, body) {
      files.set(path, body);
      return { path };
    },
    async getFile(path) {
      return files.get(path) || null;
    },
    async listDirectory() {
      return { items: [] };
    },
  };
}

function createRuntime() {
  // The session takes the first generated id, so it must be handed out here
  // rather than assumed. Guessing 'ses_1' is what made the first draft of this
  // spec fail with "Unknown session", which was a harness bug and not a
  // product one.
  let ids = [ 'ses_1' ];
  let index = 0;
  let idGenerator = () => ids[index++] || `id_${index}`;

  return new FrameRuntime({
    aeordb: createClient(),
    clock: () => 1000,
    runnerID: 'runtime',
    idGenerator,
  });
}

// The mention resolver is handed `context.services`, so a fake there is how a
// test resolves `@name` without a live agent registry. It is a stand-in for the
// registry, NOT for anything under test: the code path from mention text to
// wakeAgentInSession is the production one.
function createAgentManager() {
  let agents = [
    { id: 'worker', name: 'Kikx-Node-Eng' },
    { id: 'other', name: 'Kikx-Test-Eng' },
  ];
  // A mention carries the NAME the author typed (`@Kikx-Node-Eng`), not an id,
  // so lookup must accept either. Keying this fake by id alone is what made the
  // first draft of this spec resolve nobody.
  let find = (ref) => agents.find((agent) => agent.id === ref || agent.name === ref) || null;
  return {
    async resolveAgent(ref) {
      return find(ref);
    },
    async getAgent(ref) {
      return find(ref);
    },
    async findAgentByIDOrName(ref) {
      return find(ref);
    },
    async listAgents() {
      return [ ...agents ];
    },
  };
}

async function createSession(runtime, overrides = {}) {
  let created = await runtime.createSession({
    title: 'Visibility',
    participantAgentIDs: [ 'coordinator', 'worker', 'other' ],
    coordinatorAgentID: 'coordinator',
    ...overrides,
  });
  // Take the id the runtime actually assigned, so a change to how sessions are
  // named cannot silently turn every test into a 404.
  let sessionID = created?.id || created?.session?.id;
  assert.ok(sessionID, 'the runtime returned a session id');
  return sessionID;
}

function createTool(runtime, extra = {}) {
  return new SessionMessageTool({
    frameRuntime: runtime,
    agentManager: createAgentManager(),
    agent: { id: 'coordinator', name: 'Zav' },
    session: { id: 'ses_1' },
    ...extra,
  });
}

test('session-message without wake posts and starts nobody', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime);
  let tool = createTool(runtime);

  let result = await tool._execute({
    session_id: sessionID,
    text: '@Kikx-Node-Eng please start on the brief',
  });

  assert.equal(result.posted, true, 'the message is still posted');
  assert.equal(result.wake, undefined, 'no wake field when wake was not asked for');
  assert.equal(result.wokeAgentIDs, undefined, 'and nobody is reported as woken');
});

test('session-message with wake starts the mentioned agent with that exact text', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime);
  let tool = createTool(runtime);

  let text = '@Kikx-Node-Eng wire the sidebar scope seam';
  let result = await tool._execute({ session_id: sessionID, text, wake: true });

  assert.equal(result.wake, true);
  assert.deepEqual(result.wokeAgentIDs, [ 'worker' ], 'the mentioned agent is the one woken');
  assert.equal(result.wokeFrameIDs.length, 1);

  // The wake is a REAL frame in the runtime, not a reported intention.
  let entry = await runtime.ensureSessionEntry(sessionID);
  let wake = entry.frameEngine.get(result.wokeFrameIDs[0]);
  assert.ok(wake, 'the wake frame exists in the session');
  assert.equal(wake.targetAgentID, 'worker', 'the wake is directed at the worker, not broadcast');
  assert.equal(wake.hidden, true, 'the wake stays hidden so it does not enter model context');
  assert.equal(wake.content.text, text, 'the instruction is the text a person saw posted');
});

test('the posted instruction is visible to a person and names the recipient', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime);
  let tool = createTool(runtime);

  let result = await tool._execute({
    session_id: sessionID,
    text: '@Kikx-Node-Eng wire the sidebar scope seam',
    wake: true,
  });

  // A single addressee is recorded structurally, which is what the card header
  // reads to say who was told.
  assert.equal(result.frame.targetAgentID, 'worker', 'the posted message names its addressee');

  // And the wake itself passes the production visibility predicate, so the
  // instruction shows in the thread instead of only in the store.
  let entry = await runtime.ensureSessionEntry(sessionID);
  let wake = entry.frameEngine.get(result.wokeFrameIDs[0]);
  assert.equal(isCoordinationWakeFrame(wake), true, 'the wake is a coordination frame');
  assert.equal(isThreadVisibleFrame(wake), true, 'and a person may see it');
});

test('a suspended agent is skipped, not woken, and says so', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime);
  runtime.suspendAgent(sessionID, 'worker');
  assert.equal(runtime.isAgentSuspended(sessionID, 'worker'), true, 'precondition: the worker is frozen');

  let tool = createTool(runtime);
  let result = await tool._execute({
    session_id: sessionID,
    text: '@Kikx-Node-Eng start now',
    wake: true,
  });

  assert.deepEqual(result.wokeAgentIDs, [], 'a STOP is not undone by somebody mentioning the agent');
  assert.deepEqual(
    result.skippedWake,
    [ { agentID: 'worker', reason: 'suspended' } ],
    'the refusal is named, so it cannot look like a successful wake',
  );
});

test('resumeSuspended is the only way a wake clears a halt', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime);
  runtime.suspendAgent(sessionID, 'worker');

  let tool = createTool(runtime);
  let result = await tool._execute({
    session_id: sessionID,
    text: '@Kikx-Node-Eng start now',
    wake: true,
    resumeSuspended: true,
  });

  assert.deepEqual(result.wokeAgentIDs, [ 'worker' ], 'an explicit resume allows the wake');
  assert.equal(runtime.isAgentSuspended(sessionID, 'worker'), false, 'and the halt is genuinely cleared');
});

test('a mentioned non-participant is reported, not silently woken', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime, {
    participantAgentIDs: [ 'coordinator' ],
    coordinatorAgentID: 'coordinator',
  });

  let tool = createTool(runtime);
  let result = await tool._execute({
    session_id: sessionID,
    text: '@Kikx-Node-Eng do the thing',
    wake: true,
  });

  assert.deepEqual(result.wokeAgentIDs, []);
  assert.deepEqual(
    result.skippedWake,
    [ { agentID: 'worker', reason: 'not-participant' } ],
    'waking an outsider would write a turn it cannot read, so it is refused by name',
  );
});

test('a message to nobody wakes nobody instead of guessing a target', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime);
  let tool = createTool(runtime);

  let result = await tool._execute({
    session_id: sessionID,
    text: 'the build is green',
    wake: true,
  });

  assert.deepEqual(result.wokeAgentIDs, [], 'no mention, nobody started');
  assert.deepEqual(result.skippedWake, []);
  assert.equal(result.frame.targetAgentID, undefined, 'and no arbitrary recipient is invented');
});

test('an agent mentioning itself does not re-enter its own run', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime, {
    participantAgentIDs: [ 'coordinator' ],
    coordinatorAgentID: 'coordinator',
  });

  let tool = createTool(runtime, { agent: { id: 'worker', name: 'Kikx-Node-Eng' } });
  let result = await tool._execute({
    session_id: sessionID,
    text: '@Kikx-Node-Eng note to self',
    wake: true,
  });

  assert.deepEqual(result.wokeAgentIDs, [], 'an agent cannot wake itself into a second run');
  // No skippedWake entry, and that is the correct shape: the sender is removed by
  // `resolveSessionMessageWakeTargets` before any wake decision is made, so it is
  // never a CANDIDATE that got refused. Claiming a refusal here would mean the
  // tool considered waking its own author, which is what must not happen.
  assert.deepEqual(result.skippedWake, [], 'the author is not a refused target, it is not a target');
  assert.equal(result.frame.targetAgentID, undefined, 'and no self-addressed target is written');
});

test('a broadcast with several recipients wakes each one once', async () => {
  let runtime = createRuntime();
  let sessionID = await createSession(runtime);
  let tool = createTool(runtime);

  let result = await tool._execute({
    session_id: sessionID,
    text: '@Kikx-Node-Eng and @Kikx-Test-Eng both start, and @Kikx-Node-Eng again',
    wake: true,
  });

  assert.deepEqual(result.wokeAgentIDs.sort(), [ 'other', 'worker' ], 'each recipient is woken exactly once');
  assert.equal(result.wokeFrameIDs.length, 2, 'one wake frame per recipient');
  assert.equal(
    result.frame.targetAgentID,
    undefined,
    'a broadcast stays a broadcast: no single addressee is claimed',
  );
});

test('the tool advertises wake and resumeSuspended, and warns that posting starts nobody', () => {
  let schema = SessionMessageTool.inputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), [ 'resumeSuspended', 'text', 'wake' ]);
  assert.deepEqual(schema.required, [ 'text' ], 'wake is opt-in, so existing calls keep working');
  assert.match(schema.properties.wake.description, /only posts/i);
  assert.match(SessionMessageTool.help, /posting does not start anyone/i);
});
