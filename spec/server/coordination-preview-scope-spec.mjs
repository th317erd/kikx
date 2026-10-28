'use strict';

// Scope boundary for the coordination-wake widening, asserted rather than assumed.
//
// `isPreviewVisibleFrame` is shared by two callers in frame-store-preview.mjs:
//
//   :205  listFrameWindow      the thread window the browser renders
//   :337  loadSessionPreviewHeads  the sidebar/session-card preview line
//
// Widening the predicate to admit a coordination wake widens BOTH callers,
// because a call site cannot keep the old behavior of a callee it did not edit.
// The handoff claimed the sidebar "stays quiet" on the strength of not editing
// :337. That reasoning does not hold, and this spec records what actually
// happens so the next person does not have to rediscover it.
//
// Measured behavior (this is the truth, not an aspiration):
//   - the wake DOES reach the preview heads, and therefore sessionCardMeta's
//     visible-count arithmetic (`truncated ? manifestCount : max(manifest, heads.length)`),
//     and therefore the session card's frame view.
//   - a hidden bookkeeping frame still does NOT reach them.
//
// So the widening is "the wake is visible in the session card too", which is
// arguably correct for an owner who wants to see handoffs, but it is a change
// nobody decided on deliberately. It is pinned here, with the reasoning, rather
// than left as an unexamined consequence.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isPreviewVisibleFrame } from '../../src/core/aeordb/frame-store-normalizers.mjs';
import { sessionCardMeta } from '../../src/client/components/chat-view-model.mjs';

const INVITE_TEXT = 'You have been invited to "Bot message visibility" by Zav. '
  + 'Kikx-Node-Eng, review the session context now.';

function inviteWake(overrides = {}) {
  return {
    id: 'wake_invite',
    type: 'UserMessage',
    sessionID: 'session_1',
    interactionID: 'int_wake',
    order: 2,
    authorType: 'system',
    authorID: 'internal:session-invite',
    authorDisplayName: 'Kikx session invite',
    targetAgentID: 'agent_worker',
    hidden: true,
    deleted: false,
    scheduledStatus: 'fired',
    content: {
      text: INVITE_TEXT,
      agentID: 'agent_worker',
      agentName: 'Kikx-Node-Eng',
      invite: true,
    },
    ...overrides,
  };
}

function ownerMessage() {
  return {
    id: 'msg_owner',
    type: 'UserMessage',
    sessionID: 'session_1',
    interactionID: 'int_owner',
    order: 1,
    authorType: 'user',
    authorID: 'user_owner',
    hidden: false,
    deleted: false,
    content: { text: 'Where did this bot come from?' },
  };
}

test('the preview call site inherits the widening: the wake passes isPreviewVisibleFrame', () => {
  // The point of the test: `:337` was NOT edited, yet it now admits the wake.
  assert.equal(isPreviewVisibleFrame(inviteWake()), true);
  assert.equal(isPreviewVisibleFrame(ownerMessage()), true);
});

test('hidden bookkeeping still fails the preview predicate', () => {
  let recovery = inviteWake({
    id: 'wake_recovery',
    authorID: 'internal:runtime-recovery',
    content: { text: 'Resume the interrupted turn.' },
  });
  assert.equal(isPreviewVisibleFrame(recovery), false);

  // And a hidden frame with no target is still excluded.
  let untargeted = inviteWake({ id: 'wake_untargeted', targetAgentID: undefined });
  assert.equal(isPreviewVisibleFrame(untargeted), false);

  // A plain hidden system row with no internal: author is untouched.
  let plainHidden = ownerMessage();
  plainHidden.hidden = true;
  assert.equal(isPreviewVisibleFrame(plainHidden), false);
});

test('the wake therefore changes the session-card visible count', () => {
  // This is the downstream consequence, spelled out. `truncated: false` means
  // "we fetched every frame, so heads is authoritative."
  let withoutWake = sessionCardMeta({ messageCount: 1 }, [ ownerMessage() ], false);
  let withWake = sessionCardMeta({ messageCount: 2 }, [ ownerMessage(), inviteWake() ], false);

  assert.equal(withoutWake, '1 message');
  assert.equal(withWake, '2 messages');
});
