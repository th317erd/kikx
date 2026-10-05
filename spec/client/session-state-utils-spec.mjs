'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SESSION_MESSAGES,
  countMessageFrames,
  createSessionStateSnapshot,
  mergeSessionFrameWindowState,
  mergeSessions,
  prependSessionFramesState,
  resetSessionPagingState,
  setSessionFramesState,
  setSessionPagingState,
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
  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'frm_1', 'msg_1', 'agent_1', 'tool_1', 'hidden_1', 'deleted_1' ]);
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

test('upsertFrameState ignores late phantoms for completed agent responses', () => {
  let state = setSessionFramesState(createSessionStateSnapshot(), 'ses_1', [
    {
      id: 'user_1',
      type: 'UserMessage',
      order: 1,
      createdClock: '0000000001000000-000000-runner',
      updatedClock: '0000000001000000-000000-runner',
      hidden: false,
      content: { text: 'hello' },
    },
    {
      id: 'agent_1',
      type: 'AgentMessage',
      order: 2,
      createdClock: '0000000001001000-000000-runner',
      updatedClock: '0000000001004000-000000-runner',
      hidden: false,
      responseFrameID: 'agent_1',
      content: {
        text: 'final answer',
        thinking: {
          text: 'finished thinking',
          status: 'complete',
        },
        status: 'complete',
      },
    },
  ]);

  let next = upsertFrameState(state, 'ses_1', {
    id: 'agent_1:late-thinking',
    type: 'AgentThinking',
    phantom: true,
    responseFrameID: 'agent_1',
    parentID: 'user_1',
    updatedClock: '0000000001005000-000000-runner',
    content: {
      text: 'late internal review thought',
      thinking: {
        text: 'late internal review thought',
        status: 'streaming',
      },
    },
  });

  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'user_1', 'agent_1' ]);
  assert.equal(next.framesBySessionID.ses_1[1].content.text, 'final answer');
  assert.deepEqual(next.framesBySessionID.ses_1[1].content.thinking, {
    text: 'finished thinking',
    status: 'complete',
  });
  assert.equal(next.framesBySessionID.ses_1[1].content.status, 'complete');
});

test('setSessionFramesState keeps closed responses ordered by closed clock after metadata updates', () => {
  let state = setSessionFramesState(createSessionStateSnapshot(), 'ses_1', [
    {
      id: 'user_1',
      type: 'UserMessage',
      order: 1,
      createdClock: '0000000001000000-000000-runner',
      updatedClock: '0000000001000000-000000-runner',
      hidden: false,
      content: { text: 'hello' },
    },
    {
      id: 'agent_1',
      type: 'AgentMessage',
      order: 2,
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
      tokenUsage: {
        test: {
          updatedAt: 9000,
          tokensUsed: 10,
        },
      },
    },
    {
      id: 'user_2',
      type: 'UserMessage',
      order: 3,
      createdClock: '0000000001003000-000000-runner',
      updatedClock: '0000000001003000-000000-runner',
      hidden: false,
      content: { text: 'next' },
    },
  ]);

  assert.deepEqual(state.framesBySessionID.ses_1.map((frame) => frame.id), [ 'user_1', 'agent_1', 'user_2' ]);
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
    sessionPagingByID: {},
  };

  assert.deepEqual(upsertFrameState(state, '', { id: 'frame_1' }), state);
  assert.deepEqual(upsertFrameState(state, 'ses_1', { type: 'MissingID' }), state);
});

test('prependSessionFramesState inserts older heads before newer ones and keeps the newer heads intact', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Long', messageCount: 200 },
    },
    framesBySessionID: {
      ses_1: [
        { id: 'msg_101', type: 'UserMessage', order: 101, content: { text: 'newer A' } },
        { id: 'msg_102', type: 'UserMessage', order: 102, content: { text: 'newer B' } },
      ],
    },
  };

  let next = prependSessionFramesState(state, 'ses_1', [
    { id: 'msg_99', type: 'UserMessage', order: 99, content: { text: 'older A' } },
    { id: 'msg_100', type: 'UserMessage', order: 100, content: { text: 'older B' } },
  ]);

  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_99', 'msg_100', 'msg_101', 'msg_102' ]);
  assert.equal(next.framesBySessionID.ses_1[2].content.text, 'newer A');
  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 200);
  assert.notEqual(next.framesBySessionID, state.framesBySessionID);
  assert.deepEqual(state.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_101', 'msg_102' ]);
});

