'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { renderedFrameIDsFor } from '../../src/client/components/frame-runtime-batch.mjs';

test('a tool result touches the call frame it merges into', () => {
  let ids = renderedFrameIDsFor({
    id: 'result-1',
    type: 'ShellToolFrame',
    parentID: 'call-1',
    content: {
      phase: 'result',
      toolName: 'exec',
      toolCallID: 'call-id',
      toolCallFrameID: 'call-1',
    },
  });

  assert.deepEqual([ ...ids ].sort(), [ 'call-1', 'result-1' ]);
});

test('a tool result without a linked call frame only touches itself', () => {
  let ids = renderedFrameIDsFor({
    id: 'result-2',
    type: 'ToolResult',
    content: { phase: 'result', toolName: 'exec' },
  });

  assert.deepEqual([ ...ids ], [ 'result-2' ]);
});

test('ordinary frames keep their existing touched-id behavior', () => {
  let ids = renderedFrameIDsFor({
    id: 'message-1',
    type: 'AgentMessage',
    content: { text: 'hello' },
  });

  assert.deepEqual([ ...ids ], [ 'message-1' ]);
});
