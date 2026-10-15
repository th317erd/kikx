'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLiveThreadFrame,
  threadVisibleFrames,
  createThinkingBuffer,
  applyThinkingFrame,
  thinkingAgents,
  thinkingLines,
} from '../../src/client/state/thinking-state.mjs';

test('isLiveThreadFrame flags thinking/delta/typing/streaming frames only', () => {
  assert.equal(isLiveThreadFrame({ type: 'AgentThinking' }), true);
  assert.equal(isLiveThreadFrame({ type: 'AgentMessageDelta' }), true);
  assert.equal(isLiveThreadFrame({ type: 'BeginTyping' }), true);
  assert.equal(isLiveThreadFrame({ type: 'EndTyping' }), true);
  assert.equal(isLiveThreadFrame({ type: 'AgentMessage', content: { status: 'streaming' } }), true);
  assert.equal(isLiveThreadFrame({ type: 'AgentMessage', content: { status: 'complete' } }), false);
  assert.equal(isLiveThreadFrame({ type: 'AgentMessage' }), false);
  assert.equal(isLiveThreadFrame({ type: 'ShellToolFrame' }), false);
  assert.equal(isLiveThreadFrame({ type: 'AgentThinking', hidden: true }), false);
  assert.equal(isLiveThreadFrame(null), false);
});

test('threadVisibleFrames drops hidden, deleted and live frames', () => {
  let frames = [
    { id: 'u1', type: 'UserMessage' },
    { id: 't1', type: 'AgentThinking', responseFrameID: 'r1' },
    { id: 'm1', type: 'AgentMessage', content: { status: 'streaming' } },
    { id: 'm2', type: 'AgentMessage', content: { status: 'complete' } },
    { id: 'h1', type: 'AgentMessage', hidden: true },
    { id: 'd1', type: 'AgentMessage', deleted: true },
  ];

  assert.deepEqual(threadVisibleFrames(frames).map((frame) => frame.id), [ 'u1', 'm2' ]);
});

test('applyThinkingFrame buffers reasoning then streamed answer, per response', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:typing', type: 'BeginTyping', responseFrameID: 'r1', content: { agentID: 'a1', agentName: 'Zav' } });
  applyThinkingFrame(buffer, { id: 'r1:thinking', type: 'AgentThinking', responseFrameID: 'r1', content: { text: 'reasoning…' } });
  applyThinkingFrame(buffer, { id: 'r1:delta', type: 'AgentMessageDelta', responseFrameID: 'r1', content: { text: 'partial answer' } });

  let agents = thinkingAgents(buffer);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'r1');
  assert.equal(agents[0].agentID, 'a1');
  assert.equal(agents[0].name, 'Zav');
  assert.equal(agents[0].text, 'reasoning…\npartial answer');
});

test('a completed AgentMessage removes the response from the rack', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:thinking', type: 'AgentThinking', responseFrameID: 'r1', content: { text: 'x' } });
  assert.equal(thinkingAgents(buffer).length, 1);

  applyThinkingFrame(buffer, { id: 'r1', type: 'AgentMessage', responseFrameID: 'r1', hidden: false, content: { status: 'complete', text: 'done' } });
  assert.deepEqual(thinkingAgents(buffer), []);
});

test('a streaming AgentMessage updates the answer but does not clear the entry', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:delta', type: 'AgentMessageDelta', responseFrameID: 'r1', content: { agentName: 'Zav', text: 'a' } });
  applyThinkingFrame(buffer, { id: 'r1', type: 'AgentMessage', responseFrameID: 'r1', hidden: false, content: { status: 'streaming', text: 'ab' } });

  let agents = thinkingAgents(buffer);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].text, 'ab');
});

test('multiple agents are kept in first-seen order and named', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:t', type: 'BeginTyping', responseFrameID: 'r1', content: { agentID: 'a1', agentName: 'One' } });
  applyThinkingFrame(buffer, { id: 'r2:t', type: 'BeginTyping', responseFrameID: 'r2', content: { agentID: 'a2', agentName: 'Two' } });

  assert.deepEqual(thinkingAgents(buffer).map((agent) => agent.id), [ 'r1', 'r2' ]);
  assert.deepEqual(thinkingAgents(buffer).map((agent) => agent.name), [ 'One', 'Two' ]);
});

test('applyThinkingFrame ignores non-live frames and requires an id', () => {
  let buffer = createThinkingBuffer();
  assert.equal(applyThinkingFrame(buffer, { id: 'x', type: 'ShellToolFrame' }), false);
  assert.equal(applyThinkingFrame(buffer, null), false);
  assert.deepEqual(thinkingAgents(buffer), []);
});

test('thinkingLines keeps the newest lines and caps the count', () => {
  assert.deepEqual(thinkingLines('a\nb\nc'), [ 'a', 'b', 'c' ]);
  assert.deepEqual(thinkingLines('a\nb\nc', 2), [ 'b', 'c' ]);
  assert.deepEqual(thinkingLines(''), [ '' ]);
  assert.deepEqual(thinkingLines(null), [ '' ]);
});
