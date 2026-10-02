'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompactionService,
} from '../../../src/core/compaction/index.mjs';
import { PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameEngine } from '../../../src/core/frames/index.mjs';
import {
  HighOnlyProvider,
  MixedProvider,
  UntaggedProvider,
  createClock,
  createIDs,
  managerFor,
  userFrame,
  windowOf,
} from './compaction-resilience-fixtures.mjs';

// Mixed small/big fleet behavior and the instruction/format invariants. Fakes
// only: no real models are called. Every test is deterministic. Failure paths
// live in `compaction-resilience-failure-spec.mjs`; chunking in
// `compaction-resilience-chunking-spec.mjs`.

test('mixed fleet: trigger fires off the SMALL window and selects the BIG bot', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('mixed', MixedProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older request', 1),
    userFrame('msg_2', 'active request', 2),
  ], { silent: true });
  let agents = new Map([
    [ 'small', { id: 'small', name: 'Small', pluginID: 'mixed', secrets: {}, config: { contextWindowTokens: 32768 }, enabled: true } ],
    [ 'big', { id: 'big', name: 'Big', pluginID: 'mixed', secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true } ],
  ]);
  let events = [];
  let services = { calls: [] };
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor(agents),
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    baseReserveTokens: 8000,
    promptReserveTokens: 8000,
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    frameRuntime: { emitRuntimeEvent(type, payload) { events.push({ type, payload }); } },
  });

  let result = await service.prepareAgentContext({
    session: { id: 'ses_1', participantAgentIDs: [ 'small', 'big' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_2'),
    agent: { id: 'small' },
    usageOverheadTokens: 20000,
    services,
  });

  // R1: the trigger follows the smallest participant window, not the global
  // default and not the big bot.
  assert.equal(result.availableTokens, 32768 - 8000);
  assert.equal(result.shouldCompact, true);
  assert.equal(result.shouldWaitForCompaction, false);
  assert.equal(result.compactionPending, true);

  let frame = await service.pendingCompactions.get('ses_1:msg_1').promise;
  // R3: capability order picks the larger-window bot when nothing is designated.
  assert.equal(frame.content.compactorAgentID, 'big');
  assert.equal(services.calls[0].agentID, 'big');
  assert.deepEqual(events.map((event) => event.type), [ 'compaction.started', 'compaction.completed' ]);
});

test('mixed fleet: an explicit small coordinator wins rung 3 over the bigger bot', async () => {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('mixed', MixedProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.merge([ userFrame('msg_1', 'older request', 1) ], { silent: true });
  let agents = new Map([
    [ 'small', { id: 'small', name: 'Small', pluginID: 'mixed', secrets: {}, config: { contextWindowTokens: 32768 }, enabled: true } ],
    [ 'big', { id: 'big', name: 'Big', pluginID: 'mixed', secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true } ],
  ]);
  let services = { calls: [] };
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor(agents),
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    frameRuntime: { emitRuntimeEvent() {} },
  });

  let frame = await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'small', 'big' ], coordinatorAgentID: 'small' },
    frameEngine,
    compactionWindow: windowOf(frameEngine, [ 'msg_1' ]),
    agent: { id: 'small' },
    services,
  });

  assert.equal(frame.content.compactorAgentID, 'small');
  assert.equal(services.calls[0].agentID, 'small');
});

