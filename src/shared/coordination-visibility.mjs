'use strict';

// Display-only visibility for coordination wakes.
//
// THE PROBLEM
// A coordinator wakes a newly invited agent by writing a real `UserMessage`
// whose text is the instruction, then hiding it so it never reaches the thread
// (`wakeAgentInSession`, src/core/runtime/frame-runtime-sessions.mjs:667-720).
// The owner's report: "I have no idea how this bot just randomly showed up in
// the conversation" — the bot arrived with no visible handoff and no visible
// instruction. The text was always stored; it was never shown.
//
// WHY THIS IS A PREDICATE AND NOT `hidden: false`
// `hidden` is load-bearing well past display. Un-hiding the frame at the source
// would change what the MODEL sees, not just what the person sees:
//
//   src/core/compaction/frame-context-builder.mjs:185,192,247
//     drop `frame.hidden !== true` when assembling agent context.
//   src/core/runtime/frame-runtime-recovery.mjs:21,140
//     treats `hidden === true` as the durable-wake shape on recovery.
//   src/core/runtime/frame-runtime-prompts.mjs:28
//     refuses to attach a captured model prompt to a hidden frame.
//   src/core/aeordb/frame-store-serialization.mjs:8 and
//   src/core/aeordb/frame-store-indexes.mjs:52
//     persist and index `hiddenIndex`, so the flag is queryable state.
//
// So `hidden` stays exactly as written: `true`, indexed `"true"`, invisible to
// compaction, unchanged on recovery. This module answers a DIFFERENT question —
// "may a person see this in the thread?" — and every caller below asks only
// that question. Nothing here writes a frame.
//
// WHY THE ADMISSION HAS TO HAPPEN ON THE SERVER TOO
// The browser never receives these frames today, so a client-only rule would
// have nothing to render. `hidden` gates transport at two points:
//
//   src/core/aeordb/frame-store-normalizers.mjs:159-161 `isPreviewVisibleFrame`
//     applied at src/core/aeordb/frame-store-preview.mjs:205 (default window).
//   src/shared/frame-window-filters.mjs:498-503 `frameMatchesWindowFilters`
//     applied at frame-store-preview.mjs:95 (filtered window) and again
//     client-side at src/client/components/kikx-runtime-events.mjs:182.

const COORDINATION_FRAME_TYPE = 'UserMessage';
const COORDINATION_AUTHOR_PREFIX = 'internal:';

// SCOPE: exactly ONE internal author surfaces.
//
// This was a DENYLIST and that was the bug. There are 36 `internal:<name>`
// authorIDs in `src/`, of which the denylist named 11; the other 25 failed OPEN.
// Two of them were live in `kikx-dev2` and admitted 24 real frames by this
// predicate before the fix:
//
//   internal:pending-tool-recovery  23 frames  "Kikx resumed pending tool call(s)
//     after a restart. - exec: success — {…tool output JSON…}"
//   internal:question-deadline       1 frame   "Question <id> reaches its
//     default-answer deadline."
//
// Both are hidden AND carry a `targetAgentID` AND carry `content.text`, which is
// every gate the old predicate checked. They are machine bookkeeping — recovery
// replays and a timer firing — and they answer "what happened to the runtime",
// not "who told this bot what to do". Surfacing them would have buried the one
// card the owner actually asked for under resume-noise, including raw tool
// output JSON.
//
// The direction of the test is therefore reversed: an unknown author is REFUSED.
// A future `internal:` writer that genuinely carries a human-readable handoff has
// to be added here deliberately, and the spec fails until it is. Failing closed
// is the right bias for a rule whose failure mode is "leak internal bookkeeping
// into the owner's conversation".
//
// Why exactly this author: `inviteWakeText`
// (src/core/tools/session-invite-wake.mjs:12-16) is the only writer that builds
// prose FOR A PERSON about who invited whom, and `session-invite-wake.mjs:25-28`
// is the only caller of `wakeAgentInSession` that passes an authorID at all.
const SURFACED_WAKE_AUTHORS = new Set([
  'internal:session-invite',
  // A coordinator telling a WORKER what to do. The invite wake only proves a bot
  // arrived; it says nothing about the instruction that followed, which is the
  // half of the owner's report this file could not answer ("I would have liked
  // to see Zav messaging this bot, and what instructions were given").
  // `session-message` with `wake: true` writes exactly that: hidden, directed at
  // one agent, prose authored by the coordinating agent.
  //
  // Deliberately NOT the same author as the invite wake. Two different events —
  // arrival and instruction — have to stay distinguishable in the card header,
  // and `describeCoordinationWake` already falls back to "show the whole text,
  // claim no inviter" for anything that is not the generated invite sentence.
  'internal:session-message',
]);

