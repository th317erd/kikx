'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FRAME_PRIORITY,
  framePriority,
  insertByFramePriority,
} from '../../src/shared/frame-priority.mjs';

test('conversation frames outrank command and hidden frames', () => {
  assert.equal(framePriority({ type: 'UserMessage', authorType: 'user' }), FRAME_PRIORITY.message);
  assert.equal(framePriority({ type: 'AgentMessage' }), FRAME_PRIORITY.message);
  assert.equal(framePriority({ type: 'Question' }), FRAME_PRIORITY.message);
  assert.equal(framePriority({ type: 'AgentProgress' }), FRAME_PRIORITY.activity);
  assert.equal(framePriority({ type: 'ShellToolFrame' }), FRAME_PRIORITY.command);
  assert.equal(framePriority({ type: 'ToolCall' }), FRAME_PRIORITY.command);
  assert.equal(framePriority({ type: 'UserMessage', authorType: 'system', hidden: true }), FRAME_PRIORITY.hidden);
  assert.equal(framePriority({ type: 'UserDraft' }), FRAME_PRIORITY.hidden);

  assert.ok(framePriority({ type: 'UserMessage', authorType: 'user' }) < framePriority({ type: 'ShellToolFrame' }));
  assert.ok(framePriority({ type: 'AgentMessage' }) < framePriority({ type: 'ShellToolFrame' }));
});

test('priority insertion is stable inside a tier and jumps messages ahead of commands', () => {
  let queue = [];
  insertByFramePriority(queue, { id: 'command-1', priority: FRAME_PRIORITY.command });
  insertByFramePriority(queue, { id: 'command-2', priority: FRAME_PRIORITY.command });
  insertByFramePriority(queue, { id: 'user', priority: FRAME_PRIORITY.message });
  insertByFramePriority(queue, { id: 'activity', priority: FRAME_PRIORITY.activity });
  insertByFramePriority(queue, { id: 'command-3', priority: FRAME_PRIORITY.command });

  assert.deepEqual(queue.map((entry) => entry.id), [
    'user',
    'activity',
    'command-1',
    'command-2',
    'command-3',
  ]);
});
