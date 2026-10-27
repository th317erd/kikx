'use strict';

// Session forking — the planner.
//
// OWNER'S GOAL: a child session is a FORK of its parent. Its context is "the
// parent's context at the moment of creation (plus the child's own frames)", so
// the child starts immediately up to speed with what the parent was doing, and
// the provider prompt cache is reused because the prefix is unchanged.
//
// DESIGN (owner decision, supersedes an earlier clamp-at-fork draft):
// the fork copies the parent's frames THROUGH, as they are. It does NOT clamp,
// truncate, drop or summarise anything by default.
//
// Why copy-through and not clamp-at-fork:
//
//   * The clamp is `FrameContextBuilder`'s job AT READ TIME, not the fork's job
//     at write time. `prepareAgentContext` builds the provider history from the
//     most recent completed CompactionFrame plus everything after it
//     (frame-context-builder.mjs:167-182), and it does this on EVERY request,
//     for free, for every session including a forked child. Reimplementing that
//     windowing rule inside the fork would be a second, divergent copy of a rule
//     this codebase already owns — the exact defect class we keep out.
//   * Clamping at fork time requires a compaction to EXIST before the fork.
//     Producing one is expensive and slow, and it misses the cache: it invents a
//     summary the parent's provider never saw.
//   * Copy-through is what actually guarantees the cache hit. The child's frame
//     list BEGINS with the parent's frames, so the child's prompt at turn one is
//     byte-identical to the parent's next prompt. It stays a hit as the child
//     appends, because only the tail grows. That is the whole feature.
//   * The cost is that the child starts at the parent's current fill (up to the
//     ~70% compaction trigger). That is acceptable, and it is precisely what
//     makes the child immediately up-to-speed. The child compacts on its own
//     schedule afterwards, which is what "self-sufficient" means.
//   * A user who wants a small, pre-summarised fork runs `/compact` in the
//     parent first. Manual compaction already writes a visible CompactionFrame
//     with content.status running -> complete. The fork must never create one.
//
// Invariants this module holds, each load-bearing:
//
//   * Copy, not reference. The AeorDB store is a SINGLE database file; what is
//     per-session is the store KEY, not a directory. `framePath`
//     (aeordb/frame-store-paths.mjs:32-35) builds
//     `/sessions/<sessionID>/interactions/<id>/frames/<order>-<type>-<id>.json`,
//     and `saveFrame` is `aeordb.putFile(this.framePath(sessionID, frame), ...)`
//     (aeordb/frame-store-commit.mjs:199-205). So "copy into the child" is one
//     put under a key whose session segment names the child — there is no
//     directory to copy and no filesystem primitive involved.
//     That the parent may later be compacted again or deleted, while the child
//     must survive unaided, is what forces the copy rather than a pointer.
//     `seedFrames` is a fresh array of fresh objects.
//   * `parentID: null` on every copied frame. The copied frames are CONTEXT, not
//     conversation: the child's stream must never parent-link back into parent
//     frames. Because FrameEngine stamps a new frame's `parentID` from the
//     engine's current head, nulling the seed's parentIDs is also what makes the
//     child's own first frame start a clean chain (see `detachChildFrame`).
//   * `order` and `commitOrder` are preserved VERBATIM. Neither is cosmetic.
//     `projectFrameMessages` sorts with `compareFrameOrder`
//     (frame-manager.mjs:548-554): createdClock, then createdAt, then `order`,
//     then `commitOrder` as the final tie-break. Preserving `order` is what keeps
//     ordering exact, and it also keeps the child's own frames after the seed,
//     because FrameEngine folds its watermark to the highest hydrated order
//     (:186) and stamps new frames `++this._frameOrder` (:255).
//     `commitOrder` only DECIDES when two frames share the same `order`, so
//     removing it is not the catastrophic reordering an earlier draft of this
//     comment claimed: with unique orders, parent and child project identically
//     either way. It is preserved here because it is free and because shared
//     orders are reachable in principle, so a pure planner should not discard a
//     sort key it was handed.
//
//     Through the REAL write path, however, `commitOrder` is normalised and is
//     therefore NOT load-bearing end to end: `FrameEngine._applyCommitOrder`
//     unconditionally sets `frame.commitOrder = commitOrder`
//     (frames/frame-engine.mjs:435-447, called at :109). Measured: parent frames
//     supplied at commitOrders 9 and 2 are persisted as 1 and 1, and the forked
//     child comes out 1 and 1 too, so the parent and child projections match
//     despite the rewrite — the rewrite is symmetric. Preserving the field here
//     keeps the planner faithful to its input; it is not what buys the cache hit.
//
//     Note also that FrameEngine STAMPS a missing `order`
//     (`numberOr(input.order, existing?.order || ++this._frameOrder)`, :254), so
//     a child cannot be handed an unnumbered frame: it would be renumbered on
//     hydration. That is a further reason the fork preserves `order`.
//   * No fork-junction marker frame, ever. No "Go Up", no "Branch", no navigation
//     frame. The child's frames must read as one continuous conversation; a
//     marker would both poison the history prefix and add a second navigation
//     surface the owner has rejected. Navigation between parent and child is a
//     UI concern that already exists.
//   * Nothing about the parent's identity leaks into the model. `sessionID` is
//     rewritten to the child, but neither `sessionID` nor `id` is read by the
//     projection or by `frameToModelTurn`, which is why renaming them preserves
//     the cache. Verified: `grep sessionID` on frame-context-builder.mjs and
//     agent-model-context.mjs returns zero hits.
//
// NO SECOND FINDER. "Which compaction is latest" is a decision this codebase
// already makes; this module delegates to the shared rules
// `latestCompactionFrame` (agent-brief-state.mjs:41) and `compactionBoundaryOrder`
// (:29) rather than adding a third, subtly-different one. Those shared rules are
// only consulted by the opt-in 'clamp' policy; copy-through never needs them.
//
// This module is pure and dependency-injected: no store, no DB, no engine, no
// clock, no randomUUID. Every input is a plain object and every output is plain
// data, so the planner is testable with object literals alone.

