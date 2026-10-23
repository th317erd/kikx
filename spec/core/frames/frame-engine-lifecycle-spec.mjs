'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../../src/core/frames/frame-engine.mjs';

function engine() {
  return new FrameEngine({
    clock: () => 1000,
    idGenerator: (() => {
      let index = 0;
      return () => `id_${++index}`;
    })(),
  });
}

test('non-tool frames are processed up-front', () => {
  let frames = engine();
  let [ frame ] = frames.merge([ {
    id: 'msg_1',
    type: 'UserMessage',
    createdAt: 500,
    content: { text: 'hello' },
  } ]);

  assert.equal(frame.startedProcessingAt, 500);
  assert.equal(frame.finishedProcessingAt, 500);
});

test('new tool calls remain pending until explicitly started', () => {
  let frames = engine();
  let [ call ] = frames.merge([ {
    id: 'call_1',
    type: 'ShellToolFrame',
    createdAt: 500,
    startedProcessingAt: null,
    finishedProcessingAt: null,
    content: { toolName: 'exec', phase: 'call', status: 'running' },
  } ]);

  assert.equal(call.startedProcessingAt, null);
  assert.equal(call.finishedProcessingAt, null);

  let [ started ] = frames.merge([ { ...call, startedProcessingAt: 600 } ]);
  assert.equal(started.startedProcessingAt, 600);
  assert.equal(started.finishedProcessingAt, null);

  let [ finished ] = frames.merge([ { ...started, finishedProcessingAt: 700 } ]);
  assert.equal(finished.startedProcessingAt, 600);
  assert.equal(finished.finishedProcessingAt, 700);
});

test('legacy running tool calls are treated as started and unfinished', () => {
  let frames = engine();
  frames.hydrate([ {
    id: 'legacy_call',
    type: 'ShellToolFrame',
    createdAt: 400,
    updatedAt: 450,
    content: { toolName: 'exec', phase: 'call', status: 'running' },
  } ]);

  let legacy = frames.get('legacy_call');
  assert.equal(legacy.startedProcessingAt, 400);
  assert.equal(legacy.finishedProcessingAt, null);
});

test('tool result frames are processed up-front', () => {
  let frames = engine();
  let [ result ] = frames.merge([ {
    id: 'result_1',
    type: 'ShellToolFrame',
    createdAt: 500,
    updatedAt: 600,
    content: { toolName: 'exec', phase: 'result', status: 'success' },
  } ]);

  assert.equal(result.startedProcessingAt, 500);
  assert.equal(result.finishedProcessingAt, 500);
});
