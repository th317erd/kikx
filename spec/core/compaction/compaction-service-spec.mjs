'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
  CompactionService,
  FrameContextBuilder,
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

class TaggedCompactorProvider extends AgentInterface {
  static pluginID = 'tagged-compactor';

  async ask() {
    return [
      '[high]',
      'Keep /tmp/project/app.mjs',
      '[medium]',
      'Rationale noted',
      '[low]',
      'chatter',
    ].join('\n');
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

class BudgetRecordingProvider extends AgentInterface {
  static pluginID = 'budget-recorder';

  async ask(prompt, params = {}) {
    params.services.calls.push({
      method: 'budget-recorder.ask',
      maxInputTokens: params.maxInputTokens,
      frameIDs: params.frames.map((frame) => frame.id),
      prompt,
    });
    return `summary of ${params.frames.map((frame) => frame.id).join(',')}`;
  }
}

class SecretCheckingCompactorProvider extends AgentInterface {
  static pluginID = 'secret-checking-compactor';

  async ask(_prompt, params = {}) {
    if (!params.secrets?.apiKey)
      throw new Error('apiKey is required');

    params.services.calls.push({
      method: 'secret-checking.ask',
      agentID: params.agent.id,
      apiKey: params.secrets.apiKey,
      model: params.config?.model,
    });
    return 'compacted with current agent secret';
  }
}

test('CompactionService runs one-shot compaction and stores a visible CompactionFrame', async () => {
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
          config: { contextWindowTokens: 20000 },
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
    // Trigger off a tiny participant window while the compactor's own window is
    // large, so the trigger fires without chunking the (small) window.
    agentContextWindowTokens: 20,
    services,
  });

  assert.equal(result.compactionPending, true);
  await service.pendingCompactions.get('ses_1:msg_2').promise;

  let compactionFrame = frameEngine.get('compaction_frame_1');
  assert.equal(compactionFrame.type, COMPACTION_FRAME_TYPE);
  // P7 (Q2): the automatic compaction frame is always visible.
  assert.equal(compactionFrame.hidden, false);
  assert.equal(compactionFrame.content.kind, COMPACTION_FRAME_KIND);
  assert.deepEqual(compactionFrame.content.warnings, []);
  assert.deepEqual(compactionFrame.content.errors, []);
  assert.equal(compactionFrame.content.boundaryFrameID, 'msg_2');
  assert.match(compactionFrame.content.summary, /\/tmp\/project/);
  // The structured form is stored alongside the verbatim string. An untagged
  // summary is folded into `high` so nothing must-keep is lost.
  assert.equal(compactionFrame.content.summaryJSON.unstructured, true);
  assert.deepEqual(compactionFrame.content.summaryJSON.low, []);
  assert.deepEqual(services.calls[0].frameIDs, [ 'msg_1', 'msg_2' ]);
  assert.deepEqual(services.events.map((event) => event.type), [ 'compaction.started', 'compaction.completed' ]);
});

test('CompactionService builds compaction windows from stitched FrameManager messages', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('compactor', CompactorProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'compaction_frame_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'question', 1),
    agentFrame('agent_1', 'answer', 2),
    {
      id: 'agent_1:done',
      type: 'MessageDone',
      sessionID: 'ses_1',
      parentID: 'agent_1',
      order: 3,
      hidden: true,
      deleted: false,
      content: {
        frameID: 'agent_1',
      },
    },
    userFrame('msg_2', 'active request', 4),
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
          config: { contextWindowTokens: 20000 },
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
  });
  let services = { calls: [] };

  await service.prepareAgentContext({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_2'),
    agent: { id: 'agent_1' },
    agentContextWindowTokens: 20,
    services,
  });
  await service.pendingCompactions.get('ses_1:agent_1').promise;

  assert.deepEqual(frameEngine.toArray().map((frame) => frame.id), [
    'msg_1',
    'agent_1',
    'agent_1:done',
    'msg_2',
    'compaction_frame_1',
  ]);
  assert.deepEqual(services.calls[0].frameIDs, [ 'msg_1', 'agent_1' ]);
});