import { isCompactionFrame as defaultIsCompactionFrame } from '../frames/frame-types/frame-type-helpers.mjs';
import {
  compactionBoundaryOrder,
  latestCompactionFrame,
} from '../plugins/agent-brief-state.mjs';

export const FORK_REASON = Object.freeze({
  FRESH: 'fresh-context',
  EMPTY: 'empty-parent',
  COPY: 'copy-through',
  NO_COMPACTION: 'no-compaction',
  COMPACTION_BOUNDARY: 'compaction-boundary',
});

// How much of the parent the child inherits.
//
//   'copy'      (DEFAULT) — every parent frame, in order, unmodified in
//                           content. No clamp, no truncation, no summarising.
//                           The clamp happens later, per request, in
//                           FrameContextBuilder. This is the cache-exact choice
//                           and the owner's decision.
//   'clamp'     — OPT-IN. Seed from the newest completed compaction boundary
//                   only (boundary frame + post-boundary tail). Cheaper to ship
//                   into a huge parent, but it needs the parent to have compacted
//                   first, and it is NOT a prefix of the parent's raw history.
//                   Kept because it is a legitimate alternative and because a
//                   test must be able to name it.
//   'summarize' — NOT IMPLEMENTED. Reserved for a fork-time, child-owned
//                   compaction frame that summarises the parent's oldest frames
//                   before seeding. It throws rather than silently degrading: a
//                   silent fallback would hide the exact oversized prompt this
//                   option exists to avoid.
export const OVERFLOW_POLICY = Object.freeze({
  COPY: 'copy',
  CLAMP: 'clamp',
  SUMMARIZE: 'summarize',
});

const POLICIES = new Set(Object.values(OVERFLOW_POLICY));

export class ForkPolicyNotImplementedError extends Error {
  constructor(policy) {
    super(`overflowPolicy '${policy}' is not implemented yet; use 'copy'`);
    this.name = 'ForkPolicyNotImplementedError';
    this.policy = policy;
  }
}

function normalizedFrames(parentFrames) {
  return Array.isArray(parentFrames)
    ? parentFrames.filter((frame) => frame && typeof frame === 'object')
    : [];
}