// Named for the report's benefit and to keep the reasoning above checkable: these
// are the internal authors that must NOT surface even though they are hidden,
// directed, and carry text. Listed rather than left implicit so that adding one
// of them to SURFACED_WAKE_AUTHORS requires deleting its line here too.
const NEVER_SURFACED_AUTHORS = new Set([
  // The two that were actually leaking. See the comment above.
  'internal:pending-tool-recovery',
  'internal:question-deadline',
  // Compaction is already its own visible frame type.
  'internal:compaction',
  // Recovery re-issues a wake; the original shows once, on its own.
  'internal:runtime-recovery',
  // Merge, participant, and scheduling bookkeeping, not instructions.
  'internal:session-merge',
  'internal:session-participant',
  'internal:scheduled-frame-cancel',
  'internal:scheduled-frame-queue',
  'internal:frame-store',
  // Control-plane signals, not messages to a bot.
  'internal:slash-command-router',
  'internal:process-manager',
  'internal:autonomous-chain',
  'internal:agent-continuation',
]);

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// True when the frame is a hidden, directed, prose wake from the system to one
// agent — i.e. exactly the handoff the owner could not see.
export function isCoordinationWakeFrame(frame) {
  if (!frame || typeof frame !== 'object')
    return false;

  // Only frames that were hidden are candidates. A visible UserMessage is owner
  // chat or an already-surfaced message and needs no special treatment.
  if (frame.hidden !== true)
    return false;

  if (frame.deleted === true || frame.phantom === true)
    return false;

  if (frame.type !== COORDINATION_FRAME_TYPE)
    return false;

  let authorID = typeof frame.authorID === 'string' ? frame.authorID : '';
  if (!authorID.startsWith(COORDINATION_AUTHOR_PREFIX))
    return false;

  // Fails CLOSED: an author that is not on the surfaced list stays hidden, so a
  // new internal writer cannot leak into the thread by accident. The explicit
  // NEVER_SURFACED_AUTHORS check is redundant today (the two sets are disjoint)
  // and is kept as the second belt: if somebody adds an author to
  // SURFACED_WAKE_AUTHORS without removing it here, refusal still wins.
  if (!SURFACED_WAKE_AUTHORS.has(authorID))
    return false;

  if (NEVER_SURFACED_AUTHORS.has(authorID))
    return false;

  // The discriminator. Without a target this is a broadcast or a bookkeeping
  // row, not "the system woke THIS bot".
  if (!hasText(frame.targetAgentID))
    return false;

  // A wake with no text would render as an empty card; leave it to the store.
  if (!hasText(frame.content?.text))
    return false;

  return true;
}

// The one question every gate asks: may a person see this frame in the thread?
//
// `hidden` remains authoritative for everything that is not a coordination
// wake, so this is a strict widening: it can only ever ADD the wake frames and
// never removes a frame that was visible before.
export function isThreadVisibleFrame(frame) {
  if (!frame || typeof frame !== 'object')
    return false;

  // An agent-only frame was written for the agent, not for the thread. This is a
  // narrowing that sits BESIDE the hidden widening below, deliberately: the
  // widening exists so a person can see who woke which bot, and an agent-only
  // frame is the opposite case - its whole purpose is to stay out of the session
  // while still being delivered. Read from the persisted flag so a frame written
  // by a plugin stays out after that plugin is unloaded.
  if (frame.agentOnly === true)
    return false;

  return frame.hidden !== true || isCoordinationWakeFrame(frame);
}