test('CompactionService selects the largest-window participant when no compactor is designated', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('secret-checking-compactor', SecretCheckingCompactorProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'compaction_frame_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older project detail', 1),
    userFrame('msg_2', 'active request', 2),
  ], { silent: true });
  let requestedAgentIDs = [];
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent(agentID) {
        requestedAgentIDs.push(agentID);
        return {
          id: agentID,
          name: agentID,
          pluginID: 'secret-checking-compactor',
          secrets: agentID === 'current_agent' ? { apiKey: 'secret' } : {},
          config: {
            model: 'test-model',
            contextWindowTokens: agentID === 'current_agent' ? 200000 : 100000,
          },
          enabled: true,
        };
      },
    },
    clock: () => 9000,
    idGenerator: () => 'compaction_frame_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
  });
  let services = { calls: [] };

  let frame = await service.runCompaction({
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'alternate_agent', 'current_agent' ],
    },
    frameEngine,
    compactionWindow: {
      frames: [ frameEngine.get('msg_1') ],
      startFrameID: 'msg_1',
      boundaryFrameID: 'msg_1',
      boundaryOrder: 1,
      tokens: 5,
    },
    agent: { id: 'current_agent' },
    services,
  });

  assert.equal(requestedAgentIDs.at(-1), 'current_agent');
  assert.equal(frame.content.compactorAgentID, 'current_agent');
  assert.match(frame.content.summary, /current agent secret/);
  assert.deepEqual(services.calls, [{
    method: 'secret-checking.ask',
    agentID: 'current_agent',
    apiKey: 'secret',
    model: 'test-model',
  }]);
});

test('CompactionService stores tagged output as structured summaryJSON', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('tagged-compactor', TaggedCompactorProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'compaction_frame_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older project detail', 1),
    userFrame('msg_2', 'active request', 2),
  ], { silent: true });
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Compactor',
          pluginID: 'tagged-compactor',
          secrets: {},
          config: {},
          enabled: true,
        };
      },
    },
    clock: () => 9000,
    idGenerator: () => 'compaction_frame_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
  });
  let services = { calls: [] };

  let frame = await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: {
      frames: [ frameEngine.get('msg_1') ],
      startFrameID: 'msg_1',
      boundaryFrameID: 'msg_1',
      boundaryOrder: 1,
      tokens: 5,
    },
    agent: { id: 'agent_1' },
    services,
  });

  assert.match(frame.content.summary, /Keep \/tmp\/project/);
  assert.equal(frame.content.summaryJSON.unstructured, false);
  assert.deepEqual(frame.content.summaryJSON.high, [ 'Keep /tmp/project/app.mjs' ]);
  assert.deepEqual(frame.content.summaryJSON.medium, [ 'Rationale noted' ]);
  assert.deepEqual(frame.content.summaryJSON.low, [ 'chatter' ]);
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
          config: { contextWindowTokens: 11 },
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

test('CompactionService triggers off the smallest participant window resolved from agents', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('compactor', CompactorProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'compaction_frame_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older', 1),
    userFrame('msg_2', 'older still', 2),
    userFrame('msg_3', 'active request', 3),
  ], { silent: true });
  let agents = new Map([
    [ 'small', { id: 'small', name: 'Small', pluginID: 'compactor', secrets: {}, config: { contextWindowTokens: 100 }, enabled: true } ],
    [ 'large', { id: 'large', name: 'Large', pluginID: 'compactor', secrets: {}, config: { contextWindowTokens: 1000 }, enabled: true } ],
  ]);
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent(agentID) {
        return agents.get(agentID) || null;
      },
      listModels() {
        return [];
      },
    },
    clock: () => 9000,
    idGenerator: () => 'compaction_frame_1',
    compactionAgentContextTokens: 1000,
    baseReserveTokens: 20,
    compactionTriggerRatio: 0.7,
    estimateTokens: () => 30,
  });
  let services = { calls: [] };

  let result = await service.prepareAgentContext({
    session: { id: 'ses_1', participantAgentIDs: [ 'small', 'large' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_3'),
    agent: { id: 'small' },
    services,
  });

  assert.equal(result.shouldCompact, true);
});

test('CompactionService sizes the request from the selected compactor window, not the global default', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('budget-recorder', BudgetRecordingProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'compaction_frame_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older project detail', 1),
    userFrame('msg_2', 'active request', 2),
  ], { silent: true });
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Compactor',
          pluginID: 'budget-recorder',
          secrets: {},
          config: { model: 'tiny', contextWindowTokens: 8000 },
          enabled: true,
        };
      },
      listModels() {
        return [];
      },
    },
    clock: () => 9000,
    idGenerator: () => 'compaction_frame_1',
    compactionAgentContextTokens: 128000,
    estimateTokens: (text) => Math.max(1, Math.ceil(String(text || '').length / 4)),
  });
  let services = { calls: [] };

  await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: {
      frames: [ frameEngine.get('msg_1') ],
      startFrameID: 'msg_1',
      boundaryFrameID: 'msg_1',
      boundaryOrder: 1,
      tokens: 5,
    },
    agent: { id: 'agent_1' },
    services,
  });

  let call = services.calls[0];
  assert.equal(call.maxInputTokens < 8000, true);
  assert.equal(call.maxInputTokens > 2000, true);
  assert.equal(call.maxInputTokens < 128000, true);
});

