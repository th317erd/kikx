'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countMessageFrames,
  createSessionStateSnapshot,
  mergeSessions,
  setSessionFramesState,
  upsertFramesState,
  upsertFrameState,
  upsertSessionState,
} from '../../src/client/state/session-state-utils.mjs';

test('mergeSessions preserves existing message counts when manifests are missing counts', () => {
  let previous = {
    sessionIDs: [ 'ses_1', 'ses_2' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Old A', messageCount: 3 },
      ses_2: { id: 'ses_2', title: 'Old B', messageCount: 7 },
    },
    framesBySessionID: {
      ses_1: [ { id: 'msg_1', type: 'UserMessage' } ],
    },
  };

  let next = mergeSessions(previous, [
    { id: 'ses_2', title: 'New B' },
    { id: 'ses_1', title: 'New A', messageCount: 4 },
  ]);

  assert.deepEqual(next.sessionIDs, [ 'ses_2', 'ses_1' ]);
  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 4);
  assert.equal(next.sessionDetailsByID.ses_2.messageCount, 7);
  assert.equal(next.sessionDetailsByID.ses_2.title, 'New B');
  assert.deepEqual(next.framesBySessionID.ses_1, [ { id: 'msg_1', type: 'UserMessage' } ]);
  assert.notEqual(next.sessionDetailsByID, previous.sessionDetailsByID);
});

test('setSessionFramesState derives a fallback count only when the manifest has none', () => {
  let previous = {
    sessionIDs: [ 'ses_1', 'ses_2' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Active' },
      ses_2: { id: 'ses_2', title: 'Inactive', messageCount: 11 },
    },
    framesBySessionID: {},
  };

  let next = setSessionFramesState(previous, 'ses_1', [
    { id: 'frm_1', type: 'SystemNotice' },
    { id: 'msg_1', type: 'UserMessage' },
    { id: 'agent_1', type: 'AgentMessage', hidden: false },
    { id: 'tool_1', type: 'ShellToolFrame', hidden: false },
    { id: 'hidden_1', type: 'AgentMessage', hidden: true },
    { id: 'deleted_1', type: 'AgentMessage', deleted: true },
  ]);

  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 4);
  assert.equal(next.sessionDetailsByID.ses_2.messageCount, 11);
  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'agent_1', 'deleted_1', 'frm_1', 'hidden_1', 'msg_1', 'tool_1' ]);
  assert.notEqual(next.framesBySessionID, previous.framesBySessionID);
  assert.notEqual(next.sessionDetailsByID, previous.sessionDetailsByID);
});

test('setSessionFramesState does not reduce an authoritative manifest count with loaded frames', () => {
  let previous = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Large session', messageCount: 1000 },
    },
    framesBySessionID: {},
  };

  let next = setSessionFramesState(previous, 'ses_1', [
    { id: 'msg_1', type: 'UserMessage' },
    { id: 'msg_2', type: 'UserMessage' },
  ]);

  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 1000);
});

test('setSessionFramesState repairs stale manifest under-counts from loaded visible frames', () => {
  let previous = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Stale child session', messageCount: 0 },
    },
    framesBySessionID: {},
  };

  let next = setSessionFramesState(previous, 'ses_1', [
    { id: 'msg_1', type: 'UserMessage' },
    { id: 'agent_1', type: 'AgentMessage', hidden: false },
    { id: 'tool_1', type: 'ShellToolFrame', hidden: false },
    { id: 'hidden_1', type: 'AgentMessage', hidden: true },
  ]);

  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 3);
});

test('upsertSessionState adds new sessions without clearing cached inactive details', () => {
  let previous = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Existing', messageCount: 5 },
    },
    framesBySessionID: {
      ses_1: [ { id: 'msg_1', type: 'UserMessage' } ],
    },
  };

  let next = upsertSessionState(previous, { id: 'ses_2', title: 'Created', messageCount: 0 });

  assert.deepEqual(next.sessionIDs, [ 'ses_2', 'ses_1' ]);
  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 5);
  assert.equal(next.sessionDetailsByID.ses_2.title, 'Created');
  assert.deepEqual(next.framesBySessionID.ses_1, [ { id: 'msg_1', type: 'UserMessage' } ]);
});

