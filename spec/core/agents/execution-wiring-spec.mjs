'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStartBrief } from '../../../src/core/plugins/agent-brief-template.mjs';
import {
  buildContinuationPromptText,
} from '../../../src/core/agents/agent-route/continuation.mjs';
import {
  AgentRouteFramePluginBase,
} from '../../../src/core/agents/agent-route/agent-route-frame-plugin-base.mjs';
import {
  canContinueWithCurrentBudget,
} from '../../../src/core/runtime/autonomous-chain.mjs';
import { createLoopTools } from '../../../src/core/plugins/agent-loop-tools.mjs';
import { createLoopState } from '../../../src/core/plugins/agent-loop-state.mjs';

const SCRIPT = 'SCRIPT demo_loop\n  checkpoint true { fail -> end-turn }\nEND';

test('start brief carries the AGIS preamble and the behaviorScript block when set', () => {
  let { text } = buildStartBrief({
    agent: { behaviorScript: SCRIPT },
    pluginRegistry: { listPromptSections: () => [] },
  });

  assert.match(text, /AGIS EXECUTOR PREAMBLE/);
  assert.match(text, /--- BEGIN BEHAVIOR SCRIPT ---/);
  assert.match(text, /--- END BEHAVIOR SCRIPT ---/);
  assert.ok(text.includes(SCRIPT));
  assert.ok(text.indexOf('AGIS EXECUTOR PREAMBLE') < text.indexOf(SCRIPT));
});

test('start brief omits the script block for agents without a script', () => {
  let { text } = buildStartBrief({
    agent: {},
    pluginRegistry: { listPromptSections: () => [] },
  });

  assert.doesNotMatch(text, /AGIS EXECUTOR PREAMBLE/);
  assert.doesNotMatch(text, /BEGIN BEHAVIOR SCRIPT/);
});

test('scheduled wake prompt is script-aware for scripted agents only', () => {
  let scripted = buildContinuationPromptText({
    agent: { id: 'a1', name: 'Coord', behaviorScript: SCRIPT },
    responseFrame: { content: { text: 'Step one done.' } },
    continuation: { continuationPrompt: 'Take the assign stroke.' },
  });
  assert.match(scripted, /Your behaviorScript is active/);
  assert.match(scripted, /Take the assign stroke\./);
  assert.match(scripted, /end the turn with a reason/);

  let plain = buildContinuationPromptText({
    agent: { id: 'a2', name: 'Worker' },
    responseFrame: null,
    continuation: {},
  });
  assert.doesNotMatch(plain, /behaviorScript is active/);
  assert.match(plain, /Please continue what you were doing/);
});

test('budget gate shell always allows', () => {
  let result = canContinueWithCurrentBudget({ chainDepth: 3, tokenBudget: null });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'budget-shell-always-yes');
  assert.equal(result.chainDepth, 3);
});

function createPluginHarness({ frames = new Map(), budgetGate = null } = {}) {
  let nextID = 0;
  let pauses = [];
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
  plugin.clock = () => 1_000_000;
  plugin.postAutonomousPauseNotice = (options) => {
    pauses.push(options);
  };
  let services = {
    frameRuntime: { frameStore: { async flush() {} } },
  };
  if (budgetGate)
    services.budgetGate = { canContinueWithCurrentBudget: budgetGate };
  return { plugin, pauses, frames, services };
}

test('schedule gate honors an injected budget denial with a pause notice', async () => {
  let calls = [];
  let { plugin, pauses, frames, services } = createPluginHarness({
    budgetGate: (options) => {
      calls.push(options);
      return { allowed: false, reason: 'budget-exhausted' };
    },
  });

  let result = await plugin.scheduleAgentContinuation({
    agent: { id: 'a1', name: 'Coord', behaviorScript: SCRIPT },
    frame: { id: 'f0', sessionID: 's1' },
    responseFrameID: 'resp1',
    continuation: { delayMs: 0, continuationPrompt: 'next' },
    services,
  });

  assert.equal(result, null);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].frame.id, 'f0');
  assert.equal(frames.size, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chainDepth, 1);
  assert.equal(calls[0].agent.id, 'a1');
  assert.equal(calls[0].sessionID, 's1');
});

test('schedule gate allows and the wake prompt carries the script-aware line', async () => {
  let frames = new Map();
  frames.set('resp1', { id: 'resp1', content: { text: 'Assigned work to w1.' } });
  let { plugin, pauses, services } = createPluginHarness({ frames });

  let created = await plugin.scheduleAgentContinuation({
    agent: { id: 'a1', name: 'Coord', behaviorScript: SCRIPT },
    frame: { id: 'f0', sessionID: 's1' },
    responseFrameID: 'resp1',
    continuation: { delayMs: 0, continuationPrompt: 'Take the monitor stroke.' },
    services,
  });

  assert.ok(created, 'continuation frame is created when the gate allows');
  assert.equal(pauses.length, 0);
  assert.equal(created.continuation.kind, 'send');
  assert.equal(created.continuation.continuationDepth, 1);
  assert.match(created.content.text, /Your behaviorScript is active/);
  assert.match(created.content.text, /Take the monitor stroke\./);
  assert.match(created.content.text, /Assigned work to w1\./);
});

test('schedule gate still pauses over the chain limit even with the allow shell', async () => {
  let frames = new Map();
  frames.set('resp1', { id: 'resp1', content: { text: 'x' } });
  frames.set('f0', { id: 'f0', continuationDepth: 64 });
  let { plugin, pauses, services } = createPluginHarness({ frames });

  let result = await plugin.scheduleAgentContinuation({
    agent: { id: 'a1', name: 'Coord' },
    frame: { id: 'f0', sessionID: 's1', continuationDepth: 64 },
    responseFrameID: 'resp1',
    continuation: { delayMs: 0, continuationPrompt: 'next' },
    services,
  });

  assert.equal(result, null);
  assert.equal(pauses.length, 1);
});

test('end-turn threads an exit reason into the pending coordinator notice', () => {
  let state = createLoopState();
  let tools = createLoopTools(state, { isCoordinator: false });

  let control = tools['end-turn']({
    summary: 'Blocked waiting on upstream.',
    reason: 'blocked-on-upstream',
  });

  assert.equal(control.action, 'finalize');
  assert.equal(state.endTurnNotice.summary, '- Blocked waiting on upstream.');
  assert.equal(state.endTurnNotice.reason, 'blocked-on-upstream');
});

test('silent end-turn with only an exit reason still raises a notice', () => {
  let state = createLoopState();
  let tools = createLoopTools(state, { isCoordinator: false });

  let control = tools['end-turn']({ reason: 'budget-gate' });

  assert.equal(control.action, 'finalize');
  assert.equal(state.finalFrame, null);
  assert.equal(state.endTurnNotice.summary, '');
  assert.equal(state.endTurnNotice.reason, 'budget-gate');
});

test('legacy end-turn without a reason leaves the notice reason-free', () => {
  let state = createLoopState();
  let tools = createLoopTools(state, { isCoordinator: false });

  tools['end-turn']({ summary: 'Done.' });

  assert.equal(state.endTurnNotice.summary, '- Done.');
  assert.equal('reason' in state.endTurnNotice, false);
});
