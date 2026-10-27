'use strict';

// Spec for src/core/context/session-fork.mjs — the fork planner.
//
// WHAT IS BEING PINNED
//   A Kikx child session is a FORK of its parent: its context is the parent's
//   context AT THE MOMENT OF CREATION, copied into the child's own namespace,
//   plus the child's own frames. `freshContext: true` preserves today's
//   behaviour (a brand-new empty FrameEngine, frame-runtime.mjs:104) and
//   inherits nothing.
//
// WHAT CHANGED AND WHY (owner decision, supersedes the earlier clamp-at-fork)
//   The fork COPIES THROUGH: the seed is every parent frame, unmodified. It does
//   not clamp, truncate, drop or summarise. The clamp is `FrameContextBuilder`'s
//   job at READ time (frame-context-builder.mjs:167-182), performed on every
//   request via `prepareAgentContext`, for the parent and the child alike. Doing
//   it again at fork time would be a second, divergent copy of a rule the codebase
//   already owns — and it would require a compaction to exist before the fork,
//   which is slow, expensive, and misses the cache.
//
// WHY THE CACHE TEST IS THE POINT (section 3)
//   The whole justification for forking is that the child's prompt PREFIX is
//   identical to the parent's, so the provider prompt cache is reused. Storage
//   identity (id, sessionID) necessarily differs between parent and child; the
//   PROJECTED model turns must not differ by a single character. Those tests
//   project both sides through the real `frameToModelTurn` — the exact function
//   the provider adapter uses (agent-model-context.mjs:106) — and compare the
//   `{ role, content }` list. They additionally assert that the per-session
//   fields DO differ, so a test that accidentally compared storage identity to
//   itself could not pass.
//
// ANTI-VACUITY AND MUTATION CONTROLS
//   * The cache tests assert the seed is non-empty and that the child's sessionID
//     really was rewritten, so an empty-child bug cannot pass.
//   * Section 9 pins the measured `commitOrder` regression: stripping it
//     reorders the projection. Without that field the child sorts by array index
//     where the parent sorted by commit order.
//   * Test "no fork-junction marker frame" would fail if a "Go Up" frame were added.
//   * Test "copy-through does NOT clamp" would fail if the old clamp-at-fork
//     behaviour were reinstated as the default.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameEngine } from '../../../src/core/frames/frame-engine.mjs';
import { projectFrameMessages } from '../../../src/shared/frame-manager/frame-manager.mjs';
import { frameToModelTurn } from '../../../src/core/plugins/agent-model-context.mjs';
import { FrameContextBuilder } from '../../../src/core/compaction/frame-context-builder.mjs';
import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
} from '../../../src/core/compaction/agent-compaction-template.mjs';
import {
  FORK_REASON,
  OVERFLOW_POLICY,
  compactionBoundaryOrder,
  latestCompactionFrame,
  planSessionFork,
  selectForkFrames,
} from '../../../src/core/context/session-fork.mjs';
import {
  compactionBoundaryOrder as sharedBoundaryOrder,
  latestCompactionFrame as sharedLatestCompactionFrame,
} from '../../../src/core/plugins/agent-brief-state.mjs';
import { postAgentSessionMessage } from '../../../src/core/tools/session-tool-helpers.mjs';

// ---------------------------------------------------------------------------
// Fixtures. Plain objects only: no store, no DB, no clock, no randomness.
// ---------------------------------------------------------------------------

const PARENT_ID = 'ses_parent';
const CHILD_ID = 'ses_child';
const WINDOW = 128000;

function withCommonFields(base, { id, type, sessionID, order, authorType, authorID, authorDisplayName }) {
  return {
    id,
    type,
    sessionID,
    order,
    interactionID: `itx-${order}`,
    parentID: null,
    authorType,
    authorID,
    authorDisplayName,
    timestamp: 1000 + order,
    createdAt: 1000 + order,
    updatedAt: 1000 + order,
    hidden: false,
    deleted: false,
    phantom: false,
    targets: [],
    recipients: [],
    ...base,
  };
}

function userFrame({ id, order, sessionID = PARENT_ID, text }) {
  return withCommonFields({ content: { text } }, {
    id, type: 'UserMessage', sessionID, order,
    authorType: 'user', authorID: 'user-1', authorDisplayName: 'Wyatt',
  });
}

function agentFrame({ id, order, sessionID = PARENT_ID, text }) {
  return withCommonFields({ content: { text } }, {
    id, type: 'AgentMessage', sessionID, order,
    authorType: 'agent', authorID: 'agent-zav', authorDisplayName: 'Zav',
  });
}

function toolCallFrame({ id, order, sessionID = PARENT_ID, toolCallID = 'call_1', toolName = 'exec' }) {
  return withCommonFields(
    { content: { toolName, phase: 'call', toolCallID, toolInput: { command: 'ls' } } },
    {
      id, type: 'ToolCall', sessionID, order,
      authorType: 'agent', authorID: 'agent-zav', authorDisplayName: 'Zav',
    },
  );
}

function toolResultFrame({ id, order, callID, sessionID = PARENT_ID, toolCallID = 'call_1', toolName = 'exec' }) {
  return withCommonFields(
    { content: { toolName, phase: 'result', toolCallID, toolCallFrameID: callID, toolOutput: 'a.txt' } },
    {
      id, type: 'ToolResult', sessionID, order,
      authorType: 'tool', authorID: 'tool:exec', authorDisplayName: 'exec',
    },
  );
}

