'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
  FrameContextBuilder,
  serializeFramesForCompaction,
} from '../../../src/core/compaction/index.mjs';

test('FrameContextBuilder starts agent memory at latest compaction frame', () => {
  let frames = [
    frame('msg_1', 'UserMessage', 'old user', 1),
    frame('msg_2', 'AgentMessage', 'old agent', 2),
    {
      ...frame('cmp_1', COMPACTION_FRAME_TYPE, 'summary of old user and old agent', 3),
      hidden: false,
      content: {
        kind: COMPACTION_FRAME_KIND,
        status: 'complete',
        text: 'summary of old user and old agent',
        summary: 'summary of old user and old agent',
        boundaryFrameID: 'msg_2',
        boundaryOrder: 2,
      },
    },
    frame('msg_3', 'UserMessage', 'new user', 4),
  ];
  let builder = new FrameContextBuilder({
    contextWindowTokens: 1000,
    promptReserveTokens: 10,
  });

  let result = builder.build(frames, { activeFrameID: 'msg_3' });

  assert.deepEqual(result.frames.map((item) => item.id), [ 'cmp_1', 'msg_3' ]);
  assert.equal(result.latestCompaction.id, 'cmp_1');
});

test('FrameContextBuilder selects a compactable window before the active trigger frame', () => {
  let frames = [
    frame('msg_1', 'UserMessage', 'one', 1),
    frame('msg_2', 'AgentMessage', 'two', 2),
    frame('msg_3', 'UserMessage', 'three', 3),
  ];
  let builder = new FrameContextBuilder({
    contextWindowTokens: 12,
    promptReserveTokens: 1,
    compactionTriggerRatio: 0.1,
    estimateTokens: () => 5,
  });

  let result = builder.build(frames, {
    activeFrameID: 'msg_3',
    compactionContextBudgetTokens: 20,
  });

  assert.equal(result.shouldCompact, true);
  assert.deepEqual(result.compactionWindow.frames.map((item) => item.id), [ 'msg_1', 'msg_2' ]);
  assert.equal(result.compactionWindow.boundaryFrameID, 'msg_2');
  assert.match(serializeFramesForCompaction(result.compactionWindow.frames), /one/);
});

test('FrameContextBuilder selects future compaction windows from boundary order, not hidden frame position', () => {
  let compaction = {
    ...frame('cmp_1', COMPACTION_FRAME_TYPE, 'summary', 99),
    hidden: true,
    content: {
      kind: COMPACTION_FRAME_KIND,
      status: 'complete',
      text: 'summary',
      summary: 'summary',
      boundaryFrameID: 'msg_2',
      boundaryOrder: 2,
    },
  };
  let frames = [
    frame('msg_1', 'UserMessage', 'old one', 1),
    frame('msg_2', 'AgentMessage', 'old two', 2),
    frame('msg_3', 'UserMessage', 'new compactable', 3),
    frame('msg_4', 'UserMessage', 'active request', 4),
    compaction,
  ];
  let builder = new FrameContextBuilder({
    contextWindowTokens: 12,
    promptReserveTokens: 1,
    compactionTriggerRatio: 0.1,
    estimateTokens: () => 5,
  });

  let result = builder.build(frames, {
    activeFrameID: 'msg_4',
    compactionContextBudgetTokens: 20,
  });

  assert.deepEqual(result.frames.map((item) => item.id), [ 'cmp_1', 'msg_3', 'msg_4' ]);
  assert.deepEqual(result.compactionWindow.frames.map((item) => item.id), [ 'cmp_1', 'msg_3' ]);
  assert.equal(result.compactionWindow.boundaryFrameID, 'msg_3');
});

test('FrameContextBuilder triggers off the smallest participant window, not the global window', () => {
  let frames = [
    frame('msg_1', 'UserMessage', 'one', 1),
    frame('msg_2', 'UserMessage', 'two', 2),
  ];
  let builder = new FrameContextBuilder({
    contextWindowTokens: 1000,
    baseReserveTokens: 20,
    compactionTriggerRatio: 0.7,
    estimateTokens: () => 36,
  });

  // hardLimit = 120 - 20 = 100; 0.7 * 100 = 70; history = 72 tokens.
  let result = builder.build(frames, { agentContextWindowTokens: 120 });

  assert.equal(result.hardLimit, 100);
  assert.equal(result.availableTokens, 100);
  assert.equal(result.contextTokens, 72);
  assert.equal(result.shouldCompact, true);
});

test('FrameContextBuilder does not compact below the soft limit at the smallest window', () => {
  let frames = [
    frame('msg_1', 'UserMessage', 'one', 1),
    frame('msg_2', 'UserMessage', 'two', 2),
  ];
  let builder = new FrameContextBuilder({
    contextWindowTokens: 1000,
    baseReserveTokens: 20,
    compactionTriggerRatio: 0.7,
    estimateTokens: () => 34,
  });

  // history = 68 < 70 soft limit, but 68 >= 0 (hard wait = 100).
  let result = builder.build(frames, { agentContextWindowTokens: 120 });

  assert.equal(result.shouldCompact, false);
  assert.equal(result.shouldWaitForCompaction, false);
});