test('prependSessionFramesState never overwrites an already-present newer head with an older partial', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', messageCount: 3 },
    },
    framesBySessionID: {
      ses_1: [
        { id: 'msg_2', type: 'UserMessage', order: 2, content: { text: 'complete newer head' } },
      ],
    },
  };

  let next = prependSessionFramesState(state, 'ses_1', [
    { id: 'msg_1', type: 'UserMessage', order: 1, content: { text: 'older' } },
    { id: 'msg_2', type: 'UserMessage', order: 2, content: { text: 'stale partial' } },
  ]);

  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'msg_2' ]);
  assert.equal(next.framesBySessionID.ses_1[1].content.text, 'complete newer head');
});

test('setSessionFramesState with paging keeps raw total out of messageCount', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', title: 'Huge', messageCount: 0 },
    },
    framesBySessionID: {},
  };

  let next = setSessionFramesState(state, 'ses_1', [
    { id: 'msg_1', type: 'UserMessage' },
    { id: 'msg_2', type: 'UserMessage' },
  ], { total: 640, hasMoreOlder: true, oldestOrder: 1, newestOrder: 2 });

  // `total` is a raw frame-file count (paging metadata), not a visible message
  // count. messageCount is repaired upward only by the loaded visible heads.
  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 2);
  assert.deepEqual(next.sessionPagingByID.ses_1, {
    hasMoreOlder: true,
    oldestOrder: 1,
    newestOrder: 2,
    total: 640,
    hasMoreNewer: false,
  });
});

test('prependSessionFramesState does not lower the authoritative messageCount', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', messageCount: 500 },
    },
    framesBySessionID: {
      ses_1: [ { id: 'msg_10', type: 'UserMessage', order: 10 } ],
    },
  };

  let next = prependSessionFramesState(state, 'ses_1', [
    { id: 'msg_9', type: 'UserMessage', order: 9 },
  ]);

  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 500);
});

test('setSessionPagingState patches an entry and resetSessionPagingState clears it', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {},
    framesBySessionID: {},
  };

  let loaded = setSessionPagingState(state, 'ses_1', { hasMoreOlder: true, oldestOrder: 10, total: 300 });
  let loading = setSessionPagingState(loaded, 'ses_1', { loading: true });

  assert.deepEqual(loading.sessionPagingByID.ses_1, {
    hasMoreOlder: true,
    oldestOrder: 10,
    total: 300,
    loading: true,
  });

  let reset = resetSessionPagingState(loading, 'ses_1');
  assert.deepEqual(reset.sessionPagingByID, {});
  assert.deepEqual(loading.sessionPagingByID.ses_1, {
    hasMoreOlder: true,
    oldestOrder: 10,
    total: 300,
    loading: true,
  });
});

test('mergeSessionFrameWindowState updates newer heads, appends new ones, and keeps prepended older heads', () => {
  let state = {
    sessionIDs: [ 'ses_1' ],
    sessionDetailsByID: {
      ses_1: { id: 'ses_1', messageCount: 300 },
    },
    framesBySessionID: {
      ses_1: [
        { id: 'msg_1', type: 'UserMessage', order: 1, content: { text: 'older prepended' } },
        { id: 'msg_99', type: 'UserMessage', order: 99, content: { text: 'stale' } },
      ],
    },
  };

  let next = mergeSessionFrameWindowState(state, 'ses_1', [
    { id: 'msg_99', type: 'UserMessage', order: 99, content: { text: 'fresh' } },
    { id: 'msg_100', type: 'UserMessage', order: 100, content: { text: 'newest' } },
  ], { total: 300, hasMoreOlder: true, oldestOrder: 99, newestOrder: 100 });

  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'msg_99', 'msg_100' ]);
  assert.equal(next.framesBySessionID.ses_1.find((frame) => frame.id === 'msg_99').content.text, 'fresh');
  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 300);
  assert.equal(next.sessionPagingByID.ses_1.oldestOrder, 99);
  assert.equal(next.sessionPagingByID.ses_1.newestOrder, 100);
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

function messageSequence(count, startOrder = 1, type = 'UserMessage') {
  let messages = [];
  for (let index = 0; index < count; index++) {
    let order = startOrder + index;
    messages.push({ id: `msg_${order}`, type, order, createdAt: order, content: { text: `msg ${order}` } });
  }

  return messages;
}

