'use strict';

// The render path, end to end, with no browser.
//
// A component spec that only exercises `kikx-coordination-frame` proves the card
// draws. It does not prove the card is ever reached. This spec walks the actual
// production path for one invite wake and fails at whichever hop drops it:
//
//   server window   frameMatchesWindowFilters (src/shared/frame-window-filters.mjs:498)
//   server preview  isPreviewVisibleFrame    (src/core/aeordb/frame-store-normalizers.mjs:159)
//   client thread   threadRenderFrames       (src/client/state/thinking-state.mjs)
//   render dispatch frameContentDescriptor   (src/client/components/kikx-frame-item.mjs)
//
// It also pins the negative: an ordinary hidden frame must still be dropped by
// every one of those hops, so the widening cannot silently become "render
// everything hidden".

import assert from 'node:assert/strict';
import test from 'node:test';

import { frameMatchesWindowFilters } from '../../src/shared/frame-window-filters.mjs';
import { isPreviewVisibleFrame } from '../../src/core/aeordb/frame-store-normalizers.mjs';
import { threadRenderFrames } from '../../src/client/state/thinking-state.mjs';
import { isCoordinationWakeFrame } from '../../src/shared/coordination-visibility.mjs';

const DEFAULT_FILTERS = {
  user: true,
  agent: true,
  question: true,
  session: true,
  tools: true,
  commands: true,
  compaction: true,
  deleted: false,
};

function inviteWake() {
  return {
    id: 'wake-1',
    type: 'UserMessage',
    authorType: 'system',
    authorID: 'internal:session-invite',
    targetAgentID: 'agent-worker',
    hidden: true,
    deleted: false,
    content: {
      text: 'You have been invited to "Bot message visibility" by Zav. Kikx-Node-Eng, review the session context now.',
      agentName: 'Kikx-Node-Eng',
      invite: true,
    },
  };
}

function bookkeepingWake() {
  // Real shape of another hidden internal frame: targeted, but not an
  // instruction to a bot.
  return {
    id: 'recovery-1',
    type: 'UserMessage',
    authorType: 'system',
    authorID: 'internal:runtime-recovery',
    targetAgentID: 'agent-worker',
    hidden: true,
    deleted: false,
    content: { text: 'Resume the interrupted turn.' },
  };
}

test('the server window admits the invite wake', () => {
  assert.equal(frameMatchesWindowFilters(inviteWake(), DEFAULT_FILTERS), true);
});

test('the server preview head admits the invite wake', () => {
  assert.equal(isPreviewVisibleFrame(inviteWake()), true);
});

test('the client thread keeps the invite wake', () => {
  let frames = threadRenderFrames([ inviteWake() ]);
  assert.deepEqual(frames.map((frame) => frame.id), [ 'wake-1' ]);
});

test('every hop still drops a hidden frame that is not a wake', () => {
  let frame = bookkeepingWake();

  assert.equal(isCoordinationWakeFrame(frame), false);
  assert.equal(frameMatchesWindowFilters(frame, DEFAULT_FILTERS), false);
  assert.equal(isPreviewVisibleFrame(frame), false);
  assert.deepEqual(threadRenderFrames([ frame ]), []);
});

test('an invite wake the user filters away stays away', () => {
  // Filing it under User must not make it immune to the popup: unchecking User
  // is a real instruction to hide it.
  let filters = { ...DEFAULT_FILTERS, user: false };
  assert.equal(frameMatchesWindowFilters(inviteWake(), filters), false);
});

test('a visible UserMessage is not reclassified as coordination', () => {
  // The card must not hijack owner chat that happens to be typed at a bot.
  let frame = {
    id: 'user-1',
    type: 'UserMessage',
    authorType: 'user',
    authorID: 'user-1',
    hidden: false,
    content: { text: 'hello' },
  };
  assert.equal(isCoordinationWakeFrame(frame), false);
  assert.equal(frameMatchesWindowFilters(frame, DEFAULT_FILTERS), true);
});