test('upsertFrameState appends and replaces frames by id without losing session details', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Scratch', messageCount: 1 },
    },
    framesBySessionID: {
      ses_1: [
        { id: 'msg_1', type: 'UserMessage', content: { text: 'hello' } },
      ],
    },
  };

  let appended = upsertFrameState(state, 'ses_1', {
    id: 'think_1',
    type: 'AgentThinking',
    phantom: true,
    content: { text: 'thinking' },
  });
  let replaced = upsertFrameState(appended, 'ses_1', {
    id: 'think_1',
    type: 'AgentThinking',
    phantom: true,
    content: { text: 'still thinking' },
  });

  assert.deepEqual(replaced.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'think_1' ]);
  assert.equal(replaced.framesBySessionID.ses_1[1].content.text, 'still thinking');
  assert.equal(replaced.sessionDetailsByID.ses_1.messageCount, 1);
});

test('upsertFrameState coalesces grouped phantoms and final agent messages', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Scratch', messageCount: 1 },
    },
    framesBySessionID: {
      ses_1: [
        {
          id: 'msg_1',
          type: 'UserMessage',
          order: 1,
          updatedClock: '0000000001000000-000000-runner',
          content: { text: 'hello' },
        },
        {
          id: 'agent_msg_1',
          type: 'AgentMessage',
          order: 2,
          updatedClock: '0000000001001000-000000-runner',
          parentID: 'msg_1',
          authorID: 'agent_1',
          authorDisplayName: 'Test 1',
          hidden: true,
          content: {
            text: '',
            thinking: { text: '', status: 'pending' },
            status: 'streaming',
          },
        },
      ],
    },
  };

  let typing = upsertFrameState(state, 'ses_1', {
    id: 'typing_1',
    type: 'BeginTyping',
    phantom: true,
    authorID: 'agent_1',
    updatedClock: '0000000001001500-000000-runner',
    content: { agentName: 'Codex' },
  });
  let thinking = upsertFrameState(typing, 'ses_1', {
    id: 'agent_msg_1:thinking',
    type: 'AgentThinking',
    phantom: true,
    responseFrameID: 'agent_msg_1',
    parentID: 'msg_1',
    authorID: 'agent_1',
    authorDisplayName: 'Test 1',
    updatedClock: '0000000001002000-000000-runner',
    content: {
      text: 'thinking',
      thinking: {
        text: 'thinking',
        chunks: { '1': 'thinking' },
        status: 'streaming',
      },
    },
  });
  let delta = upsertFrameState(thinking, 'ses_1', {
    id: 'agent_msg_1',
    type: 'AgentMessageDelta',
    phantom: true,
    responseFrameID: 'agent_msg_1',
    parentID: 'msg_1',
    authorID: 'agent_1',
    authorDisplayName: 'Test 1',
    updatedClock: '0000000001003000-000000-runner',
    content: { text: 'partial' },
  });
  let endTyping = upsertFrameState(delta, 'ses_1', {
    id: 'typing_2',
    type: 'EndTyping',
    phantom: true,
    authorID: 'agent_1',
    updatedClock: '0000000001003500-000000-runner',
  });
  let final = upsertFrameState(endTyping, 'ses_1', {
    id: 'agent_msg_1',
    type: 'AgentMessage',
    parentID: 'msg_1',
    authorID: 'agent_1',
    updatedClock: '0000000001004000-000000-runner',
    content: { text: 'final' },
  });

  assert.deepEqual(thinking.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'agent_msg_1', 'typing:agent_1' ]);
  assert.equal(thinking.framesBySessionID.ses_1[1].type, 'AgentMessage');
  assert.equal(thinking.framesBySessionID.ses_1[1].authorDisplayName, 'Test 1');
  assert.equal(thinking.framesBySessionID.ses_1[1].hidden, true);
  assert.deepEqual(thinking.framesBySessionID.ses_1[1].content.thinking, {
    text: 'thinking',
    chunks: { '1': 'thinking' },
    status: 'streaming',
  });
  assert.deepEqual(delta.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'agent_msg_1', 'typing:agent_1' ]);
  assert.equal(delta.framesBySessionID.ses_1[1].type, 'AgentMessage');
  assert.equal(delta.framesBySessionID.ses_1[1].authorDisplayName, 'Test 1');
  assert.equal(delta.framesBySessionID.ses_1[1].hidden, false);
  assert.equal(delta.framesBySessionID.ses_1[1].content.text, 'partial');
  assert.deepEqual(endTyping.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'agent_msg_1' ]);
  assert.deepEqual(final.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'agent_msg_1' ]);
  assert.equal(final.framesBySessionID.ses_1[1].type, 'AgentMessage');
  assert.equal(final.framesBySessionID.ses_1[1].authorDisplayName, 'Test 1');
  assert.equal(final.framesBySessionID.ses_1[1].content.text, 'final');
  assert.deepEqual(final.framesBySessionID.ses_1[1].content.thinking, {
    text: 'thinking',
    chunks: { '1': 'thinking' },
    status: 'streaming',
  });
});

