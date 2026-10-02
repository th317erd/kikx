'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_FRAME_TYPE,
  CompactionService,
} from '../../../src/core/compaction/index.mjs';
import { PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameEngine } from '../../../src/core/frames/index.mjs';
import {
  EmptyProvider,
  MixedProvider,
  NoAskProvider,
  ThrowingProvider,
  assertNoUnhandledRejection,
  createClock,
  createIDs,
  lastEvent,
  managerFor,
  userFrame,
  windowOf,
} from './compaction-resilience-fixtures.mjs';

// Deliberate failures and the Part A fail-safe. Fakes only: no real models are
// called. Every test proves the caller is not crashed: async failures resolve
// `startCompaction` to `null`, raw paths reject with the exact message, and
// `prepareAgentContext` never throws when hold/window resolution breaks.

test('failure: provider ask() throws -> compaction.failed, null, and no frame stored', async () => {
  let { service, frameEngine, events } = createStartService(ThrowingProvider, 'throwing');

  let outcome;
  await assertNoUnhandledRejection(async () => {
    outcome = await service.startCompaction(runInput(frameEngine));
  });

  assert.equal(outcome, null);
  assert.equal(frameEngine.toArray().some((frame) => frame.type === COMPACTION_FRAME_TYPE), false);
  assert.equal(lastEvent(events, 'compaction.failed').payload.error.message, 'provider exploded');
});

test('failure: provider ask() returns empty -> empty-summary error, null, no frame', async () => {
  let { service, frameEngine, events } = createStartService(EmptyProvider, 'empty');

  let outcome;
  await assertNoUnhandledRejection(async () => {
    outcome = await service.startCompaction(runInput(frameEngine));
  });

  assert.equal(outcome, null);
  assert.equal(frameEngine.toArray().some((frame) => frame.type === COMPACTION_FRAME_TYPE), false);
  assert.equal(
    lastEvent(events, 'compaction.failed').payload.error.message,
    'Compaction provider returned an empty summary',
  );
});

test('failure: no agent available -> "No agent available for context compaction"', async () => {
  let frameEngine = singleFrameEngine();
  let events = [];
  let service = new CompactionService({
    pluginRegistry: new PluginRegistry(),
    agentManager: { async getAgent() { return null; }, listModels() { return []; } },
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
    frameRuntime: { emitRuntimeEvent(type, payload) { events.push({ type, payload }); } },
  });

  let outcome;
  await assertNoUnhandledRejection(async () => {
    outcome = await service.startCompaction({
      session: { id: 'ses_1', participantAgentIDs: [] },
      frameEngine,
      compactionWindow: windowOf(frameEngine, [ 'msg_1' ]),
      agent: {},
      services: { calls: [] },
    });
  });

  assert.equal(outcome, null);
  assert.equal(
    lastEvent(events, 'compaction.failed').payload.error.message,
    'No agent available for context compaction',
  );
});

test('failure: no provider class registered -> "No compaction provider found"', async () => {
  let frameEngine = singleFrameEngine();
  let events = [];
  let service = new CompactionService({
    pluginRegistry: new PluginRegistry(),
    agentManager: managerFor(new Map([
      [ 'ghost', { id: 'ghost', name: 'Ghost', pluginID: 'ghost', secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true } ],
    ])),
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
    frameRuntime: { emitRuntimeEvent(type, payload) { events.push({ type, payload }); } },
  });

  let outcome;
  await assertNoUnhandledRejection(async () => {
    outcome = await service.startCompaction({
      session: { id: 'ses_1', participantAgentIDs: [ 'ghost' ] },
      frameEngine,
      compactionWindow: windowOf(frameEngine, [ 'msg_1' ]),
      agent: { id: 'ghost' },
      services: { calls: [] },
    });
  });

  assert.equal(outcome, null);
  assert.match(
    lastEvent(events, 'compaction.failed').payload.error.message,
    /No compaction provider found/,
  );
});

