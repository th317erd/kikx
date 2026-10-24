'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../src/core/runtime/frame-runtime.mjs';

// A minimal fake for the client interface FrameRuntime needs. Deliberately
// small: these tests care about suspension bookkeeping, not persistence.
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

function createRuntime(options = {}) {
  let ids = options.ids || [ 'ses_1' ];
  let index = 0;

  return new FrameRuntime({
    aeordb: options.aeordb || createClient(),
    clock: () => options.now || 1000,
    runnerID: 'runtime',
    idGenerator: () => ids[index++],
  });
}

// The owner found this by pressing STOP and then inviting a bot: the session
// reported sessionSuspended: true, the four existing members reported
// suspended: true, and the newly invited member reported suspended: false.
// Suspend is applied to whoever is present at press time and was never applied
// to later joiners, so a bot invited into a halted session could be woken and
// run inside it. This is the regression guard for that hole.
test('a bot invited into a suspended session is frozen, not live', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  await runtime.createSession({
    title: 'Halted',
    participantAgentIDs: [ 'coordinator', 'worker' ],
    coordinatorAgentID: 'coordinator',
  });

  runtime.suspendSession('ses_1', {
    agentIDs: [ 'coordinator', 'worker' ],
    coordinatorAgentID: 'coordinator',
  });

  let result = await runtime.inviteAgentToSession('ses_1', { id: 'latecomer' });
  assert.equal(result.alreadyParticipant, false);

  // The whole point: the invite succeeded, but the invitee cannot run.
  assert.equal(
    runtime.isAgentSuspended('ses_1', 'latecomer'),
    true,
    'an agent invited into a suspended session must inherit the suspension',
  );

  // And the earlier members are untouched — the fix must not resume anyone.
  assert.equal(runtime.isAgentSuspended('ses_1', 'coordinator'), true);
  assert.equal(runtime.isAgentSuspended('ses_1', 'worker'), true);
});

test('a bot invited into a running session is live', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  await runtime.createSession({
    title: 'Running',
    participantAgentIDs: [ 'coordinator' ],
    coordinatorAgentID: 'coordinator',
  });

  await runtime.inviteAgentToSession('ses_1', { id: 'latecomer' });

  assert.equal(runtime.isSessionSuspended('ses_1'), false);
  assert.equal(
    runtime.isAgentSuspended('ses_1', 'latecomer'),
    false,
    'the fix must not freeze invitations when nothing is suspended',
  );
});

test('re-inviting an existing participant does not resurrect a suspended agent', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  await runtime.createSession({
    title: 'Halted',
    participantAgentIDs: [ 'coordinator', 'worker' ],
    coordinatorAgentID: 'coordinator',
  });

  runtime.suspendSession('ses_1', {
    agentIDs: [ 'coordinator', 'worker' ],
    coordinatorAgentID: 'coordinator',
  });

  let result = await runtime.inviteAgentToSession('ses_1', { id: 'worker' });
  assert.equal(result.alreadyParticipant, true);

  // A re-invite is not an un-halt. Only session-control resume clears it.
  assert.equal(
    runtime.isAgentSuspended('ses_1', 'worker'),
    true,
    're-inviting a member must not be a way to unfreeze it',
  );
});

test('an agent invited while suspended is released by an explicit resume', async () => {
  let runtime = createRuntime({ ids: [ 'ses_1' ] });
  await runtime.createSession({
    title: 'Halted',
    participantAgentIDs: [ 'coordinator' ],
    coordinatorAgentID: 'coordinator',
  });

  runtime.suspendSession('ses_1', {
    agentIDs: [ 'coordinator' ],
    coordinatorAgentID: 'coordinator',
  });

  await runtime.inviteAgentToSession('ses_1', { id: 'latecomer' });
  assert.equal(runtime.isAgentSuspended('ses_1', 'latecomer'), true);

  // The un-halt path the owner described must still work on a late invitee,
  // and must hand it the same recovery warning a normal member gets.
  runtime.resumeAgent('ses_1', 'latecomer');
  assert.equal(runtime.isAgentSuspended('ses_1', 'latecomer'), false);

  let warning = runtime.consumeAgentSuspensionWarning('ses_1', 'latecomer');
  assert.ok(warning, 'a released latecomer must be told it was suspended');
  assert.match(warning.message, /explicitly resumed by the coordinator/i);
});
