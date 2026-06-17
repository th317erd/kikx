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
      hidden: true,
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
