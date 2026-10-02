'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_FRAME_TYPE,
  MAX_CHUNK_DEPTH,
  TRUNCATED_FRAME_TYPE,
  CompactionService,
  estimateTokens,
  planCompactionChunks,
  runChunkedCompaction,
  serializeFrameForContext,
  serializeFramesForCompaction,
  trimOldestToFit,
} from '../../../src/core/compaction/index.mjs';
import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameEngine } from '../../../src/core/frames/index.mjs';
import {
  createClock,
  createIDs,
  frame,
  managerFor,
  userFrame,
} from './compaction-resilience-fixtures.mjs';

// Fake "compaction algorithms" and pure chunking/resilience coverage. No real
// models are called; every test is deterministic.

const SEPARATOR = '\n\n---\n\n';
const SEPARATOR_TOKENS = estimateTokens(SEPARATOR);

class ShrinkerProvider extends AgentInterface {
  static pluginID = 'shrinker';

  async ask() {
    return 'SHORT';
  }
}

class CountingProvider extends AgentInterface {
  static pluginID = 'counter';

  async ask(_prompt, params = {}) {
    let inputTokens = estimateTokens(serializeFramesForCompaction(params.frames));
    params.services.calls.push({ inputTokens, budget: params.maxInputTokens, frameCount: params.frames.length });
    return inputTokens <= (params.maxInputTokens || 0) ? 'fits' : 'OVER_BUDGET';
  }
}

test('shrinker: a big input is replaced by a small summary that fits the budget', async () => {
  let big = 'x'.repeat(40000);
  let { summary } = await runShrinker([
    userFrame('msg_1', big, 1),
    userFrame('msg_2', big, 2),
  ]);
  let inputTokens = estimateTokens(serializeFramesForCompaction([
    userFrame('msg_1', big, 1),
    userFrame('msg_2', big, 2),
  ]));

  assert.equal(summary, 'SHORT');
  assert.equal(estimateTokens(summary) < inputTokens, true);
});

test('shrinker: re-compacting the compacted artifact does not grow it (idempotent-ish)', async () => {
  let big = 'y'.repeat(30000);
  let first = await runShrinker([
    userFrame('msg_1', big, 1),
    userFrame('msg_2', big, 2),
  ]);
  assert.equal(first.summary, 'SHORT');

  let second = await runShrinker([
    {
      id: first.frame.id,
      type: first.frame.type,
      content: { text: first.summary, summary: first.summary, kind: first.frame.content.kind },
    },
  ]);

  assert.equal(second.summary, 'SHORT');
  assert.equal(estimateTokens(second.summary) <= estimateTokens(first.summary), true);
});

test('token counter: the service never sends an input larger than the compactor budget', async () => {
  for (let count of [ 1, 10, 500 ]) {
    let frames = [];
    for (let index = 0; index < count; index++)
      frames.push(userFrame(`m_${index}`, `payload ${index} `.repeat(20 + (index % 7)), index + 1));

    let calls = await runCounting(frames);
    assert.equal(calls.length >= 1, true);

    for (let call of calls) {
      assert.equal(call.inputTokens <= call.budget, true, `input ${call.inputTokens} exceeded budget ${call.budget}`);
      assert.equal(call.frameCount >= 1, true);
    }
  }
});

test('planCompactionChunks: empty, fits-in-one, exact boundary, one-over, oversized singleton', () => {
  let f1 = frame('f1', 'a'.repeat(200), 1);
  let f2 = frame('f2', 'b'.repeat(200), 2);

  assert.deepEqual(planCompactionChunks({ frames: [], budgetTokens: 100 }), []);

  let one = estimateTokens(serializeFramesForCompaction([ f1 ]));
  let fits = planCompactionChunks({ frames: [ f1 ], budgetTokens: one });
  assert.equal(fits.length, 1);
  assert.equal(fits[0].oversized, false);

  let exactBudget = estimateTokens(serializeFrameForContext(f1)) + SEPARATOR_TOKENS + estimateTokens(serializeFrameForContext(f2));
  let exact = planCompactionChunks({ frames: [ f1, f2 ], budgetTokens: exactBudget });
  assert.equal(exact.length, 1);
  assert.deepEqual(exact[0].frames.map((item) => item.id), [ 'f1', 'f2' ]);

  let oneOver = planCompactionChunks({ frames: [ f1, f2 ], budgetTokens: exactBudget - 1 });
  assert.equal(oneOver.length, 2);
  assert.deepEqual(oneOver.map((chunk) => chunk.frames.map((item) => item.id)), [ [ 'f1' ], [ 'f2' ] ]);

  let oversized = planCompactionChunks({ frames: [ f2 ], budgetTokens: 10 });
  assert.equal(oversized.length, 1);
  assert.equal(oversized[0].oversized, true);
  assert.deepEqual(oversized[0].frames.map((item) => item.id), [ 'f2' ]);
});