test('setSessionFramesState caps a loaded window to the visual-message limit, keeping the newest', () => {
  let state = createSessionStateSnapshot();
  let next = setSessionFramesState(state, 'ses_1', messageSequence(MAX_SESSION_MESSAGES + 120));

  assert.equal(next.framesBySessionID.ses_1.length, MAX_SESSION_MESSAGES);
  assert.equal(next.framesBySessionID.ses_1[0].id, `msg_${121}`);
  assert.equal(next.framesBySessionID.ses_1.at(-1).id, `msg_${MAX_SESSION_MESSAGES + 120}`);
});

test('prependSessionFramesState trims the newest end when the window overflows', () => {
  let state = setSessionFramesState(createSessionStateSnapshot(), 'ses_1', messageSequence(MAX_SESSION_MESSAGES, 141));

  // Prepending a full page of older heads overflows the cap; the oldest are kept
  // (the region the user scrolled to) and the newest are trimmed.
  let next = prependSessionFramesState(state, 'ses_1', messageSequence(120, 21));

  assert.equal(next.framesBySessionID.ses_1.length, MAX_SESSION_MESSAGES);
  assert.equal(next.framesBySessionID.ses_1[0].id, 'msg_21');
  assert.equal(next.framesBySessionID.ses_1.at(-1).id, `msg_${MAX_SESSION_MESSAGES + 140 - 120}`);
});

test('prependSessionFramesState records that newer frames were trimmed so the client can refetch', () => {
  let state = {
    ...createSessionStateSnapshot(),
    sessionPagingByID: { ses_1: { newestOrder: MAX_SESSION_MESSAGES + 140, oldestOrder: 141, hasMoreOlder: true } },
  };
  state = setSessionFramesState(state, 'ses_1', messageSequence(MAX_SESSION_MESSAGES, 141));
  state = setSessionPagingState(state, 'ses_1', { newestOrder: MAX_SESSION_MESSAGES + 140, oldestOrder: 141, hasMoreOlder: true });

  let next = prependSessionFramesState(state, 'ses_1', messageSequence(120, 21));

  assert.equal(next.sessionPagingByID.ses_1.hasMoreNewer, true);
  assert.equal(next.sessionPagingByID.ses_1.newestOrder, MAX_SESSION_MESSAGES + 140);
});

test('mergeSessionFrameWindowState clears hasMoreNewer and keeps the newest when the tail is refetched', () => {
  let state = setSessionFramesState(createSessionStateSnapshot(), 'ses_1', messageSequence(MAX_SESSION_MESSAGES, 141));
  state = setSessionPagingState(state, 'ses_1', { hasMoreNewer: true, newestOrder: MAX_SESSION_MESSAGES + 140, oldestOrder: 141, hasMoreOlder: true });

  let next = mergeSessionFrameWindowState(state, 'ses_1', messageSequence(100, 260), {
    total: 400,
    hasMore: true,
    oldestOrder: 260,
    newestOrder: 359,
  });

  assert.equal(next.framesBySessionID.ses_1.length, MAX_SESSION_MESSAGES);
  assert.equal(next.framesBySessionID.ses_1.at(-1).id, 'msg_359');
  assert.equal(next.sessionPagingByID.ses_1.hasMoreNewer, false);
  assert.equal(next.sessionPagingByID.ses_1.newestOrder, 359);
});

test('a live append while scrolled up does not evict the region being read', () => {
  // Simulate the user having scrolled up until older pages filled the window and
  // trimmed the newest end (hasMoreNewer true).
  let state = setSessionFramesState(createSessionStateSnapshot(), 'ses_1', messageSequence(MAX_SESSION_MESSAGES, 1));
  state = setSessionPagingState(state, 'ses_1', { hasMoreNewer: true, oldestOrder: 1, newestOrder: MAX_SESSION_MESSAGES });

  // A live SSE frame appends at the tail and overflows the cap.
  let live = { id: 'live_1', type: 'UserMessage', order: MAX_SESSION_MESSAGES + 5, createdAt: MAX_SESSION_MESSAGES + 5, content: { text: 'live' } };
  let next = setSessionFramesState(state, 'ses_1', [ ...state.framesBySessionID.ses_1, live ]);

  // The oldest end (what the user is reading) is preserved; the newest is trimmed.
  assert.equal(next.framesBySessionID.ses_1.length, MAX_SESSION_MESSAGES);
  assert.equal(next.framesBySessionID.ses_1[0].id, 'msg_1');
  assert.equal(next.sessionPagingByID.ses_1.hasMoreNewer, true);
});

