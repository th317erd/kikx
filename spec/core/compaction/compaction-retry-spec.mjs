'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_FRAME_TYPE,
  CompactionService,
} from '../../../src/core/compaction/index.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameEngine } from '../../../src/core/frames/index.mjs';

// P8 retry (ruling Q3). Frames are immutable history: a retry rebuilds the SAME
// boundary window from the frame's stored metadata, recomputes the strategy from
// the CURRENT session, and overwrites the SAME frame id — success or failure.

class RecordingProvider extends AgentInterface {
  static pluginID = 'recorder';

  async ask(prompt, params = {}) {
    params.services.calls.push({
      method: 'recorder.ask',
      agentID: params.agent.id,
      maxInputTokens: params.maxInputTokens,
      frameIDs: params.frames.map((frame) => frame.id),
      prompt,
    });

    return `summary of ${params.frames.map((frame) => frame.id).join(',')}`;
  }
}

class ThrowingProvider extends AgentInterface {
  static pluginID = 'throwing';

  async ask() {
    throw new Error('retry provider exploded');
  }
}

test('retry re-runs a completed compaction and overwrites the same frame id', async () => {
  let { service, frameEngine, services } = createService();
  let session = { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] };

  let original = await service.runCompaction({
    session,
    frameEngine,
    compactionWindow: windowOf(frameEngine, [ 'msg_1' ]),
    agent: { id: 'agent_1' },
    services,
  });

  assert.equal(original.id, 'cmp_1');
  assert.equal(original.content.status, 'complete');
  assert.equal(services.calls.length, 1);

  let retried = await service.retryCompaction({
    session,
    frameEngine,
    compactionFrameID: 'cmp_1',
    services,
  });

  // Same id, same boundary, re-run through the provider (overwrite in place).
  assert.equal(retried.id, 'cmp_1');
  assert.equal(retried.type, COMPACTION_FRAME_TYPE);
  assert.equal(retried.content.status, 'complete');
  assert.deepEqual(retried.content.frameIDs, [ 'msg_1' ]);
  assert.equal(retried.content.boundaryFrameID, 'msg_1');
  assert.equal(services.calls.length, 2);
  assert.deepEqual(services.calls[1].frameIDs, [ 'msg_1' ]);
  assert.equal(frameEngine.get('cmp_1').content.status, 'complete');
});

test('retry recomputes the strategy from the current session (a newly joined smaller bot wins)', async () => {
  let { service, frameEngine, services } = createService();
  let session = { id: 'ses_1', participantAgentIDs: [ 'large' ] };

  let original = await service.runCompaction({
    session,
    frameEngine,
    compactionWindow: windowOf(frameEngine, [ 'msg_1' ]),
    agent: { id: 'large' },
    services,
  });
  let firstBudget = services.calls[0].maxInputTokens;
  assert.equal(original.content.compactorAgentID, 'large');
  assert.equal(firstBudget > 8000, true);

  // The session continues and a smaller bot joins, then becomes the designated
  // compaction bot. The retry must recompute selection/budget from THAT session.
  session.participantAgentIDs = [ 'large', 'small' ];
  session.compactionAgentID = 'small';

  let retried = await service.retryCompaction({
    session,
    frameEngine,
    compactionFrameID: 'cmp_1',
    services,
  });

  assert.equal(retried.id, 'cmp_1');
  assert.equal(retried.content.compactorAgentID, 'small');
  assert.equal(services.calls[1].agentID, 'small');
  // The smaller window changes the effective budget, exactly as Q3 requires.
  assert.equal(services.calls[1].maxInputTokens < firstBudget, true);
  assert.equal(services.calls[1].maxInputTokens < 8000, true);
});

test('retry that fails overwrites the same frame id with the new trimmed error', async () => {
  let { service, frameEngine, services } = createService();
  let session = { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] };

  await service.runCompaction({
    session,
    frameEngine,
    compactionWindow: windowOf(frameEngine, [ 'msg_1' ]),
    agent: { id: 'agent_1' },
    services,
  });
  assert.equal(frameEngine.get('cmp_1').content.status, 'complete');

  // Swap to a throwing compactor and retry: the failure is recorded on the SAME
  // frame as a trimmed boundary, and the old context frame is never deleted.
  service.pluginRegistry.registerAgentProvider('throwing', ThrowingProvider);
  service.agentManager = managerFor([
    { id: 'agent_1', name: 'Agent', pluginID: 'throwing', secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true },
  ]);

  let retried = await service.retryCompaction({
    session,
    frameEngine,
    compactionFrameID: 'cmp_1',
    services,
  });

  assert.equal(retried.id, 'cmp_1');
  assert.equal(retried.content.status, 'trimmed');
  assert.equal(retried.hidden, false);
  assert.equal(retried.content.errors.length, 1);
  assert.equal(retried.content.errors[0].message, 'retry provider exploded');
  assert.deepEqual(retried.content.frameIDs, [ 'msg_1' ]);
  assert.equal(frameEngine.get('msg_1') != null, true);
  assert.equal(frameEngine.get('cmp_1').content.status, 'trimmed');
});

test('retry on an unknown compaction frame errors clearly', async () => {
  let { service, frameEngine, services } = createService();

  await assert.rejects(
    () => service.retryCompaction({
      session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
      frameEngine,
      compactionFrameID: 'missing',
      services,
    }),
    /Unknown compaction frame: missing/,
  );
});

function createService() {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('recorder', RecordingProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'cmp_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'keep /tmp/project/app.mjs', 1),
    userFrame('msg_2', 'current request', 2),
  ], { silent: true });
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Recorder', pluginID: 'recorder', secrets: {}, config: { contextWindowTokens: 20000 }, enabled: true } ],
    [ 'large', { id: 'large', name: 'Large', pluginID: 'recorder', secrets: {}, config: { contextWindowTokens: 20000 }, enabled: true } ],
    [ 'small', { id: 'small', name: 'Small', pluginID: 'recorder', secrets: {}, config: { contextWindowTokens: 8000 }, enabled: true } ],
  ]);
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor([ ...agents.values() ]),
    clock: () => 9000,
    idGenerator: () => 'cmp_1',
    compactionAgentContextTokens: 128000,
    estimateTokens: (text) => Math.max(1, Math.ceil(String(text || '').length / 4)),
    logger: { error() {}, warn() {} },
    frameRuntime: { emitRuntimeEvent() {} },
  });
  return { service, frameEngine, services: { calls: [] } };
}

function managerFor(agentList) {
  let agents = new Map(agentList.map((agent) => [ agent.id, agent ]));
  return {
    async getAgent(agentID) {
      return agents.get(agentID) || null;
    },
    listModels() {
      return [];
    },
  };
}

function windowOf(frameEngine, ids) {
  let frames = ids.map((id) => frameEngine.get(id));
  return {
    frames,
    startFrameID: ids[0],
    boundaryFrameID: ids[ids.length - 1],
    boundaryOrder: frames.at(-1)?.order ?? null,
    tokens: frames.length,
  };
}

function userFrame(id, text, order) {
  return {
    id,
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: `int_${order}`,
    authorType: 'user',
    authorID: 'user',
    order,
    createdAt: order,
    updatedAt: order,
    timestamp: order,
    hidden: false,
    deleted: false,
    content: { text },
  };
}

function createClock() {
  let value = 0;
  return () => ++value;
}

function createIDs(ids) {
  let values = ids.slice();
  let index = 0;
  return () => values.shift() || `id_${++index}`;
}
