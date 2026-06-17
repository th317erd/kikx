'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
  CompactionService,
} from '../../../src/core/compaction/index.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameEngine } from '../../../src/core/frames/index.mjs';

class CompactorProvider extends AgentInterface {
  static pluginID = 'compactor';

  async ask(prompt, params = {}) {
    params.services.calls.push({
      method: 'compactor.ask',
      agentID: params.agent.id,
      frameIDs: params.frames.map((frame) => frame.id),
      prompt,
    });

    return {
      type: 'AgentMessage',
      content: {
        text: 'compacted: keep /tmp/project and npm test details',
      },
    };
  }
}

class DeferredCompactorProvider extends AgentInterface {
  static pluginID = 'deferred-compactor';

  async ask(_prompt, params = {}) {
    params.services.calls.push({ method: 'deferred.ask' });
    await params.services.gate.promise;
    return 'deferred compacted summary';
  }
}

test('CompactionService runs one-shot compaction and stores a hidden CompactionFrame', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('compactor', CompactorProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'cmp_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'edit /tmp/project/app.mjs', 1),
    userFrame('msg_2', 'run npm test', 2),
    userFrame('msg_3', 'current request', 3),
  ], { silent: true });

  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Compactor',
          pluginID: 'compactor',
          secrets: {},
          config: {},
          enabled: true,
        };
      },
    },
    clock: () => 9000,
    idGenerator: () => 'compaction_frame_1',
    contextWindowTokens: 20,
    promptReserveTokens: 1,
    compactionAgentContextTokens: 1000,
    compactionTriggerRatio: 0.1,
    estimateTokens: () => 5,
    frameRuntime: {
      emitRuntimeEvent(type, payload) {
        services.events.push({ type, payload });
      },
    },
  });
  let services = { calls: [], events: [] };

  let result = await service.prepareAgentContext({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_3'),
    agent: { id: 'agent_1' },
    services,
  });

  assert.equal(result.compactionPending, true);
  await service.pendingCompactions.get('ses_1:msg_2').promise;

  let compactionFrame = frameEngine.get('compaction_frame_1');
  assert.equal(compactionFrame.type, COMPACTION_FRAME_TYPE);
  assert.equal(compactionFrame.hidden, true);
  assert.equal(compactionFrame.content.kind, COMPACTION_FRAME_KIND);
  assert.equal(compactionFrame.content.boundaryFrameID, 'msg_2');
  assert.match(compactionFrame.content.summary, /\/tmp\/project/);
  assert.deepEqual(services.calls[0].frameIDs, [ 'msg_1', 'msg_2' ]);
  assert.deepEqual(services.events.map((event) => event.type), [ 'compaction.started', 'compaction.completed' ]);
});

test('CompactionService waits at hard context limit and returns rebuilt compacted memory', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('deferred-compactor', DeferredCompactorProvider);
  let gate = createDeferred();
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older context', 1),
    userFrame('msg_2', 'more older context', 2),
    userFrame('msg_3', 'active request', 3),
  ], { silent: true });
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Compactor',
          pluginID: 'deferred-compactor',
          secrets: {},
          config: {},
          enabled: true,
        };
      },
    },
    clock: () => 9000,
    idGenerator: () => 'compaction_frame_1',
    contextWindowTokens: 11,
    promptReserveTokens: 1,
    compactionAgentContextTokens: 1000,
    compactionTriggerRatio: 0.1,
    hardLimitRatio: 1,
    estimateTokens: () => 5,
  });
  let services = { calls: [], gate };

  let pending = service.prepareAgentContext({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_3'),
    agent: { id: 'agent_1' },
    services,
  });

  assert.equal(await promiseState(pending), 'pending');
  gate.resolve();

  let result = await pending;
  assert.deepEqual(result.frames.map((frame) => frame.id), [ 'compaction_frame_1', 'msg_3' ]);
});

test('CompactionService manual compaction creates a visible running frame and updates it on completion', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('deferred-compactor', DeferredCompactorProvider);
  let gate = createDeferred();
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2', 'commit_3' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'important file /tmp/manual/app.mjs', 1),
    userFrame('compact_cmd', '/compact', 2),
  ], { silent: true });
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Compactor',
          pluginID: 'deferred-compactor',
          secrets: {},
          config: {},
          enabled: true,
        };
      },
    },
    clock: () => 9000,
    idGenerator: () => 'manual_compaction_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
  });
  let events = [];
  service.frameRuntime = {
    emitRuntimeEvent(type, payload) {
      events.push({ type, payload });
    },
  };
  let services = { calls: [], gate };

  let promise = service.startManualCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    triggerFrame: frameEngine.get('compact_cmd'),
    agent: { id: 'agent_1' },
    services,
  });

  let runningFrame = frameEngine.get('manual_compaction_1');
  assert.equal(runningFrame.hidden, false);
  assert.equal(runningFrame.content.status, 'running');
  assert.equal(runningFrame.content.frameCount, 1);
  assert.equal(runningFrame.content.boundaryFrameID, 'msg_1');
  assert.equal(runningFrame.createdAt, 9000);
  assert.equal(await promiseState(promise), 'pending');

  gate.resolve();
  let completedFrame = await promise;
  assert.equal(completedFrame.id, 'manual_compaction_1');
  assert.equal(completedFrame.content.status, 'complete');
  assert.equal(completedFrame.hidden, false);
  assert.match(completedFrame.content.summary, /deferred compacted summary/);
  assert.deepEqual(events.map((event) => event.type), [ 'compaction.started', 'compaction.completed' ]);
});

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

function createDeferred() {
  let resolve;
  let reject;
  let promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

async function promiseState(promise) {
  return await Promise.race([
    promise.then(() => 'resolved', () => 'rejected'),
    Promise.resolve().then(() => 'pending'),
  ]);
}