test('FrameContextBuilder waits at the hard limit (smallest window minus reserve)', () => {
  let frames = [
    frame('msg_1', 'UserMessage', 'one', 1),
    frame('msg_2', 'UserMessage', 'two', 2),
  ];
  let builder = new FrameContextBuilder({
    contextWindowTokens: 1000,
    baseReserveTokens: 20,
    compactionTriggerRatio: 0.7,
    hardLimitRatio: 1,
    estimateTokens: () => 50,
  });

  // history = 100 == hardLimit.
  let result = builder.build(frames, { agentContextWindowTokens: 120 });

  assert.equal(result.shouldCompact, true);
  assert.equal(result.shouldWaitForCompaction, true);
});

test('FrameContextBuilder counts non-history overhead toward the trigger', () => {
  let frames = [
    frame('msg_1', 'UserMessage', 'one', 1),
    frame('msg_2', 'UserMessage', 'two', 2),
  ];
  let builder = new FrameContextBuilder({
    contextWindowTokens: 1000,
    baseReserveTokens: 20,
    compactionTriggerRatio: 0.7,
    estimateTokens: () => 25,
  });

  // history alone = 50 < 70; history (50) + overhead (20) = 70 == soft limit.
  let withoutOverhead = builder.build(frames, { agentContextWindowTokens: 120 });
  let withOverhead = builder.build(frames, {
    agentContextWindowTokens: 120,
    usageOverheadTokens: 20,
  });

  assert.equal(withoutOverhead.shouldCompact, false);
  assert.equal(withOverhead.contextTokens, 70);
  assert.equal(withOverhead.usageOverheadTokens, 20);
  assert.equal(withOverhead.shouldCompact, true);
});

test('FrameContextBuilder keeps the global window when no agent window is provided', () => {
  let frames = [ frame('msg_1', 'UserMessage', 'one', 1) ];
  let builder = new FrameContextBuilder({
    contextWindowTokens: 1000,
    baseReserveTokens: 20,
    estimateTokens: () => 5,
  });

  let result = builder.build(frames);

  assert.equal(result.hardLimit, 980);
  assert.equal(result.availableTokens, 980);
});

test('FrameContextBuilder starts projection after a trimmed boundary and keeps old frames', () => {
  let old = [
    frame('msg_1', 'UserMessage', 'old one', 1),
    frame('msg_2', 'UserMessage', 'old two', 2),
  ];
  let trimmed = {
    ...frame('cmp_trim', COMPACTION_FRAME_TYPE, '', 3),
    hidden: false,
    content: {
      kind: COMPACTION_FRAME_KIND,
      status: 'trimmed',
      text: 'Context was trimmed to proceed.',
      summary: '',
      warnings: [ 'Compaction failed; context was trimmed to proceed.' ],
      errors: [ { message: 'provider exploded', at: 3, kind: 'compaction' } ],
      boundaryFrameID: 'msg_2',
      boundaryOrder: 2,
    },
  };
  let frames = [ ...old, trimmed, frame('msg_3', 'UserMessage', 'new user', 4) ];
  let builder = new FrameContextBuilder({ contextWindowTokens: 1000, promptReserveTokens: 10 });

  let result = builder.build(frames, { activeFrameID: 'msg_3' });

  assert.equal(result.latestCompaction.id, 'cmp_trim');
  assert.deepEqual(result.frames.map((item) => item.id), [ 'cmp_trim', 'msg_3' ]);
  // Nothing is deleted: the old frames remain in `allFrames` and in storage.
  assert.deepEqual(result.allFrames.map((item) => item.id), [ 'msg_1', 'msg_2', 'cmp_trim', 'msg_3' ]);
});

test('FrameContextBuilder treats a failed boundary as a boundary and ignores an in-flight one', () => {
  let failed = {
    ...frame('cmp_failed', COMPACTION_FRAME_TYPE, 'failed', 3),
    content: {
      kind: COMPACTION_FRAME_KIND,
      status: 'failed',
      summary: '',
      boundaryFrameID: 'msg_2',
      boundaryOrder: 2,
    },
  };
  let frames = [
    frame('msg_1', 'UserMessage', 'old one', 1),
    frame('msg_2', 'UserMessage', 'old two', 2),
    failed,
    frame('msg_3', 'UserMessage', 'new user', 4),
  ];
  let builder = new FrameContextBuilder({ contextWindowTokens: 1000, promptReserveTokens: 10 });

  let result = builder.build(frames, { activeFrameID: 'msg_3' });
  assert.equal(result.latestCompaction.id, 'cmp_failed');
  assert.deepEqual(result.frames.map((item) => item.id), [ 'cmp_failed', 'msg_3' ]);

  // An in-flight `running` boundary is not yet a boundary to start from.
  let running = { ...failed, id: 'cmp_running', content: { ...failed.content, status: 'running' } };
  let inFlight = new FrameContextBuilder({ contextWindowTokens: 1000, promptReserveTokens: 10 })
    .build([ frame('msg_1', 'UserMessage', 'old one', 1), running, frame('msg_2', 'UserMessage', 'new', 2) ], { activeFrameID: 'msg_2' });
  assert.equal(inFlight.latestCompaction, null);
});

function frame(id, type, text, order) {
  return {
    id,
    type,
    order,
    sessionID: 'ses_1',
    interactionID: `int_${order}`,
    authorType: type === 'UserMessage' ? 'user' : 'agent',
    authorID: type === 'UserMessage' ? 'user' : 'agent_1',
    createdAt: order,
    updatedAt: order,
    timestamp: order,
    hidden: false,
    deleted: false,
    content: { text },
  };
}