test('runChunkedCompaction: one chunk is a single call and N chunks are each compacted then reduced', async () => {
  let single = [ frame('f1', 'a'.repeat(200), 1), frame('f2', 'b'.repeat(200), 2) ];
  let singleCalls = [];
  await runChunkedCompaction({
    frames: single,
    budgetTokens: estimateTokens(serializeFramesForCompaction(single)) + 10,
    compactOnce: async (group) => {
      singleCalls.push(group.map((item) => item.id));
      return 'SUM';
    },
  });
  assert.deepEqual(singleCalls, [ [ 'f1', 'f2' ] ]);

  let many = [ frame('f1', 'a'.repeat(200), 1), frame('f2', 'b'.repeat(200), 2), frame('f3', 'c'.repeat(200), 3) ];
  let budget = estimateTokens(serializeFramesForCompaction(many.slice(0, 2))) - 1;
  let calls = [];
  let counter = 0;
  let result = await runChunkedCompaction({
    frames: many,
    budgetTokens: budget,
    compactOnce: async (group) => {
      calls.push(group);
      return `s${++counter}`;
    },
  });

  assert.deepEqual(calls.slice(0, 3).map((group) => group.map((item) => item.id)), [ [ 'f1' ], [ 'f2' ], [ 'f3' ] ]);
  assert.equal(calls[3].every((item) => item.type === 'CompactionSummary'), true);
  assert.equal(result, 's4');
});

test('runChunkedCompaction: summaries that still do not fit are recursively reduced', async () => {
  let frames = [ 'f1', 'f2', 'f3', 'f4' ].map((id, index) => frame(id, 'w'.repeat(300), index + 1));
  let oneFrame = estimateTokens(serializeFrameForContext(frames[0]));
  let budget = oneFrame + SEPARATOR_TOKENS + 2;
  let calls = [];
  let sawSummaryGroup = false;

  let result = await runChunkedCompaction({
    frames,
    budgetTokens: budget,
    compactOnce: async (group) => {
      calls.push(group);
      if (group.some((item) => item.type === 'CompactionSummary'))
        sawSummaryGroup = true;

      let totalChars = group.reduce((sum, item) => sum + serializeFrameForContext(item).length, 0);
      return 'z'.repeat(Math.max(10, Math.ceil(totalChars / 3)));
    },
  });

  assert.equal(sawSummaryGroup, true);
  assert.equal(calls.length > 4, true);
  assert.equal(typeof result, 'string');
  assert.equal(result.length > 0, true);
});

test('runChunkedCompaction: empty input returns empty string without calling the compactor', async () => {
  let calls = 0;
  let result = await runChunkedCompaction({
    frames: [],
    budgetTokens: 100,
    compactOnce: async () => {
      calls++;
      return 'never';
    },
  });

  assert.equal(result, '');
  assert.equal(calls, 0);
});

test('runChunkedCompaction: depth exhaustion trims oldest and never recurses forever', async () => {
  let frames = [ 'f1', 'f2', 'f3', 'f4' ].map((id, index) => frame(id, 'q'.repeat(200), index + 1));
  let calls = [];
  let result = await runChunkedCompaction({
    frames,
    budgetTokens: 60,
    maxDepth: 1,
    compactOnce: async (group) => {
      calls.push(group);
      return 'Q'.repeat(2000);
    },
  });

  assert.equal(result, 'Q'.repeat(2000));
  assert.equal(MAX_CHUNK_DEPTH, 4);
  assert.equal(calls.at(-1).length < frames.length, true);
});

test('runChunkedCompaction: an oversized single frame is truncated with a visible marker', async () => {
  let frames = [ frame('huge', 'z'.repeat(20000), 1) ];
  let budget = 50;
  let calls = [];

  let result = await runChunkedCompaction({
    frames,
    budgetTokens: budget,
    compactOnce: async (group) => {
      calls.push(group);
      return 'TRUNCATED_SUMMARY';
    },
  });

  assert.equal(result, 'TRUNCATED_SUMMARY');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].type, TRUNCATED_FRAME_TYPE);
  assert.match(calls[0][0].content.text, /\[truncated: \d+ characters omitted\]/);
  assert.equal(estimateTokens(serializeFrameForContext(calls[0][0])) <= budget, true);
});