function compactionFrame({ id, order, sessionID = PARENT_ID, boundaryOrder, status = 'complete', summary }) {
  return withCommonFields({
    compaction: {
      kind: COMPACTION_FRAME_KIND,
      status,
      boundaryFrameID: `f-${boundaryOrder}`,
      boundaryOrder,
      frameCount: boundaryOrder,
      startFrameID: 'f-1',
    },
    content: {
      kind: COMPACTION_FRAME_KIND,
      status,
      summary,
      text: summary,
      boundaryOrder,
      boundaryFrameID: `f-${boundaryOrder}`,
    },
  }, {
    id, type: COMPACTION_FRAME_TYPE, sessionID, order,
    authorType: 'system', authorID: 'internal:compaction', authorDisplayName: 'Kikx compaction',
  });
}

// A parent with NO compaction: 6 ordinary frames.
function uncompactedParent() {
  return [
    userFrame({ id: 'f-1', order: 1, text: 'PROJECT: fork planner' }),
    agentFrame({ id: 'f-2', order: 2, text: 'Reading the frame engine.' }),
    userFrame({ id: 'f-3', order: 3, text: 'Clamp at the boundary.' }),
    agentFrame({ id: 'f-4', order: 4, text: 'Planner drafted.' }),
    userFrame({ id: 'f-5', order: 5, text: 'Now prove the cache holds.' }),
    agentFrame({ id: 'f-6', order: 6, text: 'Writing the spec.' }),
  ];
}

// A parent that HAS compacted: history f-1..f-6, a boundary at order 6, then a
// post-boundary tail f-8..f-10 that the parent's own prompt still carries.
function compactedParent() {
  return [
    userFrame({ id: 'f-1', order: 1, text: 'PROJECT: fork planner, part one.' }),
    agentFrame({ id: 'f-2', order: 2, text: 'Reading the frame engine internals.' }),
    userFrame({ id: 'f-3', order: 3, text: 'Clamp at the boundary, not the head.' }),
    agentFrame({ id: 'f-4', order: 4, text: 'Planner drafted with six tests.' }),
    userFrame({ id: 'f-5', order: 5, text: 'Now prove the cache holds.' }),
    agentFrame({ id: 'f-6', order: 6, text: 'Spec written, gate green.' }),
    compactionFrame({
      id: 'cmp-1', order: 7, boundaryOrder: 6,
      summary: 'Compacted: fork planner built with a clamp-to-boundary design.',
    }),
    userFrame({ id: 'f-8', order: 8, text: 'Post-boundary: wire the call site.' }),
    agentFrame({ id: 'f-9', order: 9, text: 'Call site wired.' }),
    userFrame({ id: 'f-10', order: 10, text: 'Ship checkpoint one.' }),
  ];
}

function engineFor(frames) {
  let engine = new FrameEngine({ history: false });
  engine.hydrate(frames);
  return engine;
}

// The clamp the PARENT's own prompt goes through: projection, then the newest
// compaction boundary. Mirrors compaction-service.mjs:77-79 + :143. Used to
// prove the child's reader reaches the SAME result as the parent's reader.
function readContext(frames) {
  let builder = new FrameContextBuilder({ contextWindowTokens: WINDOW });
  return builder.build(projectFrameMessages(frames), {
    agentContextWindowTokens: WINDOW,
    usageOverheadTokens: 0,
  }).frames;
}

// The PROVIDER-FACING projection: exactly what the model would be sent, reduced
// to the only two fields a provider observes. This is the unit the cache
// argument is about — not frames, whose ids and sessionIDs must differ.
function projectTurns(frames) {
  return (Array.isArray(frames) ? frames : [])
    .map((frame) => frameToModelTurn(frame, { currentAgentID: '', currentFrameID: null, registry: null }))
    .filter((message) => message != null)
    .map((message) => ({ role: message.role, content: message.content }));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (let key of Object.keys(value))
      deepFreeze(value[key]);
  }
  return value;
}

// A minimal stand-in for FrameRuntime: only the four surfaces
// postAgentSessionMessage touches (session-tool-helpers.mjs:15-71).
function runtimeFor(engine, sessionID) {
  let counter = 0;
  let entry = { session: { id: sessionID }, frameEngine: engine };
  return {
    idGenerator: () => `${sessionID}:own:${++counter}`,
    clock: () => 9000 + counter,
    ensureSessionEntry: async () => entry,
    frameStore: { flush: async () => {} },
    syncSessionManifestFromEngine: () => {},
  };
}

