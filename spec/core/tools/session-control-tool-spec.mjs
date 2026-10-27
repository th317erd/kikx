'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionControlTool } from '../../../src/core/tools/session-control-tool.mjs';

function createContext({ isCoordinator = true, sessionSuspended = true, suspendedAgentIDs = [ 'agent_2' ], sessionTitle = 'Session One' } = {}) {
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
    async ensureSessionEntry(sessionID) {
      return {
        session: {
          id: sessionID,
          title: sessionTitle,
          participantAgentIDs: [ 'agent_1', 'agent_2' ],
          coordinatorAgentID: 'agent_1',
        },
      };
    },
    listActiveAgentRuns() {
      return [ ...state.active ];
    },
    resumeAgent(sessionID, agentID) {
      calls.push({ method: 'resumeAgent', sessionID, agentID });
      return state.suspended.delete(agentID);
    },
    suspendAgent(sessionID, agentID) {
      calls.push({ method: 'suspendAgent', sessionID, agentID });
      state.suspended.add(agentID);
      return true;
    },
    cancelAgentRuns(sessionID, agentID) {
      calls.push({ method: 'cancelAgentRuns', sessionID, agentID });
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
    { method: 'resumeAgent', sessionID: 'ses_1', agentID: 'agent_2' },
    { method: 'suspendAgent', sessionID: 'ses_1', agentID: 'agent_2' },
    { method: 'cancelAgentRuns', sessionID: 'ses_1', agentID: 'agent_2' },
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


test('session-control can target a descendant session and reports it', async () => {
  let calls = [];
  let sessions = new Map([
    [ 'ses_root', { id: 'ses_root', title: 'Root', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' } ],
    [ 'ses_child', { id: 'ses_child', title: 'Child', parentSessionID: 'ses_root', participantAgentIDs: [ 'agent_1', 'agent_2' ], coordinatorAgentID: 'agent_2' } ],
    [ 'ses_unrelated', { id: 'ses_unrelated', title: 'Unrelated', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' } ],
  ]);
  let frameRuntime = {
    async ensureSessionEntry(sessionID) {
      let session = sessions.get(sessionID);
      if (!session) {
        let error = new Error(`Unknown session: ${sessionID}`);
        error.status = 404;
        throw error;
      }
      return { session };
    },
    getSessionSuspension() { return null; },
    listActiveAgentRuns() { return []; },
    suspendAgent(sessionID, agentID) { calls.push({ method: 'suspendAgent', sessionID, agentID }); },
    cancelAgentRuns(sessionID, agentID) { calls.push({ method: 'cancelAgentRuns', sessionID, agentID }); },
    async persistSessionSuspension(sessionID) { calls.push({ method: 'persistSessionSuspension', sessionID }); },
  };
  let agentManager = {
    async resolveAgent(reference) { return { id: reference, name: reference }; },
    async getAgent(agentID) { return { id: agentID, name: agentID }; },
  };
  let processManager = {
    async suspendSession(sessionID, options) {
      calls.push({ method: 'suspendSession', sessionID, options });
      return [ 'proc_child' ];
    },
  };
  let context = {
    isCoordinator: true,
    session: { id: 'ses_root', title: 'Root' },
    frameRuntime,
    agentManager,
    processManager,
  };
  let tool = new SessionControlTool(context);

  let suspended = await tool.execute({ action: 'suspend', target: 'agent_2', session_id: 'ses_child' });
  assert.equal(suspended.sessionID, 'ses_child');
  assert.equal(suspended.sessionTitle, 'Child');
  assert.deepEqual(suspended.suspendedCommandIDs, [ 'proc_child' ]);
  assert.deepEqual(calls, [
    { method: 'suspendAgent', sessionID: 'ses_child', agentID: 'agent_2' },
    { method: 'cancelAgentRuns', sessionID: 'ses_child', agentID: 'agent_2' },
    { method: 'suspendSession', sessionID: 'ses_child', options: { agentID: 'agent_2' } },
    { method: 'persistSessionSuspension', sessionID: 'ses_child' },
  ]);

  await assert.rejects(
    () => tool.execute({ action: 'list', session_id: 'ses_unrelated' }),
    /current session or one of its descendants/,
  );
});

test('session-control cannot reach up into the parent session', async () => {
  let sessions = new Map([
    [ 'ses_parent', { id: 'ses_parent', title: 'Parent', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' } ],
    [ 'ses_child', { id: 'ses_child', title: 'Child', parentSessionID: 'ses_parent', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' } ],
  ]);
  let context = {
    isCoordinator: true,
    session: { id: 'ses_child', title: 'Child' },
    frameRuntime: {
      async ensureSessionEntry(sessionID) { return { session: sessions.get(sessionID) }; },
      getSessionSuspension() { return null; },
      listActiveAgentRuns() { return []; },
    },
    agentManager: { async getAgent(agentID) { return { id: agentID, name: agentID }; } },
  };
  let tool = new SessionControlTool(context);
  await assert.rejects(
    () => tool.execute({ action: 'list', session_id: 'ses_parent' }),
    /current session or one of its descendants/,
  );
});