test('CompactionService falls back to the legacy budget when the compactor window is unknown', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('budget-recorder', BudgetRecordingProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'compaction_frame_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older project detail', 1),
    userFrame('msg_2', 'active request', 2),
  ], { silent: true });
  class NullWindowProvider extends BudgetRecordingProvider {
    resolveContextWindow() {
      return null;
    }

    contextWindowFor() {
      return null;
    }
  }
  pluginRegistry.registerAgentProvider('budget-recorder', NullWindowProvider);
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Compactor',
          pluginID: 'budget-recorder',
          secrets: {},
          config: {},
          enabled: true,
        };
      },
      listModels() {
        return [];
      },
    },
    clock: () => 9000,
    idGenerator: () => 'compaction_frame_1',
    compactionAgentContextTokens: 20000,
    estimateTokens: (text) => Math.max(1, Math.ceil(String(text || '').length / 4)),
  });
  let services = { calls: [] };

  await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: {
      frames: [ frameEngine.get('msg_1') ],
      startFrameID: 'msg_1',
      boundaryFrameID: 'msg_1',
      boundaryOrder: 1,
      tokens: 5,
    },
    agent: { id: 'agent_1' },
    services,
  });

  let call = services.calls[0];
  // The legacy budget is used (not the 32768 shared default).
  assert.equal(call.maxInputTokens < 20000, true);
  assert.equal(call.maxInputTokens > 10000, true);
});

test('CompactionService chunks and reduces when a small compactor window cannot fit the input', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('budget-recorder', BudgetRecordingProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'compaction_frame_1', 'commit_2' ]),
  });
  let big = 'x'.repeat(4000);
  frameEngine.merge([
    userFrame('msg_1', big, 1),
    userFrame('msg_2', big, 2),
    userFrame('msg_3', big, 3),
    userFrame('msg_4', 'active request', 4),
  ], { silent: true });
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Compactor',
          pluginID: 'budget-recorder',
          secrets: {},
          config: { contextWindowTokens: 4000 },
          enabled: true,
        };
      },
      listModels() {
        return [];
      },
    },
    clock: () => 9000,
    idGenerator: () => 'compaction_frame_1',
    compactionAgentContextTokens: 128000,
    estimateTokens: (text) => Math.max(1, Math.ceil(String(text || '').length / 4)),
  });
  let services = { calls: [] };

  let frame = await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: {
      frames: [ frameEngine.get('msg_1'), frameEngine.get('msg_2'), frameEngine.get('msg_3') ],
      startFrameID: 'msg_1',
      boundaryFrameID: 'msg_3',
      boundaryOrder: 3,
      tokens: 3000,
    },
    agent: { id: 'agent_1' },
    services,
  });

  assert.equal(services.calls.length > 1, true);
  assert.equal(services.calls.some((call) => call.frameIDs.length < 3), true);
  assert.match(frame.content.summary, /summary of/);
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

function agentFrame(id, text, order) {
  return {
    id,
    type: 'AgentMessage',
    sessionID: 'ses_1',
    interactionID: `int_${order}`,
    authorType: 'agent',
    authorID: 'agent_1',
    authorDisplayName: 'Agent One',
    order,
    createdAt: order,
    updatedAt: order,
    timestamp: order,
    hidden: false,
    deleted: false,
    state: {
      lifecycle: {
        status: 'closed',
        closedAt: order,
      },
    },
    content: {
      text,
      status: 'complete',
    },
  };
}