test('failure: provider with no one-shot ask() -> explicit error, null, no frame', async () => {
  let { service, frameEngine, events } = createStartService(NoAskProvider, 'no-ask');

  let outcome;
  await assertNoUnhandledRejection(async () => {
    outcome = await service.startCompaction(runInput(frameEngine));
  });

  assert.equal(outcome, null);
  assert.equal(frameEngine.toArray().some((frame) => frame.type === COMPACTION_FRAME_TYPE), false);
  assert.match(
    lastEvent(events, 'compaction.failed').payload.error.message,
    /does not expose a one-shot ask\(\)/,
  );
});

test('raw throw paths: runCompaction rejects with the exact failure messages', async () => {
  // `startCompaction` absorbs these, so assert the raw rejection directly.
  let throwing = createStartService(ThrowingProvider, 'throwing');
  await assert.rejects(
    () => throwing.service.runCompaction(runInput(throwing.frameEngine)),
    /provider exploded/,
  );

  let empty = createStartService(EmptyProvider, 'empty');
  await assert.rejects(
    () => empty.service.runCompaction(runInput(empty.frameEngine)),
    /Compaction provider returned an empty summary/,
  );

  let noAsk = createStartService(NoAskProvider, 'no-ask');
  await assert.rejects(
    () => noAsk.service.runCompaction(runInput(noAsk.frameEngine)),
    /does not expose a one-shot ask\(\)/,
  );

  let noAgentEngine = singleFrameEngine();
  let noAgent = new CompactionService({
    pluginRegistry: new PluginRegistry(),
    agentManager: { async getAgent() { return null; }, listModels() { return []; } },
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
  });
  await assert.rejects(
    () => noAgent.runCompaction({
      session: { id: 'ses_1', participantAgentIDs: [] },
      frameEngine: noAgentEngine,
      compactionWindow: windowOf(noAgentEngine, [ 'msg_1' ]),
      agent: {},
      services: { calls: [] },
    }),
    /No agent available for context compaction/,
  );

  let ghostEngine = singleFrameEngine();
  let noProvider = new CompactionService({
    pluginRegistry: new PluginRegistry(),
    agentManager: managerFor(new Map([
      [ 'ghost', { id: 'ghost', name: 'Ghost', pluginID: 'ghost', secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true } ],
    ])),
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
  });
  await assert.rejects(
    () => noProvider.runCompaction({
      session: { id: 'ses_1', participantAgentIDs: [ 'ghost' ] },
      frameEngine: ghostEngine,
      compactionWindow: windowOf(ghostEngine, [ 'msg_1' ]),
      agent: { id: 'ghost' },
      services: { calls: [] },
    }),
    /No compaction provider found/,
  );
});

test('fail-safe: hold-check throws (manager getAgent/listModels fail) -> prepareAgentContext does NOT throw', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('mixed', MixedProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older', 1),
    userFrame('msg_2', 'active', 2),
  ], { silent: true });
  let errors = [];
  let service = new CompactionService({
    pluginRegistry,
    agentManager: {
      async getAgent() { throw new Error('agent lookup failed'); },
      listModels() { throw new Error('catalog down'); },
    },
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    contextWindowTokens: 32768,
    baseReserveTokens: 8000,
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error(...args) { errors.push(args); }, warn() {} },
    frameRuntime: { emitRuntimeEvent() {} },
  });

  // Explicit window skips resolveSessionWindows, so the throw comes from the
  // hold-check path (the manager's listModels) inside shouldHoldAgentForCompaction.
  // The projected context exceeds the hard limit, so the legacy fallback is to
  // hold and wait; the point is that prepareAgentContext resolves rather than
  // rejecting when the hold decision blows up.
  let result = await service.prepareAgentContext({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_2'),
    agent: { id: 'agent_1' },
    agentContextWindowTokens: 32768,
    usageOverheadTokens: 30000,
    services: {},
  });

  assert.equal(result.heldForCompaction, true);
  assert.equal(result.compactionPending, false);
  assert.equal(errors.length >= 1, true);
});