test('upsertFramesState applies multiple frame updates and sorts once per session snapshot', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Scratch', messageCount: 1 },
    },
    framesBySessionID: {
      ses_1: [
        {
          id: 'msg_1',
          type: 'UserMessage',
          order: 1,
          updatedClock: '0000000001000000-000000-runner',
          content: { text: 'hello' },
        },
        {
          id: 'agent_msg_1',
          type: 'AgentMessage',
          order: 2,
          updatedClock: '0000000001001000-000000-runner',
          parentID: 'msg_1',
          authorID: 'agent_1',
          hidden: true,
          content: {
            text: '',
            thinking: { text: '', chunks: {}, status: 'pending' },
            status: 'streaming',
          },
        },
      ],
    },
  };

  let next = upsertFramesState(state, new Map([
    [ 'ses_1', [
      {
        id: 'agent_msg_1:thinking:1',
        type: 'AgentThinking',
        phantom: true,
        responseFrameID: 'agent_msg_1',
        parentID: 'msg_1',
        authorID: 'agent_1',
        updatedClock: '0000000001002000-000000-runner',
        content: {
          thinking: {
            text: 'first',
            chunks: { '1': 'first' },
            status: 'streaming',
          },
        },
      },
      {
        id: 'agent_msg_1:thinking:2',
        type: 'AgentThinking',
        phantom: true,
        responseFrameID: 'agent_msg_1',
        parentID: 'msg_1',
        authorID: 'agent_1',
        updatedClock: '0000000001003000-000000-runner',
        content: {
          thinking: {
            text: 'first second',
            chunks: { '2': 'second' },
            status: 'streaming',
          },
        },
      },
      {
        id: 'agent_msg_1',
        type: 'AgentMessageDelta',
        phantom: true,
        responseFrameID: 'agent_msg_1',
        parentID: 'msg_1',
        authorID: 'agent_1',
        updatedClock: '0000000001004000-000000-runner',
        content: {
          text: 'partial response',
        },
      },
    ] ],
  ]));

  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'agent_msg_1' ]);
  assert.equal(next.framesBySessionID.ses_1[1].content.text, 'partial response');
  assert.deepEqual(next.framesBySessionID.ses_1[1].content.thinking.chunks, {
    '1': 'first',
    '2': 'second',
  });
  assert.equal(next.framesBySessionID.ses_1[1].content.thinking.text, 'first second');
  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 2);

  let malformed = upsertFramesState(state, new Map([
    [ 'ses_1', [ { type: 'MissingID' } ] ],
  ]));
  assert.deepEqual(malformed.framesBySessionID.ses_1, state.framesBySessionID.ses_1);
});

