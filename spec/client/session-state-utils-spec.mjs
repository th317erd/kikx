'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countMessageFrames,
  mergeSessions,
  setSessionFramesState,
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
    { id: 'msg_2', type: 'UserMessage' },
  ]);

  assert.equal(next.sessionDetailsByID.ses_1.messageCount, 2);
  assert.equal(next.sessionDetailsByID.ses_2.messageCount, 11);
  assert.deepEqual(next.framesBySessionID.ses_1.map((frame) => frame.id), [ 'frm_1', 'msg_1', 'msg_2' ]);
  assert.notEqual(next.framesBySessionID, previous.framesBySessionID);
  assert.notEqual(next.sessionDetailsByID, previous.sessionDetailsByID);
});

test('setSessionFramesState does not replace an authoritative manifest count with loaded frames', () => {
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
        { id: 'msg_1', type: 'UserMessage', content: { text: 'hello' } },
      ],
    },
  };

  let typing = upsertFrameState(state, 'ses_1', {
    id: 'typing_1',
    type: 'BeginTyping',
    phantom: true,
    authorID: 'agent_1',
    content: { agentName: 'Codex' },
  });
  let thinking = upsertFrameState(typing, 'ses_1', {
    id: 'agent_msg_1:thinking',
    type: 'AgentThinking',
    phantom: true,
    parentID: 'msg_1',
    authorID: 'agent_1',
    content: { text: 'thinking' },
  });
  let delta = upsertFrameState(thinking, 'ses_1', {
    id: 'agent_msg_1',
    type: 'AgentMessageDelta',
    phantom: true,
    parentID: 'msg_1',
    authorID: 'agent_1',
    content: { text: 'partial' },
  });
  let endTyping = upsertFrameState(delta, 'ses_1', {
    id: 'typing_2',
    type: 'EndTyping',
    phantom: true,
    authorID: 'agent_1',
  });
  let final = upsertFrameState(endTyping, 'ses_1', {
    id: 'agent_msg_1',
    type: 'AgentMessage',
    parentID: 'msg_1',
    authorID: 'agent_1',
    content: { text: 'final' },
  });

  assert.deepEqual(thinking.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'typing:agent_1', 'agent_msg_1:thinking' ]);
  assert.equal(thinking.framesBySessionID.ses_1[1].type, 'BeginTyping');
  assert.equal(thinking.framesBySessionID.ses_1[2].hidden, false);
  assert.deepEqual(delta.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'typing:agent_1', 'agent_msg_1:thinking', 'agent_msg_1' ]);
  assert.equal(delta.framesBySessionID.ses_1[3].hidden, false);
  assert.deepEqual(endTyping.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'agent_msg_1:thinking', 'agent_msg_1' ]);
  assert.deepEqual(final.framesBySessionID.ses_1.map((frame) => frame.id), [ 'msg_1', 'agent_msg_1' ]);
  assert.equal(final.framesBySessionID.ses_1[1].type, 'AgentMessage');
  assert.equal(final.framesBySessionID.ses_1[1].content.text, 'final');
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

test('countMessageFrames treats non-message frames and invalid input as zero', () => {
  assert.equal(countMessageFrames(null), 0);
  assert.equal(countMessageFrames([
    { id: 'sys_1', type: 'SystemNotice' },
    { id: 'msg_1', type: 'UserMessage' },
    null,
    { id: 'tool_1', type: 'ToolCall' },
  ]), 1);
});
