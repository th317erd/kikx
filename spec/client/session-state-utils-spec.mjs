'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countMessageFrames,
  mergeSessions,
  setSessionFramesState,
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

test('countMessageFrames treats non-message frames and invalid input as zero', () => {
  assert.equal(countMessageFrames(null), 0);
  assert.equal(countMessageFrames([
    { id: 'sys_1', type: 'SystemNotice' },
    { id: 'msg_1', type: 'UserMessage' },
    null,
    { id: 'tool_1', type: 'ToolCall' },
  ]), 1);
});
