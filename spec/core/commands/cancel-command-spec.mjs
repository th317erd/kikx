'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { suspendSessionAgents } from '../../../src/core/agents/agent-cancellation.mjs';
import { CancelCommand } from '../../../src/core/commands/cancel-command.mjs';
import { CommandRegistry } from '../../../src/core/commands/command-registry.mjs';

test('CancelCommand cancels all active runs by default', async () => {
  let calls = [];
  let command = new CancelCommand({});
  let result = await command.execute({
    args: '',
    frame: { sessionID: 's1' },
    services: {
      frameRuntime: {
        cancelAgentRuns(sessionID, targetAgentID) {
          calls.push({ sessionID, targetAgentID });
          return [ 'agent_1', 'agent_2' ];
        },
      },
      agentManager: {
        async resolveAgent() { throw new Error('should not resolve without a target'); },
      },
    },
  });

  assert.deepEqual(calls, [ { sessionID: 's1', targetAgentID: null } ]);
  assert.equal(result.data.count, 2);
  assert.match(result.message, /2 active agents/);
});

test('CancelCommand resolves a named target before cancelling', async () => {
  let calls = [];
  let command = new CancelCommand({});
  let result = await command.execute({
    args: 'Zav',
    frame: { sessionID: 's1' },
    services: {
      frameRuntime: {
        cancelAgentRuns(sessionID, targetAgentID) {
          calls.push({ sessionID, targetAgentID });
          return [ targetAgentID ];
        },
      },
      agentManager: {
        async resolveAgent(reference) {
          assert.equal(reference, 'Zav');
          return { id: 'agent_zav', name: 'Zav' };
        },
      },
    },
  });

  assert.deepEqual(calls, [ { sessionID: 's1', targetAgentID: 'agent_zav' } ]);
  assert.equal(result.data.count, 1);
  assert.match(result.message, /Zav/);
});

test('CancelCommand uses invite-compatible quoted and agent: target parsing', async () => {
  let seen = [];
  let command = new CancelCommand({});
  let services = {
    frameRuntime: {
      cancelAgentRuns(_sessionID, targetAgentID) {
        seen.push(targetAgentID);
        return [ targetAgentID ];
      },
    },
    agentManager: {
      async resolveAgent(reference) {
        seen.push(reference);
        return { id: 'agent_zav', name: reference };
      },
    },
  };

  await command.execute({ args: '"Zav Bot"', frame: { sessionID: 's1' }, services });
  assert.deepEqual(seen.splice(0), [ 'Zav Bot', 'agent_zav' ]);

  await command.execute({ args: 'agent:Zav', frame: { sessionID: 's1' }, services });
  assert.deepEqual(seen.splice(0), [ 'Zav', 'agent_zav' ]);
});

test('CancelCommand rejects a team target with a clear error', async () => {
  let command = new CancelCommand({});
  await assert.rejects(
    () => command.execute({
      args: 'team:Ops',
      frame: { sessionID: 's1' },
      services: {
        frameRuntime: { cancelAgentRuns() { return []; } },
        agentManager: { async resolveAgent() { return null; } },
      },
    }),
    /can only target an agent/,
  );
});

test('/stop and /halt are registered aliases of /cancel', () => {
  let registry = new CommandRegistry({ logger: { warn() {} } });
  registry.registerCommand('cancel', CancelCommand, { aliases: CancelCommand.aliases });

  assert.equal(registry.getCommand('stop')?.CommandClass, CancelCommand);
  assert.equal(registry.getCommand('suspend')?.CommandClass, CancelCommand);
  assert.equal(registry.getCommand('halt')?.CommandClass, CancelCommand);
  assert.equal(registry.getCommand('stop')?.name, 'cancel');
});

test('a cancellation request writes one red historical suspension notice', async () => {
  let merged = [];
  let flushed = 0;
  let result = await suspendSessionAgents({
    sessionID: 's1',
    target: null,
    agentManager: null,
    frameRuntime: {
      cancelAgentRuns() { return [ 'agent_1', 'agent_2' ]; },
      requireSessionEntry() {
        return {
          session: { participantAgentIDs: [ 'agent_1', 'agent_2' ], coordinatorAgentID: 'agent_1' },
          frameEngine: {
            idGenerator() { return 'suspension_frame_1'; },
            merge(frames, options) { merged.push({ frames, options }); },
          },
        };
      },
      frameStore: { async flush() { flushed += 1; } },
    },
  });

  assert.equal(result.count, 2);
  assert.equal(result.suspensionFrameID, 'suspension_frame_1');
  assert.equal(flushed, 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].options.silent, true);
  assert.equal(merged[0].frames[0].type, 'AgentMessage');
  assert.equal(merged[0].frames[0].authorType, 'system');
  assert.match(merged[0].frames[0].content.text, /^User Suspended the Session/);
  assert.equal(merged[0].frames[0].content.status, 'error');
  assert.deepEqual(merged[0].frames[0].content.suspendedAgentIDs, [ 'agent_1', 'agent_2' ]);
});

test('cancellation suspends every participant and its running commands', async () => {
  let suspensionCalls = [];
  let suspendCalls = [];
  let result = await suspendSessionAgents({
    sessionID: 's1',
    target: null,
    agentManager: null,
    frameRuntime: {
      suspendSession(sessionID, options) {
        suspensionCalls.push({ sessionID, options });
        return true;
      },
      cancelAgentRuns() { return [ 'agent_1' ]; },
      requireSessionEntry() {
        return {
          session: { participantAgentIDs: [ 'agent_1', 'agent_2' ], coordinatorAgentID: 'agent_1' },
          frameEngine: {
            idGenerator() { return 'suspension_frame_2'; },
            merge() {},
          },
        };
      },
      frameStore: { async flush() {} },
    },
    processManager: {
      async suspendSession(sessionID, options) {
        suspendCalls.push({ sessionID, options });
        return [ 'proc_1', 'proc_2' ];
      },
    },
  });

  assert.deepEqual(suspensionCalls, [{
    sessionID: 's1',
    options: {
      agentIDs: [ 'agent_1', 'agent_2' ],
      coordinatorAgentID: 'agent_1',
      userID: null,
      reason: 'user-suspend',
    },
  }]);
  assert.deepEqual(suspendCalls, [{ sessionID: 's1', options: { agentID: null } }]);
  assert.deepEqual(result.suspendedAgentIDs, [ 'agent_1', 'agent_2' ]);
  assert.deepEqual(result.suspendedCommandIDs, [ 'proc_1', 'proc_2' ]);
});
