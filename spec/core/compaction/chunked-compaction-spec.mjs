'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_CHUNK_DEPTH,
  TRUNCATED_FRAME_TYPE,
  estimateTokens,
  planCompactionChunks,
  runChunkedCompaction,
  serializeFrameForContext,
  serializeFramesForCompaction,
  trimOldestToFit,
} from '../../../src/core/compaction/index.mjs';

const SEPARATOR_TOKENS = estimateTokens('\n\n---\n\n');

test('planCompactionChunks keeps fitting frames together in one chunk', () => {
  let frames = [ frame('f1', 'a'.repeat(200), 1), frame('f2', 'b'.repeat(200), 2) ];
  let budget = estimateTokens(serializeFramesForCompaction(frames)) + 10;

  let chunks = planCompactionChunks({ frames, budgetTokens: budget });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].oversized, false);
  assert.deepEqual(chunks[0].frames.map((item) => item.id), [ 'f1', 'f2' ]);
});

test('planCompactionChunks splits greedily oldest-first when the next frame would overflow', () => {
  let frames = [ frame('f1', 'a'.repeat(200), 1), frame('f2', 'b'.repeat(200), 2), frame('f3', 'c'.repeat(200), 3) ];
  let oneFrame = estimateTokens(serializeFrameForContext(frames[0]));
  let budget = oneFrame + SEPARATOR_TOKENS + 2;

  let chunks = planCompactionChunks({ frames, budgetTokens: budget });

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.frames.map((item) => item.id)), [ [ 'f1' ], [ 'f2' ], [ 'f3' ] ]);
  assert.equal(chunks.every((chunk) => chunk.oversized === false), true);
});

test('planCompactionChunks marks a single frame larger than the budget as oversized', () => {
  let frames = [ frame('small', 'a'.repeat(40), 1), frame('huge', 'x'.repeat(20000), 2) ];
  let budget = 50;

  let chunks = planCompactionChunks({ frames, budgetTokens: budget });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].oversized, true);
  assert.deepEqual(chunks[1].frames.map((item) => item.id), [ 'huge' ]);
});

test('runChunkedCompaction fits everything in one call and passes all frames through', async () => {
  let frames = [ frame('f1', 'a'.repeat(200), 1), frame('f2', 'b'.repeat(200), 2) ];
  let budget = estimateTokens(serializeFramesForCompaction(frames)) + 10;
  let calls = [];

  let result = await runChunkedCompaction({
    frames,
    budgetTokens: budget,
    compactOnce: async (group) => {
      calls.push(group);
      return 'SUM';
    },
  });

  assert.equal(result, 'SUM');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((item) => item.id), [ 'f1', 'f2' ]);
});

test('runChunkedCompaction compacts each chunk then reduces the summaries', async () => {
  let frames = [ frame('f1', 'a'.repeat(200), 1), frame('f2', 'b'.repeat(200), 2), frame('f3', 'c'.repeat(200), 3) ];
  // Small enough to force one frame per chunk, large enough for the three short
  // summaries to reduce in a single final call.
  let budget = estimateTokens(serializeFramesForCompaction(frames.slice(0, 2))) - 1;
  let calls = [];
  let counter = 0;

  let result = await runChunkedCompaction({
    frames,
    budgetTokens: budget,
    compactOnce: async (group) => {
      calls.push(group);
      return `s${++counter}`;
    },
  });

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(0, 3).map((group) => group.map((item) => item.id)), [ [ 'f1' ], [ 'f2' ], [ 'f3' ] ]);
  assert.equal(calls[3].every((item) => item.type === 'CompactionSummary'), true);
  assert.equal(result, 's4');
});

test('runChunkedCompaction recursively reduces summaries that still do not fit', async () => {
  let frames = [
    frame('f1', 'a'.repeat(300), 1),
    frame('f2', 'b'.repeat(300), 2),
    frame('f3', 'c'.repeat(300), 3),
    frame('f4', 'd'.repeat(300), 4),
  ];
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

test('runChunkedCompaction truncates an oversized single frame with an explicit marker', async () => {
  let frames = [ frame('huge', 'x'.repeat(20000), 1) ];
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
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0].type, TRUNCATED_FRAME_TYPE);
  assert.match(calls[0][0].content.text, /\[truncated: \d+ characters omitted\]/);
  assert.equal(estimateTokens(serializeFrameForContext(calls[0][0])) <= budget, true);
});

test('runChunkedCompaction falls back to oldest-trim when the depth guard is exhausted', async () => {
  let frames = [ frame('f1', 'a'.repeat(200), 1), frame('f2', 'b'.repeat(200), 2), frame('f3', 'c'.repeat(200), 3), frame('f4', 'd'.repeat(200), 4) ];
  let budget = 60;
  let calls = [];

  let result = await runChunkedCompaction({
    frames,
    budgetTokens: budget,
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

test('runChunkedCompaction returns an empty string for empty input', async () => {
  let calls = [];
  let result = await runChunkedCompaction({
    frames: [],
    budgetTokens: 100,
    compactOnce: async (group) => {
      calls.push(group);
      return 'never';
    },
  });

  assert.equal(result, '');
  assert.equal(calls.length, 0);
});

test('planCompactionChunks returns no chunks for empty input', () => {
  assert.deepEqual(planCompactionChunks({ frames: [], budgetTokens: 100 }), []);
});

test('trimOldestToFit drops oldest frames and marks the loss when material was dropped', () => {
  let frames = [ frame('f1', 'a'.repeat(200), 1), frame('f2', 'b'.repeat(200), 2), frame('f3', 'c'.repeat(200), 3), frame('f4', 'd'.repeat(200), 4) ];
  // Room for the two newest frames plus a visible trim marker.
  let budget = estimateTokens(serializeFramesForCompaction(frames.slice(2))) + 30;

  let result = trimOldestToFit({ frames, budgetTokens: budget });

  assert.equal(result.droppedCount >= 2, true);
  assert.equal(result.truncated, false);
  assert.equal(result.frames.some((item) => item.content?.text?.includes('older frame(s) omitted')), true);
  assert.equal(result.frames.some((item) => item.id === 'f1'), false);
  assert.equal(result.frames.some((item) => item.id === 'f2'), false);
  assert.equal(result.frames.at(-1).id, 'f4');
  assert.equal(estimateTokens(serializeFramesForCompaction(result.frames)) <= budget, true);
});

test('trimOldestToFit truncates a lone oversized frame instead of dropping it', () => {
  let frames = [ frame('huge', 'x'.repeat(20000), 1) ];
  let budget = 50;

  let result = trimOldestToFit({ frames, budgetTokens: budget });

  assert.equal(result.droppedCount, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].type, TRUNCATED_FRAME_TYPE);
  assert.match(result.frames[0].content.text, /characters omitted/);
});

function frame(id, text, order) {
  return {
    id,
    type: 'UserMessage',
    sessionID: 'ses_1',
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