test('setSessionFramesState collapses tool call and result frames into one visible frame', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Tools', messageCount: 1 },
    },
    framesBySessionID: {},
  };

  let next = setSessionFramesState(state, 'ses_1', [
    {
      id: 'user_1',
      type: 'UserMessage',
      createdAt: 100,
      content: { text: 'list tmp' },
    },
    {
      id: 'tool_call_1',
      type: 'ShellToolFrame',
      createdAt: 200,
      updatedAt: 200,
      authorType: 'agent',
      authorID: 'agent_1',
      authorDisplayName: 'Test Agent',
      content: {
        toolName: 'exec',
        phase: 'call',
        toolCallID: 'call_1',
        status: 'running',
        input: { command: 'ls /tmp' },
      },
      state: { status: 'running' },
    },
    {
      id: 'tool_result_1',
      type: 'ShellToolFrame',
      parentID: 'tool_call_1',
      createdAt: 300,
      updatedAt: 300,
      authorType: 'tool',
      authorID: 'exec',
      authorDisplayName: 'exec',
      content: {
        toolName: 'exec',
        phase: 'result',
        toolCallID: 'call_1',
        toolCallFrameID: 'tool_call_1',
        status: 'success',
        toolOutputID: 'OUT1',
      },
      state: { status: 'success' },
    },
  ]);

  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'user_1', 'tool_call_1' ]);
  assert.equal(next.framesBySessionID.ses_1[1].type, 'ShellToolFrame');
  assert.equal(next.framesBySessionID.ses_1[1].authorDisplayName, 'Test Agent');
  assert.equal(next.framesBySessionID.ses_1[1].createdAt, 200);
  assert.equal(next.framesBySessionID.ses_1[1].updatedAt, 300);
  assert.equal(next.framesBySessionID.ses_1[1].content.phase, 'result');
  assert.equal(next.framesBySessionID.ses_1[1].content.status, 'success');
  assert.equal(next.framesBySessionID.ses_1[1].content.toolOutputID, 'OUT1');
  assert.equal(next.framesBySessionID.ses_1[1].content.toolResultFrameID, 'tool_result_1');
  assert.equal(next.framesBySessionID.ses_1[1].state.status, 'success');
});

test('upsertFrameState updates a running tool frame when its result arrives', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Tools', messageCount: 0 },
    },
    framesBySessionID: {},
  };

  let running = upsertFrameState(state, 'ses_1', {
    id: 'search_call_1',
    type: 'WebSearchToolFrame',
    createdAt: 100,
    updatedAt: 100,
    content: {
      toolName: 'web-search',
      phase: 'call',
      toolCallID: 'search_tool_call_1',
      status: 'running',
      input: { query: 'kikx' },
    },
  });
  let finalized = upsertFrameState(running, 'ses_1', {
    id: 'search_result_1',
    type: 'WebSearchToolFrame',
    parentID: 'search_call_1',
    createdAt: 200,
    updatedAt: 200,
    content: {
      toolName: 'web-search',
      phase: 'result',
      toolCallID: 'search_tool_call_1',
      toolCallFrameID: 'search_call_1',
      status: 'success',
      preview: 'search result preview',
    },
  });

  assert.deepEqual(running.framesBySessionID.ses_1.map((frame) => frame.id), [ 'search_call_1' ]);
  assert.equal(running.framesBySessionID.ses_1[0].content.phase, 'call');
  assert.deepEqual(finalized.framesBySessionID.ses_1.map((frame) => frame.id), [ 'search_call_1' ]);
  assert.equal(finalized.framesBySessionID.ses_1[0].content.phase, 'result');
  assert.equal(finalized.framesBySessionID.ses_1[0].content.preview, 'search result preview');
  assert.equal(finalized.framesBySessionID.ses_1[0].content.toolResultFrameID, 'search_result_1');
});

test('upsertFrameState sorts finalized agent responses by visible completion order', () => {
  let state = setSessionFramesState(createSessionStateSnapshot(), 'ses_1', [
    {
      id: 'agent_1',
      type: 'AgentMessage',
      order: 1,
      commitOrder: 1,
      createdClock: '0000000001000000-000000-runner',
      updatedClock: '0000000001000000-000000-runner',
      hidden: true,
    },
    {
      id: 'user_1',
      type: 'UserMessage',
      order: 2,
      commitOrder: 2,
      createdClock: '0000000001001000-000000-runner',
      updatedClock: '0000000001001000-000000-runner',
      hidden: false,
    },
  ]);

  let next = upsertFrameState(state, 'ses_1', {
    id: 'agent_1',
    type: 'AgentMessage',
    order: 1,
    commitOrder: 3,
    createdClock: '0000000001000000-000000-runner',
    updatedClock: '0000000001002000-000000-runner',
    hidden: false,
    content: { text: 'final' },
  });

  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'user_1', 'agent_1' ]);
});

