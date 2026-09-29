'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PREVIEW_COUNT,
  cardViewModel,
  chunkSessionIDs,
  clampPreviewCount,
  isVisibleFrame,
  miniPreviewFrames,
  previewsBySessionID,
  sessionCardLabel,
  sessionCardMeta,
} from '../../src/client/components/chat-view-model.mjs';

test('isVisibleFrame rejects hidden, deleted, phantom, and MessageDone frames', () => {
  assert.equal(isVisibleFrame({ id: 'a', type: 'UserMessage' }), true);
  assert.equal(isVisibleFrame({ id: 'a', type: 'UserMessage', hidden: true }), false);
  assert.equal(isVisibleFrame({ id: 'a', type: 'UserMessage', deleted: true }), false);
  assert.equal(isVisibleFrame({ id: 'a', type: 'AgentMessageDelta', phantom: true }), false);
  assert.equal(isVisibleFrame({ id: 'a', type: 'MessageDone' }), false);
  assert.equal(isVisibleFrame({ type: 'UserMessage' }), false);
  assert.equal(isVisibleFrame(null), false);
});

test('miniPreviewFrames keeps the newest visible frames within the limit', () => {
  let frames = [];
  for (let index = 1; index <= 10; index++)
    frames.push({ id: `f${index}`, type: 'UserMessage' });
  frames.push({ id: 'hidden', type: 'AgentMessage', hidden: true });

  let preview = miniPreviewFrames(frames, 3);
  assert.deepEqual(preview.map((frame) => frame.id), [ 'f8', 'f9', 'f10' ]);
});

test('miniPreviewFrames tolerates junk input', () => {
  assert.deepEqual(miniPreviewFrames(null), []);
  assert.deepEqual(miniPreviewFrames([ null, undefined, {} ]), []);
});

test('clampPreviewCount defaults and bounds', () => {
  assert.equal(clampPreviewCount(undefined), 5);
  assert.equal(clampPreviewCount(0), 5);
  assert.equal(clampPreviewCount(-3), 5);
  assert.equal(clampPreviewCount('abc'), 5);
  assert.equal(clampPreviewCount(7), 7);
  assert.equal(clampPreviewCount(999), MAX_PREVIEW_COUNT);
});

test('chunkSessionIDs dedupes, trims, drops blanks, and chunks', () => {
  assert.deepEqual(chunkSessionIDs([ 'a', 'b' ], 100), [ [ 'a', 'b' ] ]);
  assert.deepEqual(chunkSessionIDs([ 'a', ' a ', '', null, 'b', 'a' ], 100), [ [ 'a', 'b' ] ]);

  let many = [];
  for (let index = 0; index < 5; index++)
    many.push(`s${index}`);
  assert.deepEqual(chunkSessionIDs(many, 2), [ [ 's0', 's1' ], [ 's2', 's3' ], [ 's4' ] ]);
  assert.deepEqual(chunkSessionIDs(null), []);
});

test('previewsBySessionID maps by session id', () => {
  let map = previewsBySessionID([
    { sessionID: 'a', heads: [] },
    { sessionID: 'b', heads: [] },
    { heads: [] },
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.has('a'), true);
  assert.equal(map.has('b'), true);
});

test('cardViewModel prefers the client session and falls back to the preview session', () => {
  assert.deepEqual(cardViewModel({
    session: { id: 'a', title: 'List' },
    preview: { session: { id: 'a', title: 'Preview' }, heads: [ { id: 'x' } ], truncated: true },
    selected: true,
  }), {
    session: { id: 'a', title: 'List' },
    heads: [ { id: 'x' } ],
    truncated: true,
    error: null,
    selected: true,
  });

  assert.deepEqual(cardViewModel({
    preview: { session: { id: 'a', title: 'Preview' }, heads: [] },
  }), {
    session: { id: 'a', title: 'Preview' },
    heads: [],
    truncated: false,
    error: null,
    selected: false,
  });

  assert.deepEqual(cardViewModel({ session: { id: 'a', title: 'List' } }), {
    session: { id: 'a', title: 'List' },
    heads: [],
    truncated: false,
    error: null,
    selected: false,
  });
});

test('sessionCardLabel and meta describe the card chrome', () => {
  assert.equal(sessionCardLabel({ id: 'a', title: 'Work' }), 'Work');
  assert.equal(sessionCardLabel({ id: 'a' }), 'a');
  assert.equal(sessionCardLabel(null), 'Session');

  assert.equal(sessionCardMeta({ messageCount: 1 }, [], false), '1 message');
  assert.equal(sessionCardMeta({ messageCount: 34 }, [], true), '34 messages · preview');
  assert.equal(sessionCardMeta({}, [ { id: 'x' }, { id: 'y' } ], false), '2 messages');
});
