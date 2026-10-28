'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COORDINATION_FILTER_CATEGORY,
  describeCoordinationWake,
  isCoordinationWakeFrame,
  isThreadVisibleFrame,
} from '../../src/shared/coordination-visibility.mjs';

// The exact shape `wakeAgentInSession` persists
// (src/core/runtime/frame-runtime-sessions.mjs:667-720), with the text the
// generator produces (src/core/tools/session-invite-wake.mjs:12-16).
function inviteWake(overrides = {}) {
  return {
    id: 'wake-1',
    type: 'UserMessage',
    sessionID: 'session-1',
    authorType: 'system',
    authorID: 'internal:session-invite',
    authorDisplayName: 'Kikx session invite',
    targetAgentID: 'agent-worker',
    hidden: true,
    deleted: false,
    content: {
      text: 'You have been invited to "Bot message visibility" by Zav. Kikx-Node-Eng, review the session context now and wait for the coordinator\'s assignment before changing files.',
      status: 'scheduled',
      agentID: 'agent-worker',
      agentName: 'Kikx-Node-Eng',
      invite: true,
    },
    ...overrides,
  };
}

test('an invite wake is recognised as coordination', () => {
  assert.equal(isCoordinationWakeFrame(inviteWake()), true);
});

test('a hidden frame is still hidden unless it is a targeted internal wake', () => {
  // Ordinary hidden bookkeeping must not leak: no targetAgentID.
  assert.equal(isCoordinationWakeFrame(inviteWake({ targetAgentID: null })), false);
  assert.equal(isCoordinationWakeFrame(inviteWake({ targetAgentID: '  ' })), false);

  // A targeted frame from a non-internal author is an owner/agent message, and
  // its `hidden` flag means what it always meant.
  assert.equal(isCoordinationWakeFrame(inviteWake({ authorID: 'user-1' })), false);
  assert.equal(isCoordinationWakeFrame(inviteWake({ authorID: 'agent-1' })), false);

  // Only a hidden frame is a candidate; a visible one needs no special case.
  assert.equal(isCoordinationWakeFrame(inviteWake({ hidden: false })), false);

  // Only UserMessage carries the instruction as prose.
  assert.equal(isCoordinationWakeFrame(inviteWake({ type: 'AgentMessage' })), false);

  // Soft-deleted and phantom frames stay out.
  assert.equal(isCoordinationWakeFrame(inviteWake({ deleted: true })), false);
  assert.equal(isCoordinationWakeFrame(inviteWake({ phantom: true })), false);

  // No text, nothing to show.
  assert.equal(isCoordinationWakeFrame(inviteWake({ content: { invite: true } })), false);
});

test('bookkeeping authors stay invisible even if they grow a target', () => {
  for (let authorID of [
    'internal:compaction',
    'internal:runtime-recovery',
    'internal:process-manager',
    'internal:autonomous-chain',
    'internal:agent-continuation',
    'internal:session-merge',
    'internal:session-participant',
    'internal:slash-command-router',
    'internal:frame-store',
    'internal:scheduled-frame-cancel',
  ]) {
    assert.equal(
      isCoordinationWakeFrame(inviteWake({ authorID })),
      false,
      `${authorID} must not surface`,
    );
  }
});

test('isThreadVisibleFrame only ever widens visibility', () => {
  // Previously visible frames keep their answer.
  assert.equal(isThreadVisibleFrame({ id: 'a', hidden: false, type: 'AgentMessage' }), true);
  assert.equal(isThreadVisibleFrame({ id: 'b', type: 'AgentMessage' }), true);
  assert.equal(isThreadVisibleFrame({ id: 'c', hidden: true, type: 'UserMessage' }), false);

  // The one change: a targeted internal wake is now visible to a person.
  assert.equal(isThreadVisibleFrame(inviteWake()), true);

  // Junk is still not a frame.
  assert.equal(isThreadVisibleFrame(null), false);
  assert.equal(isThreadVisibleFrame(undefined), false);
});

test('hidden stays true on the frame after the visibility question is asked', () => {
  // The compaction gate reads this same field. Asking the display question must
  // not mutate it, or the model's context changes as a side effect.
  let frame = inviteWake();
  assert.equal(isThreadVisibleFrame(frame), true);
  assert.equal(frame.hidden, true);
});

test('a surfaced wake files under User so a narrowed popup still shows it', () => {
  assert.equal(COORDINATION_FILTER_CATEGORY, 'user');
});

test('the description names the invitee, the inviter and the instruction', () => {
  let described = describeCoordinationWake(inviteWake());

  assert.equal(described.invitee, 'Kikx-Node-Eng');
  assert.equal(described.inviter, 'Zav');
  assert.equal(described.sessionTitle, 'Bot message visibility');
  assert.match(described.instruction, /^Kikx-Node-Eng, review the session context now/);
  // The instruction is the generated sentence minus the greeting the header shows.
  assert.doesNotMatch(described.instruction, /You have been invited/);
  assert.match(described.text, /You have been invited/);
});