test('per-bot hold: a resolved small window waits only when its OWN window is exceeded', async () => {
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'msg_1', 'msg_2', 'msg_3' ]),
  });
  frameEngine.merge([
    userFrame('msg_1', 'older request', 1),
    userFrame('msg_2', 'middle request', 2),
    userFrame('msg_3', 'active request', 3),
  ], { silent: true });

  let small = createHoldService(32768);
  let smallResult = await small.service.prepareAgentContext({
    session: { id: 'ses_small', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    triggerFrame: frameEngine.get('msg_3'),
    agent: { id: 'agent_1' },
    agentContextWindowTokens: 32768,
    usageOverheadTokens: 30000,
    services: small.services,
  });
  // Context exceeds the bot's own hard limit -> it waits for the in-flight
  // compaction and gets a rebuilt context.
  assert.equal(smallResult.heldForCompaction, true);
  assert.equal(smallResult.compactionPending, false);

  let frameEngine2 = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'msg_1', 'msg_2', 'msg_3' ]),
  });
  frameEngine2.merge([
    userFrame('msg_1', 'older request', 1),
    userFrame('msg_2', 'middle request', 2),
    userFrame('msg_3', 'active request', 3),
  ], { silent: true });
  let large = createHoldService(200000);
  let largeResult = await large.service.prepareAgentContext({
    session: { id: 'ses_large', participantAgentIDs: [ 'agent_1' ] },
    frameEngine: frameEngine2,
    triggerFrame: frameEngine2.get('msg_3'),
    agent: { id: 'agent_1' },
    agentContextWindowTokens: 32768,
    usageOverheadTokens: 30000,
    services: large.services,
  });
  // Same projected context, larger own window -> no hold, compaction proceeds
  // in the background.
  assert.equal(largeResult.compactionPending, true);
  assert.equal(largeResult.heldForCompaction, undefined);
  await large.service.pendingCompactions.get('ses_large:msg_2').promise;
});

test('per-bot hold: an unidentified bot falls back to the legacy hard-limit wait', async () => {
  let service = new CompactionService({
    pluginRegistry: new PluginRegistry(),
    agentManager: { async getAgent() { return null; }, listModels() { return []; } },
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    contextWindowTokens: 32768,
    baseReserveTokens: 8000,
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    logger: { error() {}, warn() {} },
    frameRuntime: { emitRuntimeEvent() {} },
  });

  assert.equal(await service.shouldHoldAgentForCompaction({ agent: {} }, { shouldWaitForCompaction: true }), true);
  assert.equal(await service.shouldHoldAgentForCompaction({ agent: {} }, { shouldWaitForCompaction: false }), false);
});

test('format invariant: untagged summary stores everything under high (nothing lost)', async () => {
  let { frame } = await runWithProvider(UntaggedProvider, 'untagged');

  assert.equal(frame.content.summaryJSON.unstructured, true);
  assert.deepEqual(frame.content.summaryJSON.high, [ 'plain untagged line one', 'plain untagged line two' ]);
  assert.deepEqual(frame.content.summaryJSON.medium, []);
  assert.deepEqual(frame.content.summaryJSON.low, []);
});

test('format invariant: a [high]-only summary leaves medium/low empty', async () => {
  let { frame } = await runWithProvider(HighOnlyProvider, 'high-only');

  assert.equal(frame.content.summaryJSON.unstructured, false);
  assert.deepEqual(frame.content.summaryJSON.high, [ 'Only must-keep material' ]);
  assert.deepEqual(frame.content.summaryJSON.medium, []);
  assert.deepEqual(frame.content.summaryJSON.low, []);
});

async function runWithProvider(ProviderClass, pluginID) {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider(pluginID, ProviderClass);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.merge([ userFrame('msg_1', 'older project detail', 1) ], { silent: true });
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Agent', pluginID, secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true } ],
  ]);
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor(agents),
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    compactionAgentContextTokens: 1000,
    estimateTokens: () => 5,
    frameRuntime: { emitRuntimeEvent() {} },
  });

  let frame = await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: windowOf(frameEngine, [ 'msg_1' ]),
    agent: { id: 'agent_1' },
    services: { calls: [] },
  });

  return { frame };
}

function createHoldService(ownWindowTokens) {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('mixed', MixedProvider);
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Agent', pluginID: 'mixed', secrets: {}, config: { contextWindowTokens: ownWindowTokens }, enabled: true } ],
  ]);
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
    frameRuntime: { emitRuntimeEvent() {} },
  });
  return { service, services: { calls: [] } };
}
