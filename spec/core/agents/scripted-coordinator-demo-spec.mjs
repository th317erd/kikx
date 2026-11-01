'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStartBrief } from '../../../src/core/plugins/agent-brief-template.mjs';
import { AgentRouteFramePluginBase } from '../../../src/core/agents/agent-route/agent-route-frame-plugin-base.mjs';
import { canContinueWithCurrentBudget } from '../../../src/core/runtime/autonomous-chain.mjs';
import { getBehaviorScript } from '../../../src/core/scripts/script-registry.mjs';
import { createLoopTools } from '../../../src/core/plugins/agent-loop-tools.mjs';
import { createLoopState } from '../../../src/core/plugins/agent-loop-state.mjs';
import { notifyCoordinatorOfEndTurn } from '../../../src/core/agents/end-turn-notification.mjs';
import { checkAgentMutationAllowed } from '../../../src/core/agents/mutation-authority.mjs';

function runtimeFor(sessions) {
  let byID = new Map(sessions.map((session) => [ session.id, session ]));
  return {
    async ensureSessionEntry(id) {
      return { session: byID.get(id) || null };
    },
    getSession(id) {
      return byID.get(id) || null;
    },
  };
}

function createPluginHarness(frames) {
  let nextID = 0;
  let plugin = Object.create(AgentRouteFramePluginBase.prototype);
  plugin.context = {
    engine: {
      get: (id) => frames.get(id) || null,
      idGenerator: () => `frame_${++nextID}`,
      merge: (list) => {
        for (let frame of list)
          frames.set(frame.id, frame);
        return list;
      },
    },
    services: {},
  };
  plugin.clock = () => 2_000_000;
  plugin.postAutonomousPauseNotice = () => {};
  return plugin;
}

test('acceptance demo: scripted coordinator drives a multi-turn loop to task-complete', async () => {
  const coordinator = {
    id: 'coord-1',
    name: 'Coord',
    behaviorScript: getBehaviorScript('coordinator-loop').script,
  };
  const worker = {
    id: 'worker-1',
    name: 'Worker',
    behaviorScript: getBehaviorScript('engineer').script,
  };

  const briefOptions = { pluginRegistry: { listPromptSections: () => [] } };
  let coordinatorBrief = buildStartBrief({ agent: coordinator, ...briefOptions });
  let workerBrief = buildStartBrief({ agent: worker, ...briefOptions });
  assert.match(coordinatorBrief.text, /SCRIPT coordinator_loop/);
  assert.match(coordinatorBrief.text, /AGIS EXECUTOR PREAMBLE/);
  assert.match(workerBrief.text, /SCRIPT engineer_loop/);

  const sessions = [
    {
      id: 'child',
      parentSessionID: 'root',
      participantAgentIDs: [ 'worker-1', 'coord-1' ],
      coordinatorAgentID: 'coord-1',
    },
    { id: 'root', participantAgentIDs: [ 'coord-1' ], coordinatorAgentID: 'coord-1' },
  ];
  const getSession = (id) => sessions.find((entry) => entry.id === id) || null;

  let denied = checkAgentMutationAllowed({
    actorAgentID: 'worker-1',
    targetAgentID: 'coord-1',
    currentSessionID: 'child',
    getSession,
  });
  assert.equal(denied.allowed, false);

  const frames = new Map();
  frames.set('resp-1', { id: 'resp-1', content: { text: 'Assigned the parser item to Worker.' } });
  frames.set('resp-2', { id: 'resp-2', content: { text: 'Validated Worker proof against the definition of done.' } });
  let plugin = createPluginHarness(frames);

  let gateCalls = [];
  let services = {
    frameRuntime: { frameStore: { async flush() {} } },
    budgetGate: {
      canContinueWithCurrentBudget: (options) => {
        gateCalls.push(options);
        return canContinueWithCurrentBudget(options);
      },
    },
  };

  let wake1 = await plugin.scheduleAgentContinuation({
    agent: coordinator,
    frame: { id: 'f-0', sessionID: 'root' },
    responseFrameID: 'resp-1',
    continuation: { delayMs: 0, continuationPrompt: 'Focus: assign — create the worker todo with proof.' },
    services,
  });
  assert.ok(wake1, 'turn 1 schedules a wake');
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0].chainDepth, 1);
  assert.match(wake1.content.text, /Your behaviorScript is active/);
  assert.match(wake1.content.text, /Focus: assign/);
  assert.match(wake1.content.text, /Assigned the parser item to Worker\./);

  let workerState = createLoopState();
  let workerTools = createLoopTools(workerState, {});
  workerTools['end-turn']({
    summary: 'Implemented the parser fix and ran the focused spec.',
    reason: 'task-complete',
  });
  assert.equal(workerState.endTurnNotice.reason, 'task-complete');

  let posts = [];
  let workerNotice = await notifyCoordinatorOfEndTurn({
    context: {
      agent: worker,
      session: sessions[0],
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: workerState.endTurnNotice.summary,
    reason: workerState.endTurnNotice.reason,
    postMessage: async (input) => {
      posts.push(input);
      return { frame: { id: 'notice-1' } };
    },
  });
  assert.equal(workerNotice.posted, true);
  assert.equal(workerNotice.coordinatorAgentID, 'coord-1');
  assert.equal(workerNotice.coordinatorSessionID, 'root');
  assert.match(posts[0].text, /Exit reason: task-complete/);
  assert.match(posts[0].text, /Coordinator validation required/);

  let wake2 = await plugin.scheduleAgentContinuation({
    agent: coordinator,
    frame: { id: 'f-1', sessionID: 'root', continuationDepth: 1 },
    responseFrameID: 'resp-2',
    continuation: { delayMs: 0, continuationPrompt: 'Focus: advance — no todo items remain.' },
    services,
  });
  assert.ok(wake2, 'turn 2 schedules the next wake');
  assert.equal(gateCalls.length, 2);
  assert.equal(wake2.continuation.continuationDepth, 2);
  assert.match(wake2.content.text, /Focus: advance/);

  let coordinatorState = createLoopState();
  let coordinatorTools = createLoopTools(coordinatorState, {});
  coordinatorTools['end-turn']({
    summary: 'All items proven complete; master todo list cleared.',
    reason: 'task-complete',
  });
  assert.equal(coordinatorState.endTurnNotice.reason, 'task-complete');

  let finalNotice = await notifyCoordinatorOfEndTurn({
    context: {
      agent: coordinator,
      session: sessions[1],
      services: { frameRuntime: runtimeFor(sessions) },
    },
    summary: coordinatorState.endTurnNotice.summary,
    reason: coordinatorState.endTurnNotice.reason,
    postMessage: async () => {
      throw new Error('the highest coordinator must not message itself');
    },
  });
  assert.equal(finalNotice.posted, false);
  assert.equal(finalNotice.reason, 'no-parent-coordinator');
});