test('per-bot hold: a bot whose own window is exceeded waits; one that fits does not (R5)', async () => {
  let frameEngine = new FrameEngine({ clock: createClock(), idGenerator: createIDs([ 'msg_1', 'msg_2', 'msg_3' ]) });
  frameEngine.merge([
    userFrame('msg_1', 'older request about /tmp/project', 1),
    userFrame('msg_2', 'middle request', 2),
    userFrame('msg_3', 'current request', 3),
  ], { silent: true });

  // Small-window bot: its OWN window is tiny, so its projected context exceeds it
  // and it must wait for the in-flight compaction.
  let small = createHoldService({ ownWindowTokens: 3 });
  let smallResult = await small.service.prepareAgentContext({
    session: { id: 'ses_small', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_3'),
    agent: { id: 'agent_1' },
    agentContextWindowTokens: 20,
    services: small.services,
  });
  assert.equal(smallResult.heldForCompaction, true, 'the small-window bot must be held for compaction');

  // Large-window bot: same session, but its own window easily fits the context,
  // so it is NOT held (compaction may still start in the background).
  let frameEngine2 = new FrameEngine({ clock: createClock(), idGenerator: createIDs([ 'msg_1', 'msg_2', 'msg_3' ]) });
  frameEngine2.merge([
    userFrame('msg_1', 'older request', 1),
    userFrame('msg_2', 'middle request', 2),
    userFrame('msg_3', 'current request', 3),
  ], { silent: true });
  let large = createHoldService({ ownWindowTokens: 1_000_000 });
  let largeResult = await large.service.prepareAgentContext({
    session: { id: 'ses_large', participantAgentIDs: [ 'agent_1' ] },
    frameEngine: frameEngine2,
    triggerFrame: frameEngine2.get('msg_3'),
    agent: { id: 'agent_1' },
    agentContextWindowTokens: 20,
    services: large.services,
  });
  // Not held: returns immediately with compactionPending, without awaiting.
  assert.equal(largeResult.compactionPending, true);
});

test('P7: a failed auto-compaction writes a visible trimmed boundary, then re-compaction restores memory', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('throwing', ThrowingProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'keep /tmp/project/app.mjs', 1),
    userFrame('msg_2', 'current request', 2),
  ], { silent: true });

  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Agent',
          pluginID: 'throwing',
          secrets: {},
          config: { contextWindowTokens: 200000 },
          enabled: true,
        };
      },
    },
    clock: () => 9000,
    idGenerator: () => 'trim_boundary_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
    frameRuntime: { emitRuntimeEvent() {} },
  });
  let services = { calls: [] };

  let trimmed = await service.startCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: {
      frames: [ frameEngine.get('msg_1') ],
      startFrameID: 'msg_1',
      boundaryFrameID: 'msg_1',
      boundaryOrder: 1,
      tokens: 5,
    },
    agent: { id: 'agent_1' },
    services,
  });

  assert.equal(trimmed.content.status, 'trimmed');
  assert.equal(trimmed.hidden, false);
  // Projection now starts after the trimmed boundary; msg_1 is still stored.
  let boundaryBuilder = new FrameContextBuilder({ contextWindowTokens: 1000, promptReserveTokens: 10 });
  let projected = boundaryBuilder.build(frameEngine.toArray(), { activeFrameID: 'msg_2' });
  assert.deepEqual(projected.frames.map((frame) => frame.id), [ 'trim_boundary_1', 'msg_2' ]);
  assert.equal(frameEngine.get('msg_1') != null, true);

  // Re-compaction from the SAME boundary with a working provider overwrites the
  // trimmed boundary in place and restores memory.
  pluginRegistry.registerAgentProvider('compactor', CompactorProvider);
  service.agentManager = {
    async getAgent() {
      return {
        id: 'agent_1',
        name: 'Compactor',
        pluginID: 'compactor',
        secrets: {},
        config: { contextWindowTokens: 200000 },
        enabled: true,
      };
    },
  };
  service.idGenerator = () => 'trim_boundary_1';
  let restored = await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: {
      frames: [ frameEngine.get('msg_1') ],
      startFrameID: 'msg_1',
      boundaryFrameID: 'msg_1',
      boundaryOrder: 1,
      tokens: 5,
    },
    compactionFrameID: 'trim_boundary_1',
    agent: { id: 'agent_1' },
    services,
  });

  assert.equal(restored.id, 'trim_boundary_1');
  assert.equal(restored.content.status, 'complete');
  assert.match(restored.content.summary, /\/tmp\/project/);
  assert.equal(restored.content.errors.length, 0);
  assert.equal(frameEngine.get('msg_1') != null, true);
});

class ThrowingProvider extends AgentInterface {
  static pluginID = 'throwing';

  async ask() {
    throw new Error('provider exploded');
  }
}

function createHoldService({ ownWindowTokens }) {
  let services = { calls: [] };
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentProvider('hold-agent', HoldProvider);
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() {
        return {
          id: 'agent_1',
          name: 'Hold',
          pluginID: 'hold-agent',
          secrets: {},
          config: { contextWindowTokens: ownWindowTokens },
          enabled: true,
        };
      },
    },
    clock: createClock(),
    idGenerator: () => 'compaction_frame_1',
    contextWindowTokens: 20,
    promptReserveTokens: 1,
    compactionAgentContextTokens: 1000,
    compactionTriggerRatio: 0.1,
    estimateTokens: () => 5,
    frameRuntime: { emitRuntimeEvent() {} },
  });
  return { service, services };
}

class HoldProvider extends AgentInterface {
  static pluginID = 'hold-agent';

  resolveContextWindow() {
    return this.context?.agent?.config?.contextWindowTokens || null;
  }

  async ask() {
    return 'hold compacted summary';
  }
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