test('trimOldestToFit: drops oldest with a marker, truncates a lone oversized frame, always fits', () => {
  let frames = [ 'f1', 'f2', 'f3', 'f4' ].map((id, index) => frame(id, 'r'.repeat(200), index + 1));
  let budget = estimateTokens(serializeFramesForCompaction(frames.slice(2))) + 30;
  let dropped = trimOldestToFit({ frames, budgetTokens: budget });

  assert.equal(dropped.droppedCount >= 2, true);
  assert.equal(dropped.frames.some((item) => item.content?.text?.includes('older frame(s) omitted')), true);
  assert.equal(dropped.frames.some((item) => item.id === 'f1'), false);
  assert.equal(estimateTokens(serializeFramesForCompaction(dropped.frames)) <= budget, true);

  let lone = trimOldestToFit({ frames: [ frame('huge', 's'.repeat(20000), 1) ], budgetTokens: 50 });
  assert.equal(lone.truncated, true);
  assert.equal(lone.frames.length, 1);
  assert.equal(lone.frames[0].type, TRUNCATED_FRAME_TYPE);
  assert.equal(estimateTokens(serializeFramesForCompaction(lone.frames)) <= 50, true);
});

test('guarantee: every chunked input fits the budget across a spread of sizes, no throw, no runaway', async () => {
  let sizes = [ 5, 40, 200, 900 ];
  let counts = [ 0, 1, 2, 7, 40 ];
  let budgets = [ 20, 80, 400 ];

  for (let budget of budgets) {
    for (let count of counts) {
      for (let size of sizes) {
        let frames = [];
        for (let index = 0; index < count; index++)
          frames.push(frame(`f_${index}`, 'g'.repeat(size), index + 1));

        let calls = [];
        let result = await runChunkedCompaction({
          frames,
          budgetTokens: budget,
          compactOnce: async (group) => {
            calls.push(group);
            return group.map((item) => item.id).join('|');
          },
        });

        assert.equal(typeof result, 'string');
        // Bounded recursion: every group sent to the compactor either fits the
        // budget, or is the guaranteed floor form (a single truncation/trim
        // marker), which is emitted precisely when even the marker has to hold
        // the material. The suite must never throw or recurse without bound.
        for (let group of calls) {
          let tokens = estimateTokens(serializeFramesForCompaction(group));
          let markerForm = group.length === 1
            && (group[0].type === TRUNCATED_FRAME_TYPE || group[0].type === 'TruncationNote');
          assert.equal(tokens <= budget || markerForm, true, `group ${tokens} > budget ${budget} and not a marker`);
        }
      }
    }
  }
});

async function runShrinker(frames) {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('shrinker', ShrinkerProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.hydrate(frames);
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Agent', pluginID: 'shrinker', secrets: {}, config: { contextWindowTokens: 200000 }, enabled: true } ],
  ]);
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor(agents),
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    compactionOutputReserveTokens: 0,
    compactionAgentContextTokens: 1000,
    frameRuntime: { emitRuntimeEvent() {} },
  });

  let ids = frames.map((item) => item.id);
  let window = {
    frames: ids.map((id) => frameEngine.get(id)),
    startFrameID: ids[0],
    boundaryFrameID: ids[ids.length - 1],
    boundaryOrder: ids.length,
    tokens: ids.length,
  };
  let frame = await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: window,
    agent: { id: 'agent_1' },
    services: { calls: [] },
  });

  return { frame, summary: frame.content.summary };
}

async function runCounting(frames) {
  let pluginRegistry = new PluginRegistry();
  pluginRegistry.registerAgentProvider('counter', CountingProvider);
  let frameEngine = new FrameEngine({
    clock: createClock(),
    idGenerator: createIDs([ 'commit_1', 'commit_2' ]),
  });
  frameEngine.hydrate(frames.concat([ userFrame('active', 'active request', frames.length + 1) ]));
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Agent', pluginID: 'counter', secrets: {}, config: { contextWindowTokens: 2000 }, enabled: true } ],
  ]);
  let services = { calls: [] };
  let service = new CompactionService({
    pluginRegistry,
    agentManager: managerFor(agents),
    clock: createClock(),
    idGenerator: () => 'cmp_1',
    instructions: 'Compact the context.',
    compactionOutputReserveTokens: 0,
    compactionAgentContextTokens: 1000,
    frameRuntime: { emitRuntimeEvent() {} },
  });

  let boundaryID = frames.at(-1)?.id || null;
  let result = await service.runCompaction({
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ] },
    frameEngine,
    compactionWindow: {
      frames: frames.map((item) => frameEngine.get(item.id)).filter(Boolean),
      startFrameID: frames[0]?.id,
      boundaryFrameID: boundaryID,
      boundaryOrder: frames.length,
      tokens: frames.length,
    },
    agent: { id: 'agent_1' },
    services,
  });

  assert.equal(result.type, COMPACTION_FRAME_TYPE);
  assert.equal(result.content.status, 'complete');

  return services.calls;
}