test('setSessionFramesState places a completed tool-using agent summary after its tool frames', () => {
  let state = setSessionFramesState(createSessionStateSnapshot(), 'ses_1', [
    {
      id: 'user_1',
      type: 'UserMessage',
      order: 10,
      commitOrder: 10,
      createdClock: '0000000001000000-000000-runner',
      updatedClock: '0000000001000000-000000-runner',
      createdAt: 1000,
      updatedAt: 1000,
      hidden: false,
      content: { text: 'Run a shell command and summarize it.' },
    },
    {
      id: 'agent_1',
      type: 'AgentMessage',
      order: 11,
      commitOrder: 16,
      createdClock: '0000000001000001-000000-runner',
      updatedClock: '0000000001000500-000000-runner',
      createdAt: 1500,
      updatedAt: 1500,
      hidden: false,
      content: { text: 'Summary after the tool result.', status: 'complete' },
    },
    {
      id: 'progress_1',
      type: 'AgentProgress',
      order: 12,
      commitOrder: 12,
      createdClock: '0000000001000100-000000-runner',
      updatedClock: '0000000001000100-000000-runner',
      createdAt: 1100,
      updatedAt: 1100,
      hidden: false,
      content: { text: 'I will run the command now.' },
    },
    {
      id: 'tool_call_1',
      type: 'ShellToolFrame',
      order: 13,
      commitOrder: 13,
      createdClock: '0000000001000200-000000-runner',
      updatedClock: '0000000001000200-000000-runner',
      createdAt: 1200,
      updatedAt: 1200,
      hidden: false,
      parentID: 'agent_1',
      content: {
        toolName: 'exec',
        phase: 'call',
        status: 'running',
        input: { command: 'ls /tmp' },
      },
    },
    {
      id: 'tool_result_1',
      type: 'ShellToolFrame',
      order: 14,
      commitOrder: 14,
      createdClock: '0000000001000300-000000-runner',
      updatedClock: '0000000001000300-000000-runner',
      createdAt: 1300,
      updatedAt: 1300,
      hidden: false,
      parentID: 'tool_call_1',
      content: {
        toolName: 'exec',
        phase: 'result',
        status: 'success',
        preview: 'tool result',
      },
    },
  ]);

  assert.deepEqual(state.framesBySessionID.ses_1.map((frame) => frame.id), [
    'user_1',
    'progress_1',
    'tool_call_1',
    'agent_1',
  ]);
});

test('upsertFrameState falls back to original frame order when clocks are missing', () => {
  let state = setSessionFramesState(createSessionStateSnapshot(), 'ses_1', [
    { id: 'agent_1', type: 'AgentMessage', order: 1, commitOrder: 1, hidden: true },
    { id: 'user_1', type: 'UserMessage', order: 2, commitOrder: 2, hidden: false },
  ]);

  let next = upsertFrameState(state, 'ses_1', {
    id: 'agent_1',
    type: 'AgentMessage',
    order: 1,
    commitOrder: 3,
    hidden: false,
    content: { text: 'final' },
  });

  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'agent_1', 'user_1' ]);
});

test('upsertFrameState ignores malformed frames and missing session ids', () => {
  let state = {
    sessionIDs: [],
    sessionDetailsByID: {},
    framesBySessionID: {},
  };

  assert.deepEqual(upsertFrameState(state, '', { id: 'frame_1' }), state);
  assert.deepEqual(upsertFrameState(state, 'ses_1', { type: 'MissingID' }), state);
});

test('countMessageFrames counts visible thread frames and ignores hidden or deleted frames', () => {
  assert.equal(countMessageFrames(null), 0);
  assert.equal(countMessageFrames([
    { id: 'sys_1', type: 'SystemNotice' },
    { id: 'msg_1', type: 'UserMessage' },
    { id: 'agent_1', type: 'AgentMessage', hidden: false },
    { id: 'progress_1', type: 'AgentProgress', hidden: false },
    null,
    { id: 'tool_1', type: 'ToolCall' },
    { id: 'hidden_1', type: 'AgentMessage', hidden: true },
    { id: 'deleted_1', type: 'AgentMessage', deleted: true },
    { id: 'phantom_1', type: 'AgentThinking', phantom: true },
  ]), 5);
});
