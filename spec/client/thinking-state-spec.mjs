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

test('threadVisibleFrames drops hidden, soft-deleted and live frames by default', () => {
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

test('threadVisibleFrames reveals soft-deleted frames on request, but never hidden ones', () => {
  let frames = [
    { id: 'u1', type: 'UserMessage' },
    { id: 'd1', type: 'AgentMessage', deleted: true },
    { id: 'h1', type: 'AgentMessage', hidden: true },
    { id: 'hd', type: 'AgentMessage', hidden: true, deleted: true },
  ];

  // The Deleted reveal is the only thing that brings soft-deleted content back.
  assert.deepEqual(
    threadVisibleFrames(frames, { includeDeleted: true }).map((frame) => frame.id),
    [ 'u1', 'd1' ],
    'hidden frames stay out even when deleted content is revealed',
  );
});

test('threadVisibleFrames hides a completed tool call when its result is visible', () => {
  let call = {
    id: 'call_1',
    type: 'ShellToolFrame',
    content: { phase: 'call', toolName: 'exec', toolCallID: 'tool_1', input: { command: 'npm test' } },
  };
  let result = {
    id: 'result_1',
    type: 'ShellToolFrame',
    content: { phase: 'result', toolName: 'exec', toolCallID: 'tool_1', toolCallFrameID: 'call_1', input: { command: 'npm test' } },
  };
  let running = {
    id: 'call_2',
    type: 'ShellToolFrame',
    content: { phase: 'call', toolName: 'exec', toolCallID: 'tool_2', input: { command: 'sleep 1' } },
  };

  assert.deepEqual(threadVisibleFrames([ call, result, running ]).map((frame) => frame.id), [ 'result_1', 'call_2' ]);
  assert.deepEqual(threadVisibleFrames([ call, { ...result, hidden: true } ]).map((frame) => frame.id), [ 'call_1' ]);
});

test('applyThinkingFrame buffers reasoning then streamed answer, per response', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:typing', type: 'BeginTyping', responseFrameID: 'r1', content: { agentID: 'a1', agentName: 'Zav' } });
  applyThinkingFrame(buffer, { id: 'r1:thinking', type: 'AgentThinking', responseFrameID: 'r1', content: { text: 'reasoning…' } });
  applyThinkingFrame(buffer, { id: 'r1:delta', type: 'AgentMessageDelta', responseFrameID: 'r1', content: { text: 'partial answer' } });

  let agents = thinkingAgents(buffer);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'a1');
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

test('EndTyping clears the brain even when no final AgentMessage is emitted', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:typing', type: 'BeginTyping', responseFrameID: 'r1', content: { agentID: 'a1', agentName: 'Zav' } });
  applyThinkingFrame(buffer, { id: 'r1:thinking', type: 'AgentThinking', responseFrameID: 'r1', content: { text: 'reasoning' } });
  applyThinkingFrame(buffer, { id: 'r1:typing', type: 'EndTyping', responseFrameID: 'r1', content: { agentID: 'a1' } });

  assert.deepEqual(thinkingAgents(buffer), []);
});

test('MessageDone and AgentError are terminal rack signals too', () => {
  for (let terminal of [
    { id: 'r1:done', type: 'MessageDone', responseFrameID: 'r1', hidden: true, content: { agentID: 'a1' } },
    { id: 'r1:error', type: 'AgentError', responseFrameID: 'r1', hidden: false, content: { agentID: 'a1' } },
  ]) {
    let buffer = createThinkingBuffer();
    applyThinkingFrame(buffer, { id: 'r1:typing', type: 'BeginTyping', responseFrameID: 'r1', content: { agentID: 'a1' } });
    applyThinkingFrame(buffer, terminal);
    assert.deepEqual(thinkingAgents(buffer), []);
  }
});

test('EndTyping clears an entry created before its BeginTyping link is known', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:thinking', type: 'AgentThinking', responseFrameID: 'r1', content: { text: 'reasoning' } });
  assert.equal(thinkingAgents(buffer).length, 1);

  applyThinkingFrame(buffer, { id: 'r1:typing', type: 'EndTyping', responseFrameID: 'r1', content: { agentID: 'a1' } });
  assert.deepEqual(thinkingAgents(buffer), []);
});

test('a late agent link folds a response-keyed brain into the agent brain', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:thinking', type: 'AgentThinking', responseFrameID: 'r1', content: { text: 'reasoning' } });
  applyThinkingFrame(buffer, { id: 'r1:delta', type: 'AgentMessageDelta', responseFrameID: 'r1', authorID: 'a1', content: { text: 'answer' } });

  let agents = thinkingAgents(buffer);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'a1');
  assert.equal(agents[0].text, 'reasoning\nanswer');
});

test('the rack only shows the selected session and never merges its agents across sessions', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 's1:t', type: 'BeginTyping', sessionID: 's1', responseFrameID: 'r1', content: { agentID: 'a1', agentName: 'One' } });
  applyThinkingFrame(buffer, { id: 's2:t', type: 'BeginTyping', sessionID: 's2', responseFrameID: 'r2', content: { agentID: 'a1', agentName: 'One' } });

  assert.deepEqual(thinkingAgents(buffer, 's1').map((agent) => agent.id), [ 'a1' ]);
  assert.deepEqual(thinkingAgents(buffer, 's2').map((agent) => agent.id), [ 'a1' ]);
  assert.equal(thinkingAgents(buffer, 's3').length, 0);
});

test('BeginTyping starts a fresh panel for the agent', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:t', type: 'BeginTyping', responseFrameID: 'r1', content: { agentID: 'a1', agentName: 'Zav' } });
  applyThinkingFrame(buffer, { id: 'r1:d', type: 'AgentMessageDelta', responseFrameID: 'r1', content: { text: 'old answer' } });
  applyThinkingFrame(buffer, { id: 'r2:t', type: 'BeginTyping', responseFrameID: 'r2', content: { agentID: 'a1', agentName: 'Zav' } });

  assert.deepEqual(thinkingAgents(buffer).map((agent) => agent.text), [ '' ]);
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

  assert.deepEqual(thinkingAgents(buffer).map((agent) => agent.id), [ 'a1', 'a2' ]);
  assert.deepEqual(thinkingAgents(buffer).map((agent) => agent.name), [ 'One', 'Two' ]);
});

test('one brain per agent even across multiple responses', () => {
  let buffer = createThinkingBuffer();
  applyThinkingFrame(buffer, { id: 'r1:t', type: 'BeginTyping', responseFrameID: 'r1', content: { agentID: 'a1', agentName: 'Zav' } });
  applyThinkingFrame(buffer, { id: 'r1:d', type: 'AgentMessageDelta', responseFrameID: 'r1', content: { text: 'first' } });
  applyThinkingFrame(buffer, { id: 'r2:t', type: 'BeginTyping', responseFrameID: 'r2', content: { agentID: 'a1', agentName: 'Zav' } });
  applyThinkingFrame(buffer, { id: 'r2:d', type: 'AgentMessageDelta', responseFrameID: 'r2', content: { text: 'second' } });

  let agents = thinkingAgents(buffer);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agentID, 'a1');
  assert.equal(agents[0].text, 'second');
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