test('fail-safe: window resolution throws -> legacy global window and prepareAgentContext does not throw', async () => {
  let service = new CompactionService({
    agentManager: {
      async getAgent() { throw new Error('agent lookup failed'); },
      listModels() { throw new Error('catalog down'); },
    },
    contextWindowTokens: 128000,
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
  });

  let options = await service.resolveTriggerOptions({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
  });
  assert.equal(options.agentContextWindowTokens, 128000);

  // End-to-end: prepareAgentContext resolves against the legacy window instead
  // of rejecting when session window resolution blows up.
  let frameEngine = singleFrameEngine();
  let result = await service.prepareAgentContext({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_1'),
    agent: { id: 'agent_1' },
    services: {},
  });
  assert.equal(result.availableTokens, 128000 - 8000);
  assert.equal(result.shouldCompact, false);
});

test('failure: compaction fails while a bot waits at the hard limit -> resolves with rebuilt context', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('throwing', ThrowingProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older', 1),
    userFrame('msg_2', 'active', 2),
  ], { silent: true });
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Agent', pluginID: 'throwing', secrets: {}, config: { contextWindowTokens: 32768 }, enabled: true } ],
  ]);
  let events = [];
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor(agents),
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    contextWindowTokens: 32768,
    baseReserveTokens: 8000,
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
    frameRuntime: { emitRuntimeEvent(type, payload) { events.push({ type, payload }); } },
  });

  let result;
  await assertNoUnhandledRejection(async () => {
    result = await service.prepareAgentContext({
      session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
      frameEngine,
      triggerFrame: frameEngine.get('msg_2'),
      agent: { id: 'agent_1' },
      agentContextWindowTokens: 32768,
      usageOverheadTokens: 30000,
      services: {},
    });
  });

  // The bot waited, compaction failed, but the turn continues with the original
  // context.
  assert.equal(result.heldForCompaction, true);
  assert.deepEqual(result.frames.map((frame) => frame.id), [ 'msg_1', 'msg_2' ]);
  assert.equal(frameEngine.toArray().some((frame) => frame.type === COMPACTION_FRAME_TYPE), false);
  assert.equal(lastEvent(events, 'compaction.failed') != null, true);
});

test('failure: manual compaction failure produces a failed frame and compaction.failed', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('throwing', ThrowingProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2', 'commit_3' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'important detail', 1),
    userFrame('compact_cmd', '/compact', 2),
  ], { silent: true });
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Agent', pluginID: 'throwing', secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true } ],
  ]);
  let events = [];
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor(agents),
    clock: createClock(),
    idGenerator: () => 'manual_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
    frameRuntime: { emitRuntimeEvent(type, payload) { events.push({ type, payload }); } },
  });

  let failedFrame;
  await assertNoUnhandledRejection(async () => {
    failedFrame = await service.startManualCompaction({
      session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
      frameEngine,
      triggerFrame: frameEngine.get('compact_cmd'),
      agent: { id: 'agent_1' },
      services: {},
    });
  });

  assert.equal(failedFrame.content.status, 'failed');
  assert.equal(failedFrame.hidden, false);
  assert.equal(lastEvent(events, 'compaction.failed').payload.manual, true);
  assert.equal(lastEvent(events, 'compaction.failed').payload.error.message, 'provider exploded');
});

function runInput(frameEngine) {
  return {
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: windowOf(frameEngine, [ 'msg_1' ]),
    agent: { id: 'agent_1' },
    services: { calls: [] },
  };
}

function singleFrameEngine() {
  let frameEngine = new FrameEngine({ clock: createClock(), idGenerator: createIDs([ 'commit_1' ]) });
  frameEngine.merge([ userFrame('msg_1', 'older', 1) ], { silent: true });
  return frameEngine;
}

function createStartService(ProviderClass, pluginID) {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider(pluginID, ProviderClass);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.merge([ userFrame('msg_1', 'older', 1) ], { silent: true });
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Agent', pluginID, secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true } ],
  ]);
  let events = [];
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor(agents),
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
    frameRuntime: { emitRuntimeEvent(type, payload) { events.push({ type, payload }); } },
  });

  return { service, frameEngine, events };
}
