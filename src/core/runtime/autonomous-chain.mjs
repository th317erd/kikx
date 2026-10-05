'use strict';

// Fail-safe for autonomous turn chains.
//
// A "chain" is a run of self-triggered turns: async exec-completion wakes and
// `continue-turn` (respond-and-continue) continuations, each of which may
// schedule the next without any new user input. Legitimate long work can span
// many such turns, so the primary loop defense is the prompt guard (the
// `end-turn` / `continue-turn` queue rule). This constant is only a high,
// non-punitive backstop: when a chain exceeds it, further autonomous scheduling
// is paused and one visible notice is posted. Nothing is killed; stored output
// is intact; any user message resets the chain.
export const MAX_AUTONOMOUS_CHAIN_STEPS = 64;
export const AUTONOMOUS_CONTINUATION_KINDS = [
  'exec-wake-on-completion',
  'send',
  // Legacy: pre-rename continuations persisted this kind. Tolerate it on read so
  // cancel paths recognise and retire old frames correctly.
  'agent-respond-and-continue',
];
export const AUTONOMOUS_PAUSE_NOTICE_TEXT = 'Autonomous run paused — reply to continue.';

export function isAutonomousContinuation(continuation) {
  return Boolean(continuation) && AUTONOMOUS_CONTINUATION_KINDS.includes(continuation.kind);
}

// Update payload that marks a pending autonomous scheduled frame cancelled. The
// scheduled-frame queue treats any non-pending status as terminal and drops the
// entry on the next commit, so this is the missing `scheduledStatus:'cancelled'`
// writer.
export function buildAutonomousCancellation(frame, updatedAt) {
  return {
    ...frame,
    scheduledStatus: 'cancelled',
    updatedAt,
  };
}

// One visible, non-routing notice posted when a chain trips the fail-safe. It is
// authored by a non-agent system actor and is committed `silent:true`, so the
// frame router never sees it; it reaches clients through frame runtime events.
export function createAutonomousPauseFrame({ id, sessionID, interactionID = null, parentID = null, now }) {
  return {
    id,
    type: 'SystemNotice',
    sessionID,
    interactionID,
    parentID,
    authorType: 'system',
    authorID: 'internal:autonomous-chain',
    authorDisplayName: 'Kikx',
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    hidden: false,
    deleted: false,
    content: {
      text: AUTONOMOUS_PAUSE_NOTICE_TEXT,
      status: 'paused',
    },
  };
}

export function normalizeChainDepth(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return 0;

  return Math.trunc(number);
}

// Depth of a newly scheduled autonomous frame: one more than the frame that
// triggered the current turn. A user-triggered turn has no depth, so its first
// scheduled child is depth 1.
export function nextChainDepth(triggerFrame) {
  return normalizeChainDepth(triggerFrame?.continuationDepth) + 1;
}

export function exceedsChainLimit(depth) {
  return normalizeChainDepth(depth) > MAX_AUTONOMOUS_CHAIN_STEPS;
}
