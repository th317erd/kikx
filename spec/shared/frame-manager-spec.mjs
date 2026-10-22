'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FrameManager,
  countMessageFrames,
  projectFrameMessages,
  upsertFrameMessages,
} from '../../src/shared/frame-manager/frame-manager.mjs';


function projectedVisibleCount(frames) {
  return projectFrameMessages(frames).filter((frame) => Boolean(frame?.id)
    && frame.hidden !== true
    && frame.deleted !== true
    && frame.phantom !== true
    && frame.type !== 'MessageDone').length;
}

function toolCall(id, toolCallID, overrides = {}) {
  return {
    id,
    type: 'ShellToolFrame',
    hidden: false,
    content: { toolName: 'exec', phase: 'call', toolCallID },
    ...overrides,
  };
}

function toolResult(id, toolCallID, callID, overrides = {}) {
  return {
    id,
    type: 'ShellToolFrame',
    parentID: callID,
    hidden: false,
    content: { toolName: 'exec', phase: 'result', toolCallID, toolCallFrameID: callID },
    ...overrides,
  };
}

test('countMessageFrames matches the collapsed projection for tool visibility edge cases', () => {
  let fixtures = [
    [ toolCall('call', 'tc'), toolResult('result', 'tc', 'call') ],
    [ toolResult('result', 'tc', 'call'), toolCall('call', 'tc') ],
    [ toolCall('call', 'tc', { hidden: true }), toolResult('result', 'tc', 'call') ],
    [ toolCall('call', 'tc'), toolResult('result', 'tc', 'call', { hidden: true }) ],
    [ toolCall('call', 'tc', { hidden: true }), toolResult('result', 'tc', 'call', { hidden: undefined }) ],
    [ toolCall('call', 'tc'), toolResult('orphan', 'tc', 'missing') ],
    [ toolCall('orphan', 'tc') ],
    [ { id: 'done', type: 'MessageDone', hidden: true }, { id: 'visible', type: 'UserMessage', hidden: false } ],
    [ { id: 'phantom', type: 'UserMessage', hidden: false, phantom: true }, { id: 'visible', type: 'UserMessage', hidden: false } ],
    [ toolCall('call1', 'tc1'), toolCall('call2', 'tc2') ],
  ];

  for (let frames of fixtures) {
    assert.equal(
      countMessageFrames(frames),
      projectedVisibleCount(frames),
      `count mismatch for ${frames.map((frame) => frame.id).join(', ')}`,
    );
  }
});

test('countMessageFrames scales linearly with tool-heavy frame history', () => {
  let frames = [];
  for (let index = 0; index < 4000; index++) {
    frames.push(toolCall(`call_${index}`, `tc_${index}`));
    frames.push(toolResult(`result_${index}`, `tc_${index}`, `call_${index}`));
  }

  let startedAt = performance.now();
  let count = countMessageFrames(frames);
  let elapsedMs = performance.now() - startedAt;

  assert.equal(count, 4000);
  assert.ok(elapsedMs < 750, `counting 8000 frames took ${elapsedMs.toFixed(1)}ms`);
});

test('FrameManager stitches raw frames into visible message heads', () => {
  let messages = projectFrameMessages([
    {
      id: 'agent_1',
      type: 'AgentMessage',
      order: 1,
      createdClock: '0000000001001000-000000-runner',
      updatedClock: '0000000009000000-000000-runner',
      hidden: false,
      content: {
        text: 'answer',
        status: 'complete',
      },
      state: {
        lifecycle: {
          status: 'closed',
          closedClock: '0000000001002000-000000-runner',
          closedAt: 1002,
        },
      },
    },
    {
      id: 'agent_1:done',
      type: 'MessageDone',
      order: 2,
      parentID: 'agent_1',
      hidden: true,
      content: {
        frameID: 'agent_1',
      },
    },
    {
      id: 'user_1',
      type: 'UserMessage',
      order: 3,
      createdClock: '0000000001003000-000000-runner',
      updatedClock: '0000000001003000-000000-runner',
      hidden: false,
      content: {
        text: 'next',
      },
    },
  ]);

  assert.deepEqual(messages.map((frame) => frame.id), [ 'agent_1', 'user_1' ]);
  assert.equal(countMessageFrames(messages), 2);
});

test('FrameManager consumes live phantom frames into the response head only until completion', () => {
  let manager = new FrameManager({
    frames: [{
      id: 'user_1',
      type: 'UserMessage',
      hidden: false,
      content: { text: 'hello' },
    }],
  });

  manager.consume({
    id: 'agent_1:thinking',
    type: 'AgentThinking',
    phantom: true,
    responseFrameID: 'agent_1',
    parentID: 'user_1',
    content: {
      thinking: {
        text: 'thinking',
        status: 'streaming',
      },
    },
  });
  assert.equal(manager.toMessages()[1].content.thinking.text, 'thinking');

  manager.consume({
    id: 'agent_1',
    type: 'AgentMessage',
    parentID: 'user_1',
    hidden: false,
    content: {
      text: 'final',
      thinking: {
        text: 'done',
        status: 'complete',
      },
      status: 'complete',
    },
  });
  manager.consume({
    id: 'agent_1:late-thinking',
    type: 'AgentThinking',
    phantom: true,
    responseFrameID: 'agent_1',
    parentID: 'user_1',
    content: {
      thinking: {
        text: 'late',
        status: 'streaming',
      },
    },
  });

  assert.deepEqual(manager.toMessages().map((frame) => frame.id), [ 'user_1', 'agent_1' ]);
  assert.equal(manager.toMessages()[1].content.text, 'final');
  assert.equal(manager.toMessages()[1].content.thinking.text, 'done');
});

test('upsertFrameMessages collapses tool call and result frames into one message', () => {
  let messages = upsertFrameMessages([], [{
    id: 'tool_call_1',
    type: 'ReadFileToolFrame',
    hidden: false,
    content: {
      toolName: 'read-file',
      phase: 'call',
      toolCallID: 'call_1',
    },
  }]);

  messages = upsertFrameMessages(messages, [{
    id: 'tool_result_1',
    type: 'ReadFileToolFrame',
    parentID: 'tool_call_1',
    hidden: false,
    content: {
      toolName: 'read-file',
      phase: 'result',
      toolCallID: 'call_1',
      toolCallFrameID: 'tool_call_1',
      preview: 'done',
    },
  }]);

  assert.deepEqual(messages.map((frame) => frame.id), [ 'tool_call_1' ]);
  assert.equal(messages[0].content.phase, 'result');
  assert.equal(messages[0].content.preview, 'done');
  assert.equal(messages[0].content.toolResultFrameID, 'tool_result_1');
});
