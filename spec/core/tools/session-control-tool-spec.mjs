'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionControlTool } from '../../../src/core/tools/session-control-tool.mjs';

function createContext({ isCoordinator = true, sessionSuspended = true, suspendedAgentIDs = [ 'agent_2' ] } = {}) {
  let calls = [];
  let state = {
    sessionSuspended,
    suspended: new Set(suspendedAgentIDs),
    active: new Set([ 'agent_2' ]),
  };
  let frameRuntime = {
    getSessionSuspension() {
      return state.sessionSuspended
        ? { active: true, coordinatorAgentID: 'agent_1', suspendedAgentIDs: [ ...state.suspended ] }
        : null;
    },
    requireSessionEntry() {
      return {
        session: {
          participantAgentIDs: [ 'agent_1', 'agent_2' ],
          coordinatorAgentID: 'agent_1',
        },
      };
    },
    listActiveAgentRuns() {
      return [ ...state.active ];
    },
    resumeAgent(_sessionID, agentID) {
      calls.push({ method: 'resumeAgent', agentID });
      return state.suspended.delete(agentID);
    },
    suspendAgent(_sessionID, agentID) {
      calls.push({ method: 'suspendAgent', agentID });
      state.suspended.add(agentID);
      return true;
    },
    cancelAgentRuns(_sessionID, agentID) {
      calls.push({ method: 'cancelAgentRuns', agentID });
      return [ agentID ];
    },
  };
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Coordinator' } ],
    [ 'agent_2', { id: 'agent_2', name: 'Worker' } ],
  ]);
  let agentManager = {
    async getAgent(agentID) { return agents.get(agentID) || null; },
    async resolveAgent(reference) { return agents.get(reference) || null; },
  };
  let processManager = {
    async suspendSession(sessionID, options) {
      calls.push({ method: 'suspendSession', sessionID, options });
      return [ 'proc_1' ];
    },
  };
  return {
    calls,
    context: {
      isCoordinator,
      session: { id: 'ses_1' },
      frameRuntime,
      agentManager,
      processManager,
    },
  };
}

test('session-control lists the coordinator and suspended agents', async () => {
  let { context } = createContext();
  let tool = new SessionControlTool(context);
  let result = await tool.execute({ action: 'list' });

  assert.equal(result.sessionSuspended, true);
  assert.equal(result.coordinatorAgentID, 'agent_1');
  assert.deepEqual(result.suspendedAgentIDs, [ 'agent_2' ]);
  assert.deepEqual(result.agents.map((agent) => ({
    id: agent.agentID,
    coordinator: agent.coordinator,
    suspended: agent.suspended,
    active: agent.activeRun,
  })), [
    { id: 'agent_1', coordinator: true, suspended: false, active: false },
    { id: 'agent_2', coordinator: false, suspended: true, active: true },
  ]);
});

test('session-control resumes and suspends another agent', async () => {
  let { context, calls } = createContext();
  let tool = new SessionControlTool(context);

  let resumed = await tool.execute({ action: 'resume', target: 'agent_2' });
  assert.equal(resumed.resumed, true);
  let suspended = await tool.execute({ action: 'suspend', target: 'agent_2' });
  assert.equal(suspended.suspended, true);
  assert.deepEqual(suspended.suspendedCommandIDs, [ 'proc_1' ]);
  assert.deepEqual(calls, [
    { method: 'resumeAgent', agentID: 'agent_2' },
    { method: 'suspendAgent', agentID: 'agent_2' },
    { method: 'cancelAgentRuns', agentID: 'agent_2' },
    { method: 'suspendSession', sessionID: 'ses_1', options: { agentID: 'agent_2' } },
  ]);
});

test('session-control is coordinator-only', async () => {
  let { context } = createContext({ isCoordinator: false });
  let tool = new SessionControlTool(context);
  await assert.rejects(
    () => tool.execute({ action: 'list' }),
    /only available to the session coordinator/,
  );
});
