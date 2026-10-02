'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClearCompactionBotCommand,
  ClearCoordinatorBotCommand,
  SetCompactionBotCommand,
  SetCoordinatorBotCommand,
} from '../../../src/core/commands/index.mjs';

test('/set-coordinator-bot assigns and reassigns the session coordinator', async () => {
  let session = createSession([ 'agent_1', 'agent_2' ]);
  let frameRuntime = createFrameRuntime(session);
  let services = createServices(frameRuntime, { Agent2: { id: 'agent_2', name: 'Agent Two' } });
  let command = new SetCoordinatorBotCommand();

  let first = await command.execute({ args: 'Agent2', frame: createFrame(), session, services });
  assert.equal(first.status, 'ok');
  assert.equal(session.coordinatorAgentID, 'agent_2');
  assert.deepEqual(frameRuntime.calls, [ { sessionID: 'ses_1', input: { coordinatorAgentID: 'agent_2' } } ]);

  let second = await command.execute({ args: 'Agent2', frame: createFrame(), session, services });
  assert.equal(second.status, 'ok');
  assert.equal(session.coordinatorAgentID, 'agent_2');
});

test('/set-compaction-bot assigns the session compaction bot', async () => {
  let session = createSession([ 'agent_1', 'agent_2' ]);
  let frameRuntime = createFrameRuntime(session);
  let services = createServices(frameRuntime, { Agent1: { id: 'agent_1', name: 'Agent One' } });
  let command = new SetCompactionBotCommand();

  let result = await command.execute({ args: 'Agent1', frame: createFrame(), session, services });

  assert.equal(result.status, 'ok');
  assert.match(result.message, /Compaction bot set to Agent One/);
  assert.equal(session.compactionAgentID, 'agent_1');
  assert.deepEqual(frameRuntime.calls, [ { sessionID: 'ses_1', input: { compactionAgentID: 'agent_1' } } ]);
});

test('/set-compaction-bot accepts quoted and spaced agent names', async () => {
  let session = createSession([ 'agent_1' ]);
  let frameRuntime = createFrameRuntime(session);
  let services = createServices(frameRuntime, { 'Mr. Bennett': { id: 'agent_1', name: 'Mr. Bennett' } });
  let command = new SetCompactionBotCommand();

  let result = await command.execute({ args: '"Mr. Bennett"', frame: createFrame(), session, services });

  assert.equal(result.status, 'ok');
  assert.equal(session.compactionAgentID, 'agent_1');
});

test('/clear-coordinator-bot clears the assignment and is idempotent', async () => {
  let session = createSession([ 'agent_1' ]);
  session.coordinatorAgentID = 'agent_1';
  let frameRuntime = createFrameRuntime(session);
  let services = createServices(frameRuntime, {});
  let command = new ClearCoordinatorBotCommand();

  let cleared = await command.execute({ frame: createFrame(), session, services });
  assert.equal(cleared.status, 'ok');
  assert.equal(session.coordinatorAgentID, null);
  assert.match(cleared.message, /Coordinator bot cleared/);

  let again = await command.execute({ frame: createFrame(), session, services });
  assert.equal(again.status, 'ok');
  assert.match(again.message, /No coordinator bot was set/);
  assert.equal(session.coordinatorAgentID, null);
});

test('/clear-compaction-bot clears an unset field with a clear message', async () => {
  let session = createSession([ 'agent_1' ]);
  let frameRuntime = createFrameRuntime(session);
  let services = createServices(frameRuntime, {});
  let command = new ClearCompactionBotCommand();

  let result = await command.execute({ frame: createFrame(), session, services });

  assert.equal(result.status, 'ok');
  assert.match(result.message, /No compaction bot was set/);
  assert.deepEqual(frameRuntime.calls, [ { sessionID: 'ses_1', input: { compactionAgentID: null } } ]);
});

test('argless set-* commands explain usage and never mutate session state', async () => {
  let cases = [
    [ new SetCoordinatorBotCommand(), 'coordinatorAgentID', '/set-coordinator-bot <agent>' ],
    [ new SetCompactionBotCommand(), 'compactionAgentID', '/set-compaction-bot <agent>' ],
  ];

  for (let [ command, field, usage ] of cases) {
    let session = createSession([ 'agent_1' ]);
    let frameRuntime = createFrameRuntime(session);
    let services = createServices(frameRuntime, {});
    let result = await command.execute({ args: '', frame: createFrame(), session, services });

    assert.equal(result.status, 'error');
    assert.equal(result.message, `Usage: ${usage}`);
    assert.equal(session[field], null);
    assert.deepEqual(frameRuntime.calls, []);
  }
});

test('/set-*-bot rejects a target that is not a session participant and lists the current ones', async () => {
  let session = createSession([ 'agent_1', 'agent_2' ]);
  let frameRuntime = createFrameRuntime(session);
  let services = createServices(frameRuntime, { Outsider: { id: 'agent_outsider', name: 'Outsider' } });
  let command = new SetCompactionBotCommand();

  await assert.rejects(
    () => command.execute({ args: 'Outsider', frame: createFrame(), session, services }),
    /must be a session participant: Outsider\. Current participants: agent_1, agent_2\./,
  );

  assert.equal(session.compactionAgentID, null);
  assert.deepEqual(frameRuntime.calls, []);
});

test('/set-*-bot rejects an unknown agent reference with a 404', async () => {
  let session = createSession([ 'agent_1' ]);
  let frameRuntime = createFrameRuntime(session);
  let services = createServices(frameRuntime, {});
  let command = new SetCompactionBotCommand();

  await assert.rejects(
    () => command.execute({ args: 'Ghost', frame: createFrame(), session, services }),
    (error) => error.status === 404 && /Agent not found/.test(error.message),
  );

  assert.deepEqual(frameRuntime.calls, []);
});

test('designation commands fall back to the runtime session when none is passed', async () => {
  let session = createSession([ 'agent_2' ]);
  let frameRuntime = createFrameRuntime(session);
  let services = createServices(frameRuntime, { Agent2: { id: 'agent_2', name: 'Agent Two' } });

  let result = await new SetCoordinatorBotCommand().execute({ args: 'Agent2', frame: createFrame(), services });

  assert.equal(result.status, 'ok');
  assert.equal(session.coordinatorAgentID, 'agent_2');
});

function createSession(participantAgentIDs) {
  return {
    id: 'ses_1',
    participantAgentIDs: participantAgentIDs.slice(),
    coordinatorAgentID: null,
    compactionAgentID: null,
  };
}

function createFrame() {
  return { id: 'msg_1', sessionID: 'ses_1' };
}

function createFrameRuntime(session) {
  let calls = [];
  return {
    calls,
    getSession() {
      return session;
    },
    async updateSession(sessionID, input) {
      calls.push({ sessionID, input });
      if (Object.hasOwn(input, 'coordinatorAgentID'))
        session.coordinatorAgentID = input.coordinatorAgentID;

      if (Object.hasOwn(input, 'compactionAgentID'))
        session.compactionAgentID = input.compactionAgentID;

      return session;
    },
  };
}

function createServices(frameRuntime, agentsByReference) {
  return {
    frameRuntime,
    agentManager: {
      async resolveAgent(reference) {
        let agent = agentsByReference[reference];
        if (!agent) {
          let error = new Error(`Agent not found: ${reference}`);
          error.status = 404;
          throw error;
        }

        return agent;
      },
    },
  };
}