// The frames the child inherits, in original order, without mutating anything.
//
// `parentFrames` are expected in storage order. The returned order is a
// convenience: the engine re-sorts by the same comparator the projection uses,
// so what actually matters is that `order`/`commitOrder`/timestamps survive.
export function selectForkFrames(parentFrames = [], {
  overflowPolicy = OVERFLOW_POLICY.COPY,
  isCompactionFrame = defaultIsCompactionFrame,
  findLatestCompaction = latestCompactionFrame,
} = {}) {
  if (!POLICIES.has(overflowPolicy))
    throw new TypeError(`unknown overflowPolicy '${overflowPolicy}'`);
  if (overflowPolicy === OVERFLOW_POLICY.SUMMARIZE)
    throw new ForkPolicyNotImplementedError(overflowPolicy);

  let frames = normalizedFrames(parentFrames);
  if (frames.length === 0)
    return { frames: [], sourceCompactionFrame: null, droppedFrameCount: 0, reason: FORK_REASON.EMPTY };

  // Copy-through: the parent's frames ARE the child's context. Nothing is
  // clamped here because the reader clamps for every request anyway.
  if (overflowPolicy === OVERFLOW_POLICY.COPY) {
    return {
      frames: frames.slice(),
      // Informational only: the newest completed boundary the child inherits,
      // and therefore the boundary the child's own reader will clamp at. It is
      // not a "source" the seed was reduced to — nothing was reduced.
      sourceCompactionFrame: findLatestCompaction({ frames }) ?? null,
      droppedFrameCount: 0,
      reason: FORK_REASON.COPY,
    };
  }

  // ---- opt-in clamp -------------------------------------------------------
  let latest = findLatestCompaction({ frames });
  // `latestCompactionFrame` can fall back to `context.contextMemory.latestCompaction`
  // (agent-brief-state.mjs:63), a frame that need not be present in `frames`. A
  // boundary we cannot COPY is a boundary we cannot clamp to. The finder is
  // injectable so this guard is reachable from a test rather than being
  // unreachable defensive code.
  if (latest && !frames.includes(latest))
    latest = null;

  if (!latest) {
    return {
      frames: frames.slice(),
      sourceCompactionFrame: null,
      droppedFrameCount: 0,
      reason: FORK_REASON.NO_COMPACTION,
    };
  }

  let boundaryOrder = compactionBoundaryOrder(latest);
  // Mirror the reader's clamp. Note the deliberate asymmetry: the reader also
  // drops hidden/deleted frames from the tail, and we do not. The child inherits
  // the parent's storage and its OWN FrameContextBuilder applies those filters.
  // Filtering twice risks dropping a frame the child would have kept, and a
  // hidden frame still participates in tool call/result collapsing. What must
  // not vary is WHICH boundary is chosen and what the order comparison is.
  let tail = frames.filter((frame) => {
    if (frame.id === latest.id)
      return false;
    if (isCompactionFrame(frame))
      return false;
    return Number(frame.order ?? 0) > boundaryOrder;
  });

  return {
    frames: [ latest, ...tail ],
    sourceCompactionFrame: latest,
    droppedFrameCount: frames.length - (tail.length + 1),
    reason: FORK_REASON.COMPACTION_BOUNDARY,
  };
}