// Where a surfaced wake sits in the filter popup.
//
// It is filed under User, because that is the type it is persisted as and the
// thread already has a User row. Filing it under a new category would default
// it to hidden for everyone who has narrowed the popup, which is the bug again.
export const COORDINATION_FILTER_CATEGORY = 'user';

// A one-line description of the wake for the card header: who was woken, and by
// whom when the text names an inviter.
//
// The inviter is not a structured field. `wakeAgentInSession` overwrites
// `authorID` with `internal:session-invite` and records only the INVITEE
// (`content.agentID` / `content.agentName`); the inviter exists solely inside
// the text produced by `inviteWakeText`
// (src/core/tools/session-invite-wake.mjs:12-16). So this reads that exact
// generated shape and, when it does not match, keeps the inviter out rather
// than guessing one. Adding a real field to the write path is out of scope for
// a visibility change.
//
// The pattern is anchored on the generator's invariant suffix (", review the
// session context now") rather than on the first period. Splitting on the first
// period looks right and is wrong twice over:
//   inviter "Dr. Smith"  -> captured "Dr", and the instruction lost "Smith."
//   title  'the "big" refactor' -> the greedy title crossed its own quote
// A wrong name is worse than no name, so anything that fails to match falls
// back to omitting the inviter and showing the whole text.
const INVITE_WAKE_SUFFIX = ', review the session context now';
const INVITE_HEAD_PATTERN = /^You have been invited to "([\s\S]*)" by ([\s\S]*)$/;

export function describeCoordinationWake(frame) {
  let text = typeof frame?.content?.text === 'string' ? frame.content.text.trim() : '';
  let invitee = hasText(frame?.content?.agentName)
    ? frame.content.agentName.trim()
    : (hasText(frame?.targetAgentID) ? frame.targetAgentID : '');

  // Anything that is not the generated shape shows its whole text and claims
  // nothing. A wrong inviter name is worse than no inviter name.
  let unknown = { invitee, inviter: '', sessionTitle: '', instruction: text, text };

  let suffixAt = text.indexOf(INVITE_WAKE_SUFFIX);
  if (suffixAt === -1)
    return unknown;

  // Split at the invariant suffix, so the greeting is everything before it.
  // The suffix is what makes this unambiguous: without it there is no reliable
  // boundary, because the inviter's own name may contain a period.
  let head = text.slice(0, suffixAt);
  let match = INVITE_HEAD_PATTERN.exec(head);
  if (!match)
    return unknown;

  let sessionTitle = match[1];
  let rest = match[2];

  // `rest` is "<inviter>. <invitee>". The invitee name is known from the frame,
  // so strip that exact tail first; only then is the remaining ". " the
  // inviter/invitee boundary. `Dr. Smith` survives because the period inside it
  // is never a candidate boundary.
  let inviter;
  if (hasText(invitee) && rest.endsWith(`. ${invitee}`)) {
    inviter = rest.slice(0, rest.length - invitee.length - 2);
  } else {
    let cut = rest.lastIndexOf('. ');
    inviter = cut === -1 ? rest : rest.slice(0, cut);
  }

  // The instruction is the generated sentence minus the greeting the header
  // already shows, i.e. from the invitee's name onward.
  let inviteePart = rest.slice(inviter.length).replace(/^\.\s*/, '');
  let instruction = `${inviteePart}${text.slice(suffixAt)}`.trim();

  return {
    invitee,
    inviter: inviter.trim(),
    sessionTitle,
    instruction: instruction || text,
    text,
  };
}