function fork(parentFrames, extra = {}) {
  return planSessionFork({
    parentFrames,
    parentSessionID: PARENT_ID,
    childSessionID: CHILD_ID,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 0. One finder, one default policy.
// ---------------------------------------------------------------------------

test('the planner shares ONE finder with the rest of the system (no split brain)', () => {
  // Two finders that disagree is exactly the split-brain this codebase has been
  // bitten by. session-fork.mjs must NOT own its own rule.
  assert.equal(latestCompactionFrame, sharedLatestCompactionFrame,
    'the planner must re-use the shared latestCompactionFrame, not a local copy');
  assert.equal(compactionBoundaryOrder, sharedBoundaryOrder,
    'the planner must re-use the shared compactionBoundaryOrder');

  // And it must still recognise a real boundary frame.
  let frame = compactionFrame({ id: 'c', order: 9, boundaryOrder: 8, summary: 's' });
  assert.equal(latestCompactionFrame({ frames: [ frame ] })?.id, 'c');

  // The real constants are what the shape uses; assert them so a rename in the
  // template module is caught here rather than silently in production.
  assert.equal(COMPACTION_FRAME_TYPE, 'CompactionFrame');
  assert.equal(COMPACTION_FRAME_KIND, 'compaction_frame');
});

test('the default policy is copy-through, not clamp', () => {
  // The owner's decision: the fork copies the parent as it is. A clamp-at-fork
  // default is what this replaces, so it must be named and pinned here.
  assert.equal(OVERFLOW_POLICY.COPY, 'copy');
  let plan = fork(compactedParent());
  assert.equal(plan.overflowPolicy, OVERFLOW_POLICY.COPY);
  assert.equal(plan.reason, FORK_REASON.COPY);
});

// ---------------------------------------------------------------------------
// 1. freshContext:true — today's behaviour, preserved.
// ---------------------------------------------------------------------------

test('freshContext:true inherits zero frames', () => {
  let parent = compactedParent();
  let plan = fork(parent, { freshContext: true });

  assert.deepEqual(plan.seedFrames, []);
  assert.equal(plan.inheritedCount, 0);
  assert.equal(plan.mode, 'fresh');
  assert.equal(plan.reason, FORK_REASON.FRESH);
  assert.equal(plan.droppedFrameCount, 0);

  // Anti-vacuity: the SAME parent forks non-empty when freshContext is off.
  let forked = fork(parent, { freshContext: false });
  assert.ok(forked.seedFrames.length > 0);
});

test('freshContext omitted defaults to forking', () => {
  let plan = fork(uncompactedParent());

  assert.equal(plan.mode, 'fork');
  assert.equal(plan.inheritedCount, 6);
});

// ---------------------------------------------------------------------------
// 2. Copy-through: the seed IS the parent, even when the parent compacted.
// ---------------------------------------------------------------------------

test('no compaction: seed equals the parent frames exactly', () => {
  let parent = uncompactedParent();
  let plan = fork(parent, { freshContext: false });

  assert.equal(plan.reason, FORK_REASON.COPY);
  assert.equal(plan.droppedFrameCount, 0);
  assert.equal(plan.inheritedCount, parent.length);
  assert.equal(plan.sourceCompactionFrameID, null);

  // Original order preserved verbatim (order/commitOrder are what the projection
  // sorts on, so this is a correctness requirement, not tidiness).
  assert.deepEqual(plan.seedFrames.map((f) => f.order), [ 1, 2, 3, 4, 5, 6 ]);

  // Projection of the seed equals the projection of the parent, turn for turn.
  assert.deepEqual(projectTurns(plan.seedFrames), projectTurns(parent));
});

test('copy-through does NOT clamp: a compacted parent is inherited whole', () => {
  // This is the test that would fail if the old clamp-at-fork default came back.
  // The parent HAS a boundary compaction at order 6; copy-through ignores it.
  let parent = compactedParent();
  let plan = fork(parent);

  assert.equal(plan.inheritedCount, parent.length);
  assert.equal(plan.droppedFrameCount, 0, 'copy-through must drop nothing');

  // The pre-boundary history really is present, not merely unmentioned.
  let seededText = JSON.stringify(projectTurns(plan.seedFrames));
  assert.equal(seededText.includes('part one'), true);
  assert.equal(seededText.includes('Reading the frame engine internals'), true);
  assert.equal(seededText.includes('Ship checkpoint one.'), true);

  // And the seed is the parent in order, frame for frame.
  assert.deepEqual(plan.seedFrames.map((f) => f.order), parent.map((f) => f.order));
});

test('the compaction frame is inherited as-is; the child never re-derives it', () => {
  let parent = compactedParent();
  let source = parent.find((f) => f.id === 'cmp-1');
  let plan = fork(parent);

  let inherited = plan.seedFrames.filter((f) => f.type === COMPACTION_FRAME_TYPE);
  assert.equal(inherited.length, 1, 'a compacted parent has exactly one boundary here');

  let copy = inherited[0];
  // New identity...
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.sessionID, CHILD_ID);
  // ...but the compaction metadata and the summary are verbatim, so the reader
  // clamps at the SAME boundary the parent used. That is rule 4: the child must
  // not re-derive compaction.
  assert.deepEqual(copy.compaction, source.compaction);
  assert.equal(copy.compaction.boundaryOrder, 6);
  assert.equal(copy.content.text, source.content.text);
  assert.equal(copy.content.summary, source.content.summary);
  assert.equal(plan.sourceCompactionFrameID, 'cmp-1');
});

test('every compaction frame is inherited under copy-through', () => {
  // The old clamp kept exactly one. Copy-through keeps them all, because it
  // keeps everything; the child's reader then clamps at the newest one itself.
  let parent = [
    ...compactedParent(),
    compactionFrame({ id: 'cmp-0', order: 0, boundaryOrder: 3, summary: 'Ancient summary.' }),
  ];

  let plan = fork(parent);
  let compactionFrames = plan.seedFrames.filter((f) => f.type === COMPACTION_FRAME_TYPE);
  assert.equal(compactionFrames.length, 2);
  assert.equal(plan.inheritedCount, parent.length);
});

// ---------------------------------------------------------------------------
// 3. THE CACHE PROOF. Projected model turns must match character for character.
// ---------------------------------------------------------------------------

test('cache proof: forked projection equals the parent projection turn for turn', () => {
  let parent = compactedParent();
  let plan = fork(parent);

  let parentProjection = projectFrameMessages(parent);
  let childProjection = projectFrameMessages(engineFor(plan.seedFrames).toArray());

  // Anti-vacuity: non-empty seed, and the session identity really was rewritten.
  assert.ok(plan.seedFrames.length > 0);
  assert.equal(plan.seedFrames[0].sessionID, CHILD_ID);

  let parentTurns = projectTurns(parentProjection);
  let childTurns = projectTurns(childProjection);
  assert.ok(parentTurns.length > 0);
  for (let message of parentTurns)
    assert.equal(typeof message.content, 'string');

  assert.deepEqual(childTurns, parentTurns);

  // The strongest offline form of the claim: the serialized request history is
  // character-identical, which is the condition for a provider cache hit.
  assert.equal(JSON.stringify(childTurns), JSON.stringify(parentTurns));

  // The dropped-fields half of the contract: storage identity DOES differ. If
  // these ever became equal, this test would be comparing a thing to itself.
  assert.notEqual(childProjection[0].id, parentProjection[0].id);
  assert.notEqual(childProjection[0].sessionID, parentProjection[0].sessionID);
  assert.equal(childProjection[0].sessionID, CHILD_ID);
  assert.equal(parentProjection[0].sessionID, PARENT_ID);
});

test('cache proof: the child reader clamps exactly where the parent reader does', () => {
  // The clamp happens at READ time, for both. This asserts the child's own
  // FrameContextBuilder reaches the parent's context even though the child's
  // stored frames are the parent's full history.
  let parent = compactedParent();
  let plan = fork(parent);

  let parentContext = readContext(parent);
  let childContext = readContext(engineFor(plan.seedFrames).toArray());

  // The parent really did clamp (10 stored frames -> 4 in context), so this is
  // not a vacuous comparison of two full histories.
  assert.ok(parentContext.length < parent.length);
  assert.equal(parentContext.length, 4);

  assert.equal(childContext.length, parentContext.length);
  assert.deepEqual(projectTurns(childContext), projectTurns(parentContext));
  assert.equal(JSON.stringify(projectTurns(childContext)), JSON.stringify(projectTurns(parentContext)));
});

test('cache proof survives a long parent (not an artefact of a tiny fixture)', () => {
  let frames = [];
  for (let order = 1; order <= 40; order++) {
    frames.push(order % 2 === 1
      ? userFrame({ id: `f-${order}`, order, text: `turn ${order}: do the thing` })
      : agentFrame({ id: `f-${order}`, order, text: `turn ${order}: done, next` }));
  }
  frames.push(compactionFrame({ id: 'cmp-big', order: 41, boundaryOrder: 30, summary: 'Compacted turns 1-30.' }));
  for (let order = 42; order <= 50; order++)
    frames.push(userFrame({ id: `f-${order}`, order, text: `post-boundary turn ${order}` }));

  let plan = fork(frames);
  assert.equal(plan.inheritedCount, frames.length);

  let childTurns = projectTurns(projectFrameMessages(engineFor(plan.seedFrames).toArray()));
  let parentTurns = projectTurns(projectFrameMessages(frames));
  assert.ok(parentTurns.length >= 50);
  assert.equal(JSON.stringify(childTurns), JSON.stringify(parentTurns));

  // And the read-time clamp still lands identically.
  assert.deepEqual(projectTurns(readContext(engineFor(plan.seedFrames).toArray())), projectTurns(readContext(frames)));
});

test('cache proof holds with tool call/result frames in the history', () => {
  // Tool frames are the riskiest case: the projection collapses a call/result
  // pair by matching `content.toolCallID` (frame-manager.mjs:329-355), and the
  // planner rewrites ids while preserving content. If collapsing broke, the
  // projected message count would change and the cache would miss.
  let frames = [
    userFrame({ id: 'u1', order: 1, text: 'run the tests' }),
    toolCallFrame({ id: 'tc1', order: 2 }),
    toolResultFrame({ id: 'tr1', order: 3, callID: 'tc1' }),
    agentFrame({ id: 'a1', order: 4, text: 'tests pass' }),
  ];

  let parentProjection = projectFrameMessages(frames);
  let plan = fork(frames);
  let childProjection = projectFrameMessages(engineFor(plan.seedFrames).toArray());

  // Anti-vacuity: the pair really did collapse, so this is not comparing
  // degenerate lists.
  assert.equal(parentProjection.length, 3);
  assert.equal(parentProjection.length, childProjection.length);

  let parentTurns = projectTurns(parentProjection);
  let childTurns = projectTurns(childProjection);
  assert.ok(parentTurns.length > 0);
  assert.deepEqual(childTurns, parentTurns);
  assert.equal(JSON.stringify(childTurns), JSON.stringify(parentTurns));
});

// ---------------------------------------------------------------------------
// 3b. The measured ordering regression: commitOrder must be preserved.
// ---------------------------------------------------------------------------

test('commitOrder survives the copy, and it decides when two orders tie', () => {
  // `compareFrameOrder` (frame-manager.mjs:548-554) compares createdClock, then
  // createdAt, then `order`, then `commitOrder` as the FINAL tie-break (via
  // `sortCommitOrder`, :560-567). So commitOrder only decides when two frames
  // share the same `order` — which the parent can reach whenever frames from
  // different writers meet. This test uses exactly that case, and proves the
  // field matters by stripping it and watching the order flip.
  //
  // (An earlier draft of this test gave the frames no `order` at all. That is
  // unreachable in practice: FrameEngine STAMPS a missing order
  // (`numberOr(input.order, existing?.order || ++this._frameOrder)`, :254), so
  // the child's engine renumbers such frames 1, 2, ... and the comparison stops
  // being about commitOrder.)
  let frames = [
    withCommonFields({ content: { text: 'A' } }, {
      id: 'a', type: 'UserMessage', sessionID: PARENT_ID, order: 1,
      authorType: 'user', authorID: 'u', authorDisplayName: 'W',
    }),
    withCommonFields({ content: { text: 'B' } }, {
      id: 'b', type: 'UserMessage', sessionID: PARENT_ID, order: 1,
      authorType: 'user', authorID: 'u', authorDisplayName: 'W',
    }),
  ];
  frames[0].commitOrder = 9;
  frames[1].commitOrder = 2;

  // The parent sorts the tie by commitOrder: 2 (B) before 9 (A).
  let parentOrder = projectTurns(projectFrameMessages(frames)).map((t) => t.content);
  assert.deepEqual(parentOrder, [ 'B', 'A' ]);

  let plan = fork(frames);
  assert.deepEqual(plan.seedFrames.map((f) => f.commitOrder), [ 9, 2 ],
    'commitOrder must survive the copy');

  let childOrder = projectTurns(projectFrameMessages(engineFor(plan.seedFrames).toArray()))
    .map((t) => t.content);
  assert.deepEqual(childOrder, parentOrder);

  // Anti-vacuity: strip the field and the order really does flip, so this test
  // would catch a planner that dropped it.
  let stripped = plan.seedFrames.map((frame) => {
    let copy = { ...frame };
    delete copy.commitOrder;
    return copy;
  });
  let strippedOrder = projectTurns(projectFrameMessages(engineFor(stripped).toArray()))
    .map((t) => t.content);
  assert.deepEqual(strippedOrder, [ 'A', 'B' ]);
});

test('order is preserved verbatim', () => {
  let parent = uncompactedParent();
  let plan = fork(parent);
  assert.deepEqual(plan.seedFrames.map((f) => f.order), parent.map((f) => f.order));

  // ...and the engine watermark folds to the highest inherited order, so the
  // child's own frames land after the seed rather than interleaving with it
  // (frame-engine.mjs:186, :255).
  assert.equal(engineFor(plan.seedFrames)._frameOrder, 6);
});

// ---------------------------------------------------------------------------
// 4. The inverse guard: freshContext:true must actually do something.
// ---------------------------------------------------------------------------

test('a fresh child projects strictly less than the parent', () => {
  let parent = compactedParent();

  let forked = fork(parent, { freshContext: false });
  let fresh = fork(parent, { freshContext: true });

  let parentTurns = projectTurns(projectFrameMessages(parent));
  let forkedTurns = projectTurns(projectFrameMessages(engineFor(forked.seedFrames).toArray()));
  let freshTurns = projectTurns(projectFrameMessages(engineFor(fresh.seedFrames).toArray()));

  // The fork is identical to the parent...
  assert.deepEqual(forkedTurns, parentTurns);
  // ...and the fresh child is strictly smaller. Without this, the flag could be
  // a no-op and every test above would still pass.
  assert.ok(freshTurns.length < parentTurns.length);
  assert.equal(freshTurns.length, 0);
  assert.ok(parentTurns.length > 0);
});

// ---------------------------------------------------------------------------
// 5. Storage identity differs; projected content identical.
// ---------------------------------------------------------------------------

test('copied frames take child ids but keep identical projected content', () => {
  let parent = uncompactedParent();
  let plan = fork(parent);

  let parentIDs = new Set(parent.map((f) => f.id));
  for (let frame of plan.seedFrames) {
    // Identity is new...
    assert.equal(frame.sessionID, CHILD_ID);
    assert.equal(parentIDs.has(frame.id), false, `frame id ${frame.id} leaked from the parent`);
    // ...content is verbatim.
    let source = parent.find((f) => f.order === frame.order);
    assert.equal(frame.type, source.type);
    assert.equal(frame.content.text, source.content.text);
    assert.equal(frame.authorType, source.authorType);
    assert.equal(frame.authorID, source.authorID);
    assert.equal(frame.order, source.order);
  }

  // And the projected turns are deeply equal: role, content, order.
  assert.deepEqual(projectTurns(plan.seedFrames), projectTurns(parent));
});

test('copied frames never parent-link into the parent stream', () => {
  let plan = fork(compactedParent());

  for (let frame of plan.seedFrames) {
    assert.equal(frame.parentID, null, 'copied frames are context, not conversation');
    assert.equal(frame.sessionID, CHILD_ID);
  }
});

test('no fork-junction marker frame is introduced', () => {
  let parent = compactedParent();
  let parentTypes = new Set(parent.map((f) => f.type));
  let plan = fork(parent);

  // No type the parent did not already have: in particular no "Go Up",
  // "Fork", "Branch" or handoff frame.
  for (let frame of plan.seedFrames) {
    assert.equal(parentTypes.has(frame.type), true, `unexpected frame type ${frame.type}`);
    assert.doesNotMatch(String(frame.type), /fork|branch|handoff|go-?up/i);
  }

  // Exactly the parent's set: nothing added, nothing dropped.
  assert.equal(plan.seedFrames.length, parent.length);
});

// ---------------------------------------------------------------------------
// 6. Empty parent, purity, and termination.
// ---------------------------------------------------------------------------

test('empty parent yields an empty seed and does not throw', () => {
  let plan = fork([]);

  assert.deepEqual(plan.seedFrames, []);
  assert.equal(plan.inheritedCount, 0);
  assert.equal(plan.droppedFrameCount, 0);
  assert.equal(plan.sourceCompactionFrameID, null);
  assert.equal(plan.reason, FORK_REASON.EMPTY);

  // A missing/!array parentFrames is likewise benign.
  assert.deepEqual(planSessionFork({ childSessionID: CHILD_ID }).seedFrames, []);
  assert.deepEqual(planSessionFork({ parentFrames: null, childSessionID: CHILD_ID }).seedFrames, []);
});

test('the planner does not mutate its input', () => {
  let parent = deepFreeze(compactedParent());
  let before = JSON.stringify(parent);

  let plan = fork(parent);

  assert.equal(JSON.stringify(parent), before, 'parent frames were mutated');
  // Frozen input would have thrown on any write; prove it really was frozen.
  assert.equal(Object.isFrozen(parent[0]), true);
  // The output must not alias the input's objects either.
  assert.notEqual(plan.seedFrames[0], parent[0]);
  // Nor may it alias the input's ARRAY. Without this, a planner returning the
  // caller's array would let the child push its own frames straight into the
  // parent's list.
  assert.notEqual(plan.seedFrames, parent, 'seedFrames must be a fresh array');
  let parentLength = parent.length;
  plan.seedFrames.push({ id: 'intruder' });
  assert.equal(parent.length, parentLength, 'pushing into seedFrames leaked into the parent array');
});

test('selectForkFrames does not alias its input array', () => {
  // planSessionFork builds its seed with .map(), which allocates, so an aliasing
  // selection would be invisible there. selectForkFrames is exported on its own
  // though, and a caller that mutated its result would be writing into the
  // parent's frame list. Pin the separation at the seam where it is observable.
  let parent = uncompactedParent();
  let selection = selectForkFrames(parent);

  assert.notEqual(selection.frames, parent, 'selection.frames must be a fresh array');
  selection.frames.push({ id: 'intruder', type: 'UserMessage' });
  assert.equal(parent.length, uncompactedParent().length, 'pushing into selection.frames leaked into the parent');
});

test('forking a fork terminates, does not double count, and stays self-sufficient', () => {
  // Grandparent -> parent (forked) -> child (forked again).
  let grandparent = compactedParent();
  let parentPlan = planSessionFork({
    parentFrames: grandparent,
    parentSessionID: 'ses_grandparent',
    childSessionID: PARENT_ID,
  });
  assert.equal(parentPlan.inheritedCount, grandparent.length);

  // The parent then does its own work and compacts again at its own boundary.
  let parentOwnFrames = [
    ...parentPlan.seedFrames,
    userFrame({ id: 'p-1', order: 101, sessionID: PARENT_ID, text: 'parent continues' }),
    agentFrame({ id: 'p-2', order: 102, sessionID: PARENT_ID, text: 'parent works' }),
    compactionFrame({ id: 'cmp-parent', order: 103, sessionID: PARENT_ID, boundaryOrder: 102, summary: 'Parent compacted its own fork.' }),
    userFrame({ id: 'p-4', order: 104, sessionID: PARENT_ID, text: 'parent tail' }),
  ];

  let childPlan = planSessionFork({
    parentFrames: parentOwnFrames,
    parentSessionID: PARENT_ID,
    childSessionID: CHILD_ID,
  });

  // Terminated (we got here), and no frame is counted twice: nothing recurses
  // through parentID, because the planner is a flat map.
  let childOrders = childPlan.seedFrames.map((f) => f.order);
  assert.equal(new Set(childOrders).size, childOrders.length, 'duplicate frames in the grandchild seed');
  assert.equal(childPlan.inheritedCount, parentOwnFrames.length);

  // The child is self-sufficient: every inherited frame is in the child's own
  // namespace, so the grandparent could be deleted now without effect.
  assert.equal(childPlan.seedFrames.filter((f) => f.sessionID !== CHILD_ID).length, 0);

  // Both compaction frames came through copy-through, in order, and the reader
  // will clamp at the newest one.
  let compactions = childPlan.seedFrames.filter((f) => f.type === COMPACTION_FRAME_TYPE);
  assert.deepEqual(compactions.map((f) => f.compaction.boundaryOrder), [ 6, 102 ]);
  assert.deepEqual(readContext(childPlan.seedFrames).map((f) => f.compaction?.boundaryOrder ?? null), [ 102, null ]);
});

test('a parentID cycle cannot be followed, because the planner never recurses', () => {
  // A frame that points at itself, plus a mutual pair. A planner that walked
  // parentID to gather history would loop forever or double count.
  let parent = [
    withCommonFields({ content: { text: 'self-referential' } }, {
      id: 'f-self', type: 'AgentMessage', sessionID: PARENT_ID, order: 1,
      authorType: 'agent', authorID: 'a', authorDisplayName: 'A',
    }),
    withCommonFields({ content: { text: 'points at self' } }, {
      id: 'f-a', type: 'AgentMessage', sessionID: PARENT_ID, order: 2,
      authorType: 'agent', authorID: 'a', authorDisplayName: 'A',
    }),
    withCommonFields({ content: { text: 'points back' } }, {
      id: 'f-b', type: 'AgentMessage', sessionID: PARENT_ID, order: 3,
      authorType: 'agent', authorID: 'a', authorDisplayName: 'A',
    }),
  ];
  parent[0].parentID = 'f-self';
  parent[1].parentID = 'f-b';
  parent[2].parentID = 'f-a';

  let plan = fork(parent);

  // Flat selection: exactly the input length, once each, no walk.
  assert.equal(plan.inheritedCount, 3);
  assert.equal(plan.seedFrames.length, parent.length);
  // And the cycle is not reproduced in the child's namespace.
  for (let frame of plan.seedFrames)
    assert.equal(frame.parentID, null);
});

// ---------------------------------------------------------------------------
// 7. Call-site seam: the child's own next frame starts a fresh parent chain.
// ---------------------------------------------------------------------------

test('the child next frame must not parent-link into inherited frames', async () => {
  // Prove the seam against the REAL frame writer used by session tools
  // (session-tools.mjs:264-270 calls it with `runtime` + `sessionID`). The
  // handoff message a coordinator posts into a child becomes an AgentMessage
  // whose parentID must be null, so the child's stream never links back into
  // the copied (inherited) conversation.
  let plan = fork(compactedParent());

  let engine = engineFor(plan.seedFrames);
  let posted = await postAgentSessionMessage({
    runtime: runtimeFor(engine, CHILD_ID),
    context: { agent: { id: 'agent-zav', name: 'Zav' } },
    sessionID: CHILD_ID,
    text: 'CHILD-HANDOFF: continue the fork planner work.',
  });

  let childFrames = projectFrameMessages(engine.toArray());
  let childOwn = childFrames.find((frame) => frame.id === posted.frame.id);
  assert.ok(childOwn, 'the handoff frame must be written into the child');
  assert.equal(childOwn.sessionID, CHILD_ID);
  assert.equal(childOwn.parentID, null);

  // Inherited frames are still there, still unlinked, and nothing in the child's
  // stream parent-links at all.
  assert.equal(childFrames.length, plan.seedFrames.length + 1);
  assert.equal(childFrames.filter((frame) => frame.parentID !== null).length, 0);
  assert.equal(childFrames.filter((frame) => frame.sessionID !== CHILD_ID).length, 0);
});

test('selectForkFrames reports what it did', () => {
  let parent = uncompactedParent();
  let selection = selectForkFrames(parent);

  assert.equal(selection.reason, FORK_REASON.COPY);
  assert.equal(selection.sourceCompactionFrame, null);
  assert.equal(selection.droppedFrameCount, 0);
  assert.equal(selection.frames.length, parent.length);

  // With a compacted parent under copy-through, the boundary is reported but
  // nothing is dropped.
  let compacted = selectForkFrames(compactedParent());
  assert.equal(compacted.sourceCompactionFrame.id, 'cmp-1');
  assert.equal(compacted.droppedFrameCount, 0);
  assert.equal(compacted.frames.length, compactedParent().length);
});

test('the child context reads as inherited context then the child own frames', async () => {
  // The owner's goal stated as an assertion: "the parent's context at the moment
  // of creation + the child session frames". Two things must hold together, and
  // neither is implied by the tests above:
  //
  //   1. the seed sorts BEFORE every frame the child writes itself, and
  //   2. the parent's clamped context appears in the child unchanged.
  //
  // (1) depends on an engine invariant rather than on my code: FrameEngine folds
  // its watermark to the highest hydrated order (frame-engine.mjs:186) and stamps
  // new frames with `++this._frameOrder` (:255), so a child frame written with no
  // explicit order necessarily lands after the seed. That is exactly why
  // planSessionFork preserves the parent's `order` instead of renumbering it.
  let parent = [];
  for (let order = 1; order <= 8; order++)
    parent.push(userFrame({ id: `f-${order}`, order, text: `parent turn ${order}` }));
  parent.push(compactionFrame({ id: 'cmp-e2e', order: 9, boundaryOrder: 8, summary: 'Compacted parent turns 1-8.' }));

  let plan = fork(parent);

  let engine = engineFor(plan.seedFrames);
  // The watermark must be the highest inherited order, not a reset one.
  assert.equal(engine._frameOrder, 9);

  let posted = await postAgentSessionMessage({
    runtime: runtimeFor(engine, CHILD_ID),
    context: { agent: { id: 'agent-zav', name: 'Zav' } },
    sessionID: CHILD_ID,
    text: 'CHILD HANDOFF: take over the fork planner work.',
  });

  let context = readContext(engine.toArray());

  // Inherited boundary first, the child's own handoff last. The reader clamps at
  // order 8, so the pre-boundary turns are not in the PROMPT even though they are
  // inherited into the child's storage — that is the clamp happening at read
  // time, exactly as for the parent.
  assert.equal(context.length, 2);
  assert.match(projectTurns([ context[0] ])[0].content, /Compacted parent turns 1-8\./);
  assert.equal(context[1].id, posted.frame.id);
  assert.match(projectTurns([ context[1] ])[0].content, /CHILD HANDOFF/);

  // Ordering: inherited order < child order, strictly.
  assert.ok(context[0].order < context[1].order);

  // The child's stored stream still holds the whole inherited history (copy-
  // through), and all of it is in the child's namespace.
  assert.equal(engine.toArray().length, parent.length + 1);
  assert.equal(engine.toArray().filter((f) => f.sessionID !== CHILD_ID).length, 0);
});

// ---------------------------------------------------------------------------
// 8. overflowPolicy — the named switch, and what each setting promises.
// ---------------------------------------------------------------------------

test("opt-in 'clamp' seeds from the boundary and reports what it dropped", () => {
  let parent = compactedParent(); // 10 stored frames, boundary at order 6
  let plan = fork(parent, { overflowPolicy: OVERFLOW_POLICY.CLAMP });

  assert.equal(plan.reason, FORK_REASON.COMPACTION_BOUNDARY);
  assert.equal(plan.sourceCompactionFrameID, 'cmp-1');

  // First seeded frame is the boundary compaction itself, under a NEW id.
  assert.notEqual(plan.seedFrames[0].id, 'cmp-1');
  assert.equal(plan.seedFrames[0].type, COMPACTION_FRAME_TYPE);
  assert.equal(plan.seedFrames[0].compaction.boundaryOrder, 6);

  // Only the post-boundary tail follows it: orders 8, 9, 10.
  assert.deepEqual(plan.seedFrames.slice(1).map((f) => f.order), [ 8, 9, 10 ]);

  // Nothing silently vanishes: inherited + dropped accounts for the whole input.
  assert.equal(plan.inheritedCount + plan.droppedFrameCount, parent.length);
  assert.equal(plan.droppedFrameCount, 6);
  assert.equal(plan.inheritedCount, 4);

  // Anti-vacuity: those pre-boundary frames really are absent.
  let seededText = JSON.stringify(projectTurns(plan.seedFrames));
  assert.equal(seededText.includes('part one'), false);
});

test("opt-in 'clamp' keeps exactly one compaction frame", () => {
  let parent = [
    ...compactedParent(),
    compactionFrame({ id: 'cmp-0', order: 0, boundaryOrder: 3, summary: 'Ancient summary.' }),
  ];

  let plan = fork(parent, { overflowPolicy: OVERFLOW_POLICY.CLAMP });
  let compactionFrames = plan.seedFrames.filter((f) => f.type === COMPACTION_FRAME_TYPE);
  assert.equal(compactionFrames.length, 1);
  // The newest boundary wins (boundaryOrder 6), not the old one (3).
  assert.equal(compactionFrames[0].compaction.boundaryOrder, 6);
  assert.equal(JSON.stringify(projectTurns(plan.seedFrames)).includes('Ancient summary.'), false);
});

test('an in-flight compaction is not used as the boundary', () => {
  let parent = [
    ...uncompactedParent(),
    compactionFrame({ id: 'cmp-run', order: 7, boundaryOrder: 6, status: 'running', summary: 'in flight' }),
  ];

  let plan = fork(parent, { overflowPolicy: OVERFLOW_POLICY.CLAMP });

  // No usable boundary => nothing is clamped, nothing is dropped.
  assert.equal(plan.reason, FORK_REASON.NO_COMPACTION);
  assert.equal(plan.droppedFrameCount, 0);
  assert.equal(plan.inheritedCount, parent.length);
  assert.equal(plan.sourceCompactionFrameID, null);
});

test("overflowPolicy 'summarize' refuses rather than silently falling back", () => {
  // A fork-time summarising compaction is not built. A silent fallback would
  // hide an oversized prompt, so this must throw — under the default policy too,
  // because the caller asked for something we did not do.
  assert.throws(
    () => fork(compactedParent(), { overflowPolicy: OVERFLOW_POLICY.SUMMARIZE }),
    { name: 'ForkPolicyNotImplementedError', policy: OVERFLOW_POLICY.SUMMARIZE },
  );
  assert.throws(
    () => selectForkFrames(uncompactedParent(), { overflowPolicy: OVERFLOW_POLICY.SUMMARIZE }),
    { name: 'ForkPolicyNotImplementedError' },
  );
});

test('an unrecognised overflowPolicy is a loud TypeError, not a default', () => {
  assert.throws(
    () => fork(uncompactedParent(), { overflowPolicy: 'cpy' }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// 9. Which compaction status is authoritative, and the absent-finder guard.
// ---------------------------------------------------------------------------

test('content.status is the authoritative in-flight signal, as in the shared rule', () => {
  // The shared finder (agent-brief-state.mjs:51-52) and the context builder
  // (frame-context-builder.mjs:246-248) both read `content.status`. A frame whose
  // `compaction.status` disagrees must follow `content.status`.
  let parent = [
    ...uncompactedParent(),
    compactionFrame({ id: 'cmp-x', order: 7, boundaryOrder: 6, status: 'complete', summary: 'done' }),
  ];
  parent[parent.length - 1].compaction.status = 'running';

  let plan = fork(parent, { overflowPolicy: OVERFLOW_POLICY.CLAMP });
  assert.equal(plan.reason, FORK_REASON.COMPACTION_BOUNDARY);
  assert.equal(plan.sourceCompactionFrameID, 'cmp-x');

  // ...and the inverse: content.status says in-flight, compaction.status says done.
  let inverse = [
    ...uncompactedParent(),
    compactionFrame({ id: 'cmp-y', order: 7, boundaryOrder: 6, status: 'running', summary: 'busy' }),
  ];
  inverse[inverse.length - 1].compaction.status = 'complete';

  let inversePlan = fork(inverse, { overflowPolicy: OVERFLOW_POLICY.CLAMP });
  assert.equal(inversePlan.reason, FORK_REASON.NO_COMPACTION);
  assert.equal(inversePlan.sourceCompactionFrameID, null);
});

test('a finder result that is absent from parentFrames is refused, not followed', () => {
  // latestCompactionFrame can fall back to context.contextMemory.latestCompaction
  // (agent-brief-state.mjs:63), which need not be a member of `frames`. A
  // boundary we cannot COPY is a boundary we cannot clamp to, so the clamp
  // policy must refuse it rather than emit a seed whose first frame it never saw.
  let parent = uncompactedParent();
  let absent = compactionFrame({ id: 'cmp-elsewhere', order: 99, boundaryOrder: 3, summary: 'not in this frame list' });

  let selection = selectForkFrames(parent, {
    overflowPolicy: OVERFLOW_POLICY.CLAMP,
    findLatestCompaction: () => absent,
  });

  assert.equal(selection.reason, FORK_REASON.NO_COMPACTION);
  assert.equal(selection.sourceCompactionFrame, null);
  assert.equal(selection.droppedFrameCount, 0);
  assert.equal(selection.frames.length, parent.length);

  // Anti-vacuity: the SAME finder result is accepted once the frame really is in
  // the parent list, so this test would notice if the guard never ran at all.
  let present = selectForkFrames([ ...parent, absent ], {
    overflowPolicy: OVERFLOW_POLICY.CLAMP,
    findLatestCompaction: () => absent,
  });
  assert.equal(present.reason, FORK_REASON.COMPACTION_BOUNDARY);
  assert.equal(present.sourceCompactionFrame.id, 'cmp-elsewhere');
});

// ---------------------------------------------------------------------------
// 10. groupID stripping is projection-neutral (pins a measured claim).
// ---------------------------------------------------------------------------

test('stripping groupID does not change the projection', () => {
  // rehomeForkFrame clears groupID/groupType. That is safe BECAUSE the projection
  // never reads them: `normalizeLiveFrame` substitutes a phantom frame's id with
  // its groupID (frame-manager.mjs:396-397), but only from `upsertFrameArray`
  // (:185), which projectFrameMessages does not traverse. Pin it, so that
  // clearing groupID cannot silently become a cache break later.
  let frames = [
    userFrame({ id: 'u1', order: 1, text: 'hello' }),
    withCommonFields({ content: { text: 'phantom text', status: 'complete' }, groupID: 'grp-7', phantom: true }, {
      id: 'ph1', type: 'AgentMessage', sessionID: PARENT_ID, order: 2,
      authorType: 'agent', authorID: 'agent-zav', authorDisplayName: 'Zav',
    }),
    agentFrame({ id: 'am1', order: 3, text: 'real' }),
  ];

  let plan = fork(frames);
  assert.equal(plan.seedFrames[1].groupID, null, 'groupID is cleared in the child');

  assert.deepEqual(
    projectTurns(projectFrameMessages(engineFor(plan.seedFrames).toArray())),
    projectTurns(projectFrameMessages(frames)),
  );
});