// Re-home one frame into the child's session. Identity changes; everything the
// model can observe stays byte-identical.
//
// Changed: `id`, `sessionID`, `parentID` (nulled), `updatedAt` (filled if absent).
// Cleared: `groupID`/`groupType` — a parent grouping id is meaningless in the
// child and would collide with a group the child creates itself. Measured safe:
// the projection only substitutes a phantom frame's id with its groupID inside
// `upsertFrameArray` (frame-manager.mjs:185,396-397), which `projectFrameMessages`
// does not call; a phantom frame with groupID stripped still projects to the
// same turn.
// Kept verbatim: `type`, `content`, `order`, `commitOrder` (the projection's
// final sort tie-break — see the header note), `hidden`, `deleted`,
// `phantom`, `authorType`, `authorID`, `authorDisplayName`, `targets`,
// `recipients`, `timestamp`/`createdAt`/`createdClock`, and `compaction`.
export function rehomeForkFrame(frame, { childSessionID, frameID, interactionID = null } = {}) {
  if (!frame || typeof frame !== 'object')
    throw new TypeError('rehomeForkFrame() requires a frame object');
  if (typeof childSessionID !== 'string' || childSessionID === '')
    throw new TypeError('rehomeForkFrame() requires a non-empty childSessionID');
  if (typeof frameID !== 'string' || frameID === '')
    throw new TypeError('rehomeForkFrame() requires a non-empty frameID');

  let next = {
    ...frame,
    id: frameID,
    sessionID: childSessionID,
    parentID: null,
    groupID: null,
    groupType: null,
    updatedAt: frame.updatedAt ?? frame.timestamp ?? 0,
  };

  if (interactionID != null)
    next.interactionID = interactionID;

  return next;
}

// Build the child's seed: select the parent's frames, then re-home every frame
// into the child's namespace with fresh ids.
//
// `createFrameID(frame, index)` is injected so the caller owns id generation
// (the engine's `idGenerator`); the default is a deterministic, collision-free
// derived id, which is what keeps this module pure and its tests reproducible.
//
// `parentMessageCount` is deliberately NOT accepted: nothing here has a use for
// it. The parent's projected message count is already derivable from
// `parentFrames`, and a caller-supplied count that could disagree with the
// frames we were handed would be a second source of truth for the same number.
export function planSessionFork({
  parentFrames = [],
  childSessionID,
  parentSessionID = null,
  freshContext = false,
  overflowPolicy = OVERFLOW_POLICY.COPY,
  createFrameID,
  interactionID = null,
  isCompactionFrame = defaultIsCompactionFrame,
  findLatestCompaction = latestCompactionFrame,
} = {}) {
  if (typeof childSessionID !== 'string' || childSessionID === '')
    throw new TypeError('planSessionFork() requires a non-empty childSessionID');

  // freshContext:true is today's behaviour, preserved exactly: a child session
  // gets a brand-new empty FrameEngine (frame-runtime.mjs:104) and inherits
  // nothing. Retained because it is the right choice for a short-lived child of
  // a very large parent, where the inherited fill would only be dead weight.
  if (freshContext === true) {
    return {
      seedFrames: [],
      inheritedCount: 0,
      droppedFrameCount: 0,
      sourceCompactionFrameID: null,
      mode: 'fresh',
      overflowPolicy,
      reason: FORK_REASON.FRESH,
      parentSessionID: parentSessionID ?? null,
    };
  }

  let selection = selectForkFrames(parentFrames, { overflowPolicy, isCompactionFrame, findLatestCompaction });
  let nextFrameID = typeof createFrameID === 'function'
    ? createFrameID
    : (frame, index) => `${childSessionID}:inherit:${index}:${frame?.id ?? 'frame'}`;

  let seedFrames = selection.frames.map((frame, index) => {
    let frameID = nextFrameID(frame, index);
    return rehomeForkFrame(frame, { childSessionID, frameID, interactionID });
  });

  return {
    seedFrames,
    inheritedCount: seedFrames.length,
    droppedFrameCount: selection.droppedFrameCount,
    sourceCompactionFrameID: selection.sourceCompactionFrame?.id ?? null,
    mode: 'fork',
    overflowPolicy,
    reason: selection.reason,
    parentSessionID: parentSessionID ?? null,
  };
}

// The next frame the child writes must not parent-link into the seed. Copied
// frames are context, not conversation, so the child's first own frame starts a
// fresh parent chain. Returns a new object with `parentID: null`.
//
// This helper exists so the call site does not have to remember the rule.
export function detachChildFrame(frame) {
  if (!frame || typeof frame !== 'object')
    return frame;
  return { ...frame, parentID: null };
}

// Re-exported so a call site can name the selection rule it is agreeing with
// without importing the plugins layer directly. Not a new finder: these are the
// same function objects.
export { compactionBoundaryOrder, latestCompactionFrame };