test('an unrecognised wake text keeps its full text and claims no inviter', () => {
  let frame = inviteWake({ content: { text: 'Context review turn.', agentName: 'Kikx-Node-Eng' } });
  let described = describeCoordinationWake(frame);

  assert.equal(described.inviter, '');
  assert.equal(described.sessionTitle, '');
  assert.equal(described.instruction, 'Context review turn.');
});

test('the invitee falls back to the target agent id', () => {
  let frame = inviteWake({ content: { text: 'Review the session context.' } });
  assert.equal(describeCoordinationWake(frame).invitee, 'agent-worker');
});

// Regression: the inviter is parsed from generated prose, and a naive "split on
// the first period" reads `Dr. Smith` as `Dr` and moves `Smith.` into the
// instruction. Both halves of the card were wrong. A quoted title broke it a
// second way, because a greedy title matched past its own closing quote.
test('an inviter whose name contains a period is read whole', () => {
  let frame = inviteWake({
    content: {
      text: 'You have been invited to "Refactor" by Dr. Smith. Kikx-Node-Eng, review the session context now and wait.',
      agentName: 'Kikx-Node-Eng',
    },
  });
  let described = describeCoordinationWake(frame);

  assert.equal(described.inviter, 'Dr. Smith');
  assert.equal(described.sessionTitle, 'Refactor');
  // The instruction starts at the invitee, not mid-name.
  assert.match(described.instruction, /^Kikx-Node-Eng, review the session context now/);
});

test('a session title containing its own quotes is read whole', () => {
  let frame = inviteWake({
    content: {
      text: 'You have been invited to "the "big" refactor" by Zav. Kikx-Node-Eng, review the session context now and wait.',
      agentName: 'Kikx-Node-Eng',
    },
  });
  let described = describeCoordinationWake(frame);

  assert.equal(described.inviter, 'Zav');
  assert.equal(described.sessionTitle, 'the "big" refactor');
});

test('a dotted inviter and a dotted name together still split at the invitee', () => {
  let frame = inviteWake({
    content: {
      text: 'You have been invited to "T" by Dr. A. B. Smith. Weird Name, review the session context now and wait.',
      agentName: 'Weird Name',
    },
  });
  assert.equal(describeCoordinationWake(frame).inviter, 'Dr. A. B. Smith');
});

// Regression: the author rule was a DENYLIST of 11 names out of 36 `internal:`
// authorIDs in `src/`, so the other 25 failed OPEN. Two of them were live in
// `kikx-dev2` and admitted 24 real frames before this was fixed. Reproduced here
// with the exact persisted shapes, not a hand-written lookalike.
test('runtime bookkeeping authors that carry a target and text stay hidden', () => {
  // Exactly what `pending-tool-recovery.mjs:206-211,213-221` persists.
  let recovered = inviteWake({
    authorID: 'internal:pending-tool-recovery',
    content: {
      text: [
        'Kikx resumed pending tool call(s) after a restart.',
        '- exec: success — {"type":"ToolOutput","toolName":"exec","toolOutputID":"…"}',
        'Continue the task from the current state. Do not repeat calls that already completed.',
      ].join('\n'),
      status: 'scheduled',
      agentID: 'agent-worker',
    },
  });
  // `question-deadline-schedule.mjs:42` author, text per the persisted frame.
  let deadline = inviteWake({
    authorID: 'internal:question-deadline',
    content: {
      text: 'Question b8d949ce-1286-4586-a8fb-4c416eb4eb7a reaches its default-answer deadline.',
      status: 'scheduled',
      agentID: 'agent-worker',
    },
  });

  // These pass every OTHER gate the predicate used to check — hidden, directed,
  // prose, UserMessage — so only the author rule can refuse them.
  for (let frame of [ recovered, deadline ]) {
    assert.equal(frame.hidden, true);
    assert.equal(frame.type, 'UserMessage');
    assert.ok(frame.targetAgentID);
    assert.ok(frame.content.text.trim() !== '');
  }

  assert.equal(isCoordinationWakeFrame(recovered), false);
  assert.equal(isCoordinationWakeFrame(deadline), false);

  // And the real consequence: they must not become visible in the thread.
  assert.equal(isThreadVisibleFrame(recovered), false);
  assert.equal(isThreadVisibleFrame(deadline), false);
});

// The direction of the test matters as much as the outcome. An allowlist means a
// NEW internal author is refused by default; a denylist meant it leaked by
// default. This pinning test fails the moment somebody "fixes" the leak by
// re-adding a denylist, because a novel author would then be admitted.
test('an unknown internal author is refused, not admitted', () => {
  let frame = inviteWake({ authorID: 'internal:a-bot-someone-adds-next-week' });

  assert.equal(isCoordinationWakeFrame(frame), false);
  assert.equal(isThreadVisibleFrame(frame), false);

  // The two authors that DO surface are exactly the invite handoff, so this
  // cannot pass by refusing everything: the positive control is in the first
  // test of this file (`an invite wake is recognised as coordination`).
  assert.equal(isCoordinationWakeFrame(inviteWake()), true);
});
