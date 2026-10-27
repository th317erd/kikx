# Child-session context memory: fork, fresh, or primed?

> **STATUS: DECIDED — child sessions are FORKS.** The owner ruled on 2026-10-26.
> This document began as an investigation into what happened *before* the feature,
> when a child session inherited nothing. Sections 1–9 record that measured
> behaviour and remain accurate as a description of the pre-fork system.
> **What changed is the policy, not the measurements.** The fork feature is
> specified in §10–§15. Read §10 first: it states the ruling and explicitly
> voids the recommendation this document originally made.

Measured against HEAD `e7b1739` (working tree dirty; see §9).
Pre-fork proof: `child-session-context-spec.mjs` in this directory
(`node --test 'spec/core/context/child-session-context-spec.mjs'`, 4/4 pass,
exit 0). That spec pins pre-fork fresh-child behaviour and is retained as the
regression guard for `fresh-context:true`.

---

## 1. Why "fork" even looks plausible — and why it is not (as of HEAD `e7b1739`)

> **Superseded as a recommendation.** The reasoning below is correct about what the
> code did before the feature: lineage was administrative, not mnemonic, and nothing
> copied frames. That is why a fork had to be *built* rather than merely switched on.
> It is **not** an argument against the feature — see §10.

A child session carries real lineage:

- `src/core/tools/session-tools.mjs:251-259` — `createSession({ ..., parentSessionID: sourceSession?.id || null, generation: sessionGeneration(sourceSession) + 1 })`
- `src/core/plugins/agent-normalizers.mjs:138-147` — `sessionGeneration()` returns `session.generation`, falling back to `1` when `parentSessionID` is set.
- Brief A tells the child it is delegated: `src/core/plugins/agent-brief-template.mjs:234-241` (`buildDelegationBriefLines`, keyed off `generation > 0`).

That lineage is **administrative, not mnemonic**. `parentSessionID` is consumed
only by ownership, scope, dedupe, tree-halt and preference-inheritance code:

| File | Use |
| --- | --- |
| `src/core/ownership/session-ownership.mjs:82,152,203,240` | authority chain |
| `src/core/agents/session-subtree.mjs:20-44` | tree enumeration |
| `src/core/agents/coordinator-scope.mjs:75-79,156` | scope |
| `src/core/agents/coordinator-tree-halt.mjs:62,112,135` | halt propagation |
| `src/core/questions/question-dedupe.mjs:132` | question dedupe |
| `src/core/preferences/session-preferences.mjs:44`, `src/shared/session-preferences.mjs:127` | preference lookup |

**None of these are on the model-context assembly path.** Grep for `parent` in
`src/core/agents/agent-route-frame-plugin.mjs` returns **zero matches**.

Frames are additionally *physically* partitioned by session:

- `src/core/aeordb/frame-store-paths.mjs:34` — `/sessions/<sessionID>/interactions/<interactionID>/frames/<order>-<type>-<id>.json`

A fork would therefore require copying frame files across session directories.
No code does that.

## 2. What the child's model sees on its first turn, in order

Assembly is `src/core/plugins/agent-model-context.mjs:69-138`:

| # | Message | Source |
| --- | --- | --- |
| 0 | `{ role: 'system' }` — stable authority/invariants/communication contract | `agent-model-context.mjs:84` |
| 1..n | history: one turn per projected **child** frame, trigger frame skipped | `agent-model-context.mjs:102-113`; history passed in from `agent-route-frame-plugin.mjs:262-263` |
| last | `{ role: 'user' }` — **Brief B**, whose *first line* is the raw trigger text, with **Brief A** appended after a blank line when `shouldSendStartBrief()` says so | `agent-model-context.mjs:124-135`; `agent-brief-template.mjs:174-208` |

Note the ordering subtlety versus the brief: Brief A is **not** a separate
message and does **not** precede history. It is embedded *inside* the final user
turn, after the raw message text, deliberately — to keep the history prefix
byte-identical for provider prompt caching (`agent-model-context.mjs:74-83`).

First turn for a child created with `initialMessage` (measured, see §6):

```
message count = 2
  [0] role=system  chars=4060  "You are an agent participating in a Kikx session..."
  [1] role=user    chars=6817  "CHILD-HANDOFF-8c1d02ab do the delegated thing"
```

The child's projected history is exactly **1** frame, of type `AgentMessage` —
its own handoff. Zero frames inherited.

## 3. The single priming channel

`src/core/tools/session-tools.mjs:261-272`:

```js
let initialMessage = normalizeOptionalString(params.initialMessage);
let initialFrame = null;
if (initialMessage) {
  let posted = await postAgentSessionMessage({ ... sessionID: session.id, text: initialMessage });
  initialFrame = posted.frame;
  session = posted.session || session;
}
```

Mechanism (`src/core/tools/session-tool-helpers.mjs:29-71`): one `AgentMessage`
frame, `authorType: 'agent'`, `authorID` = the **creating** agent, one
`interactionID`. It sets `content.sourceSessionID`/`sourceFrameID`
(`session-tool-helpers.mjs:48-49`) — **but that metadata is never projected into
the model prompt**: `grep sourceSessionID src/core/frames/` returns nothing, and
`FrameTypeAgentMessage.buildAgentTurn`
(`src/core/frames/frame-types/frame-type-agent-message.mjs:6-20`) emits only the
text, wrapped in `<agent-message source=… display-name=…>`. So even the one
primed frame carries **no parent session id**.

**What the handoff actually carries: exactly the characters the coordinator
typed, and nothing more.**

## 4. Brief A and Brief B — do they carry parent information?

`src/core/plugins/agent-brief-template.mjs` (exported through the 210-byte shim
`agent-script-template.mjs`).

### Brief A — `buildStartBrief` (`:106-158`), sent once per (re)start

Decided by `shouldSendStartBrief` (`src/core/plugins/agent-brief-state.mjs:129-158`):
first message, new agent, compaction boundary advance, coordinator change, or
party change. Marker is an in-process `WeakMap` (`agent-brief-state.mjs:107`), so
a process restart re-sends it.

Contents: harness version banner, `PRE_START_READ_LINES`, character
(compressed), AGIS precepts, the static tool map, tool notes, behavior lines,
and `buildDelegationBriefLines` (child form at `:234-241`). Plus
`COORDINATOR_PREAMBLE_LINES` when the agent is coordinator with parties.

**Parent-session leakage: none.** No parent title, goal, id, or frames. The only
parent-adjacent text is the constant delegation rule in
`agent-precepts.mjs:97` (`project/task name, cwd, parent goal, …`) — that is
*instruction to the parent*, not inherited data. The child is told it is
delegated; it is never told what it was delegated *from*.

### Brief B — `buildMessageBrief` (`:174-208`), every turn and every tool round

Order: raw message text → Brief A (if sent this turn) → `Turn context — from
<sender> <timestamp>` → `todo:` / `open:` / `cwd:` / `coord:` / `parties:` →
autonomous-run line → coordinator nudge → suspension warning → compaction
warning → turn-ending contract (`TURN_ENDING_LINES`, `:85-96`).

`parties:` is `formatBriefPartyLines` (`:262-279`) over
`collectPartyActors(context)` — i.e. the **child's own** participants, resolved
from `context.session.participantAgentIDs`, not the parent's.

**Parent-session leakage: none.**

## 5. Is the absence of automatic primed context a defect? (pre-fork framing)

> **Historical.** This answered a question about the pre-fork system. With §10
> adopted, the priming question is settled by copying frames instead. The finding
> that survives unchanged is §8: `initialMessage` is unvalidated and optional.

**Judgement: the behaviour is correct by design; the *undocumented and
unvalidated* contract around `initialMessage` is a real MINOR defect.**

Evidence that no auto-summary path exists:

- `compaction-service.mjs` contains **zero** occurrences of `parentSession`,
  `parentID`, or a bare `parent`. `prepareAgentContext`
  (`compaction-service.mjs:75-132`) derives frames from
  `input.frameEngine.toArray()` (`:77`) — the single session's engine — and every
  compaction frame it writes lands in that same session. Compaction summaries are
  per-session, full stop.
- `agent-context-budget.mjs` is a pure leaf module: token estimation,
  `budgetForModel`, `fitMessagesToBudget`. It has no session, frame-store, or
  ancestry access at all. It cannot inject anything.
- The one path that *replaces* the history array,
  `agent-route-frame-plugin.mjs:265-280` (`compactionService.prepareAgentContext`
  overwriting `sessionFrames`), still receives `this.context.engine` — same
  session.

So: nothing auto-summarises the parent into the child. A delegated child depends
entirely on the parent typing a good handoff.

Why that is defensible: priming from the parent would require choosing *which
part* of an arbitrarily large parent history matters — exactly the judgement the
delegating coordinator is making when it writes the brief. Silently injecting a
parent summary would also undermine the isolation that lets a child be re-run,
reused (`session-tools.mjs:233-247`, `reuseExisting` defaults to **true**), or
audited independently. And the child is not context-free: Brief A always supplies
harness contract, character, tool map and turn protocol — it is
*session-content*-free, not clueless.

## 6. Empirical proof

`child-session-context-spec.mjs`, run with `node --test`. It drives a **real**
`FrameRuntime` (fake in-memory AeorDB client, the same idiom as
`spec/core/frame-runtime-spec.mjs`), creates a genuine parent and child via the
same `createSession` call the tool makes, posts the handoff through the real
`postAgentSessionMessage`, then assembles the message list exactly as the route
plugin does and calls the real `buildModelMessages`.

Measured output:

```
parent frames on disk    = 1
child.parentSessionID    = ses_parent
child.generation         = 1
child frames on disk     = 1
child projected frames   = 1
child frame types        = AgentMessage
message count            = 2
contains parent marker   = false
contains parent id       = false
contains parent title    = false
contains child handoff   = true
```

Anti-vacuity controls:

1. A positive control asserts the parent marker **is** visible through the same
   harness (`projected.length === 1`, marker matched) — so a harness that loaded
   nothing could not pass.
2. A mutation check prepends the parent's frames (simulating a fork): message
   count goes 2 → 3 and the marker becomes visible. The assertions are therefore
   load-bearing: had the implementation forked, they would fire.
3. A 12-frame parent variant proves the result is not an artefact of a trivially
   small parent.
4. A no-`initialMessage` variant asserts the child still receives Brief A
   (`/Kikx Advanced Agent Harness/`, `/delegated child session/`) with exactly
   2 messages and an empty history.

## 7. Live corroboration (this session)

This document was written from inside a real delegated child session
(`c3e26d0c…`, `generation: 1`, `parentSessionID: cb551b14…`,
`messageCount: 54`). Its first frame is an `AgentMessage` authored by the
coordinator `Zav`, carrying `sourceSessionID`/`sourceFrameID` metadata — and
`session-frames` shows the session contains **no parent frames at all**, while
the same session later accumulated 54 frames of its own work. That is the
mechanism described above, observed end to end rather than inferred.

## 8. The defect that is worth filing

`session-create`'s `initialMessage` is the *entire* orientation mechanism for a
delegated child, yet:

- the schema marks it optional — `session-tools.mjs:203-206`;
- `_execute` silently does nothing when it is absent or blank —
  `session-tools.mjs:261-263`;
- nothing warns, validates, or substitutes a default.

Result: a coordinator that omits it produces a child whose first turn is
`system + Brief B` with **zero** session content — the child is told it is a
delegated session but not what to do. Confirmed by the fourth proof test.

The text that would prevent this is advisory only (`session-tools.mjs:214`, the
`help` string, and `agent-precepts.mjs:96`), which is exactly the class of
"documentation is the only guard" failure that a spec can catch and a
well-meaning refactor cannot.

Severity: **MINOR** — it degrades delegation quality, cannot corrupt state, and
is recoverable by messaging the child afterwards.

## 9. Citation stability under the concurrent dirty tree

The working tree had 24 modified `src/` files from five other teams while this
was written. Every citation above was verified against both the working tree and
`git show HEAD:<path>` where the file was dirty. The one file on my read path
that other teams touched is `src/core/plugins/agent-normalizers.mjs`; its diff
rewrites `normalizeCoordinatorAgentID` only, and `sessionGeneration` (`:138-147`)
is byte-identical at HEAD and in the tree. The remaining read-path files
(`agent-model-context.mjs`, `agent-route-frame-plugin.mjs`,
`compaction-service.mjs`, `session-tools.mjs`, `agent-brief-template.mjs`,
`agent-brief-state.mjs`, `agent-context-budget.mjs`) are unmodified.

## 10. Fork decision (owner ruling)

**Decided 2026-10-26. This is the accepted design, not a proposal.**

A child session's frame stream **begins with a copy of the parent's frames as they
exist at the moment of creation**, followed by the child's own frames. There is no
clamp at fork time and no fork-time compaction.

The window cost is accepted deliberately, and can be large: copying a parent that
has not compacted can consume up to roughly 70% of the child's window at birth.
That cost is paid in exchange for:

1. **Zero fork latency** — nothing is summarised, so creation is a copy, not an
   inference call.
2. **Provider cache hits on the shared prefix** — the child's first request begins
   with the same bytes the parent just sent.
3. **Immediate up-to-speed** — the child starts with everything the parent knew.

Owner's words: *"You allow and accept the 70% window consumption, and compact when
it is convenient, hit cache more often in the meantime, and have zero delay to
fork."*

A creation flag `fresh-context: true|false` selects between this and the pre-fork
behaviour. `fresh-context: true` is exactly today's behaviour (empty engine,
nothing inherited) and is the compatibility path.

If the window cost ever becomes a real problem, the owner's sanctioned alternatives
are, in order:

- **Invite the agent into the same session** so memories are literally shared,
  rather than copied. No copy cost, no divergence, no fork at all.
- **Pre-compact to an "initialization frame"** that *is* a `CompactionFrame` — i.e.
  produce the summary deliberately before forking, not as part of forking.

### 10.1 Superseded: the clamp-at-fork recommendation

**An earlier draft of this document recommended clamping the child's seed to the
parent's most recent compaction boundary at fork time.** The reasoning was that it
bounds the child's window and reuses the exact frame set the parent's own prompt was
built from. **That recommendation was considered and rejected by the owner.**

It is recorded here on purpose, so a future reader does not re-propose it as a novel
idea. Do not re-introduce fork-time clamping:

- It was rejected for the reasons in §10 — clamps trade the three properties above
  for a window bound the owner does not want at creation time.
- Compaction is the *right* place to bound the window, and the child does that
  itself, later, when it is convenient (§13).
- A clamp at fork is a second windowing rule, which §11.2 forbids.

## 11. Division of labour: COPY at fork, CLAMP at read

These are two different operations at two different times. Conflating them is the
single most likely implementation error.

### 11.1 The fork COPIES

The fork copies the parent's frames **as they are stored**. It does not filter them,
summarise them, or trim them to a boundary. Whatever the parent's storage contains is
what the child's storage begins with.

### 11.2 `FrameContextBuilder` CLAMPS, at read time, on every request

There is exactly **one windowing rule** in the system, and it lives in the builder:

- `src/core/compaction/frame-context-builder.mjs:14` — `class FrameContextBuilder`
- `:29` — `build(frames, options)`, called per request
- `:50` — `findLatestBoundaryCompaction(allFrames)`
- `:51` — `buildContextFramesAfterCompaction(allFrames, latestCompaction)`
- `:165-183` — the clamp itself: if a boundary exists, the result is
  `[latestCompaction, ...frames after boundaryOrder]`, with deleted, hidden,
  non-boundary compaction frames, and anything at or before the boundary dropped.

**A forked child therefore clamps automatically**, on its first turn, using its own
builder and its own model's window. A parent that had already compacted contributes
its `CompactionFrame` plus its post-boundary tail — the clamp is inherited as *data*,
not as a policy the fork has to remember.

**Contract:** the fork must not pre-clamp. If a fork filters frames, the child
effectively compacts twice: the copied stream no longer matches what the parent sent,
the prefix cache is lost, and the child's history has a hole the parent never had.

## 12. Two things called "context" — keep them apart

These share a word and nothing else. They must never be conflated.

| | Session `context` JSONB | Frame stream (conversation history) |
| --- | --- | --- |
| What it is | a config document stored on the session row (`context` column, TEXT/JSON) | the ordered frames in the session's own directory |
| Shape | small, keyed settings | unbounded, append-only |
| Inheritance | **yes** — child overrides win, resolved through the parent chain | **no** — a child's engine starts empty; only a fork copies frames |
| Consumed by | feature config, not the model prompt | the model prompt, via the builder |
| Source of the word | `old-app/bot-docs/future-plans/agent-memory-context.yaml:21-25` | this document, §1–§9 |

### 12.1 Correction to an earlier reading

`agent-memory-context.yaml:25` says *"child sessions inherit parent context (child
overrides win)"*. **That sentence is about the session `context` JSONB field
(`getEffectiveContext()`), not about frames.** An earlier draft of this document —
and an earlier instruction from the coordinator — read it as evidence that frames
were inherited. **That reading was wrong and is corrected here.** The YAML describes
inheritance of a small config document; it says nothing about conversation history.

## 13. Compaction: how it works, and why the child becomes self-sufficient

Today, per `docs/context-compaction.md:26-44` and
`src/core/compaction/compaction-service.mjs`:

- Triggers in the background when context usage crosses the configured ratio; routing
  continues on the current context meanwhile (`docs/context-compaction.md:26`).
- Reads the session's frames from its own engine (`compaction-service.mjs:76-77`,
  `input.frameEngine.toArray()`, falling back to `input.frames`) and lets
  `FrameContextBuilder` decide what the agent sees and which window to compact
  (`frame-context-builder.mjs:29-51`).
- Writes a `CompactionFrame` into the **same** session (`compaction-service.mjs`,
  frame written with `content.status` moving `running` -> `complete`,
  `docs/context-compaction.md:44`).
- Agent memory then starts at the most recent completed `CompactionFrame`
  (`docs/context-compaction.md:30`, implemented at `frame-context-builder.mjs:165-183`).

**Does a forked child inherit the parent's compaction frame correctly, or re-derive?**
**It inherits it.** The child's builder finds the copied `CompactionFrame` in the
child's own frame set and clamps to it exactly as the parent did. No re-derivation, no
second summary call. Two conditions follow from the code:

- **Copy `order`, `hidden`, `deleted` and `compaction.boundaryOrder` verbatim.** The
  clamp compares `frame.order` against `compactionBoundaryOrder(latestCompaction)`
  (`frame-context-builder.mjs:167`; `agent-brief-state.mjs:31`). If orders are
  renumbered, the boundary points at the wrong place and the child either loses
  history or keeps frames it should have dropped. Preserving `createdClock`,
  `createdAt` and `order` also keeps the copied prefix byte-identical, which is the
  whole cache argument (§10).
- **Copy the `CompactionFrame` itself, not just its tail.** A tail without its
  boundary frame is a conversation with no beginning.

The compaction frame's `sessionID` is parent-scoped and that is **harmless**: the
projection never reads `frame.sessionID`, rendering purely from `content.summaryJSON`
/ `content.summary` and the level filter.

**Self-sufficiency confirmed.** Nothing in the start path requires the session to be
a root or the parent to still exist: `startCompaction` needs only a session id, a
boundary frame id and an engine (`compaction-service.mjs:188-192`), and
`compaction-service.mjs` contains **zero** occurrences of `parentSession`, `parentID`
or a bare `parent`. Once the child writes its own `CompactionFrame` it is entirely
independent — the owner's claim holds.

## 14. Supporting plan documents

These are the design context the ruling sits in. Verified present at HEAD `e7b1739`.

- **`old-app/bot-docs/future-plans/agent-deliberation.yaml`** — status `COMPLETE
  (implemented 2026-03-11)` (`:2`). *"No orchestrator, no state machine — just a
  regular session"* (`:10`). `initialMessage` is the approved priming mechanism
  (`:104-106`). This is the origin of the current child-session shape: delegation is
  ordinary session creation, not a special orchestration mode.
- **`bot-docs/plans/session-work-area.md` §14** (`:237-245`) — sub-sessions are a
  **normal message type** in the chat stream; the parent renders a card where it
  spawned the child and clicking enters it. One view, one filter; hiding sub-sessions
  collapses the parent to a grid. There is **no junction marker** — no in-stream
  "context starts here" divider to design around.
- **`bot-docs/plans/session-history-lazy-loading.md`** — status IMPLEMENTED. The
  client pages newest-first via `GET /api/v1/sessions/:id/frames?limit=N&before=<order>`
  (`:35-37`) and *"never load[s] the whole session"* (`:17`). Crucially, the window
  path *"deliberately bypasses engine hydration"* (`:11`) — so a large session is
  cheap to **view**. Consequence for this feature: infinite scrollback inside a child
  is unnecessary, and the fork's copy cost is a *prompt* cost, not a *rendering* cost.
  The history pane will not get slower because the child inherited 2MB of frames.
- **`docs/context-compaction.md`** — agent memory already starts at the most recent
  completed `CompactionFrame` (`:30`), and `/compact` already exists to force a
  checkpoint deliberately (`:42-44`). So the machinery for the owner's
  "initialization frame" alternative (§10) is already built; it needs a caller, not
  new compaction logic.

## 15. UNVERIFIED: session-context inheritance through the parent chain

**Do not claim this works.** This is an open question handed over as-is.

`agent-deliberation.yaml:69-70` records that `SessionManager` gained
`getAncestryChain(sessionID)` and `getNearestUserAncestor(sessionID)`, bulk-loading
via a recursive query, as implemented in 2026-03. **Neither function exists under
those names in the current tree:**

```
grep -rn "getAncestryChain|getNearestUserAncestor" src spec   ->  0 hits
```

Likewise the YAML's `getEffectiveContext()` (`agent-memory-context.yaml:23`) has
**zero hits** anywhere in `src/` or `spec/`.

Ancestry walking clearly still happens — but under different names and in
different modules: `coordinator-scope.mjs:166` (`ancestorSessionIDs`),
`session-preferences.mjs:12-14` ("load a session and all of its ancestors"),
`frame-runtime.mjs:231-233`. So the *capability* survived a refactor; the specific
`context`-JSONB inheritance surface may or may not be wired to it today.

**Status: unverified, and not to be assumed.** Two distinct possibilities, and this
document does not choose between them:

1. It was renamed/reworked and still works — then document the new entry point.
2. It was dropped in a refactor and is genuinely gone — then §12's "inheritance: yes"
   row is wrong for the current tree, and **that is a separate defect worth filing**
   independently of the fork work.

The honest phrasing for anyone citing this: *session `context` is **documented** to
inherit through the parent chain; whether it does in the current tree was not
established here.* Nothing in the fork feature depends on the answer, because frames
are copied and not inherited.

## 16. Contract summary for the implementation

1. Fork **copies** the parent's frames as stored, at creation. No clamp, no
   summarise, no filter (`fresh-context: false`).
2. `fresh-context: true` inherits nothing — today's behaviour, preserved exactly.
3. Preserve `order`, `createdClock`, `createdAt`, `hidden`, `deleted`, and
   `compaction` on every copied frame (§13).
4. Copy `CompactionFrame`s themselves, so the child's builder can find its boundary.
5. Never pre-clamp in the fork. `FrameContextBuilder` is the only windowing rule
   (`frame-context-builder.mjs:14`, `:29`, `:165-183`).
6. Do not rewrite `frame.sessionID` for projection reasons; it is not read.
7. Accepted cost: up to ~70% of the child's window at birth. Compact later, when
   convenient. Do not "fix" this at fork time.
8. Session `context` JSONB and frame history are different features (§12).
9. Session-context inheritance is **unverified** (§15).

### 16.1 Note on the default policy in `src/core/context/session-fork.mjs`

At the time this contract was written, the in-progress implementation defaulted to
`OVERFLOW_POLICY.CLAMP` ("seed from the newest compaction boundary") in both
`selectForkFrames()` and `planSessionFork()`, with `'all'` documented as *"kept
because it is the behaviour this feature replaces"*.

**That default is backwards relative to the ruling**, and the comment is misleading
in a way that will mislead the next reader: `'clamp'` is not the feature, it is the
rejected design (§10.1). Two things follow:

- The default for a `fresh-context: false` fork must be the unclamped copy, so that
  omitting the option produces the ruled behaviour rather than the rejected one.
- Once the unclamped copy is the default, the named-policy machinery has no
  remaining job — the ruling does not contain a policy switch. It is reasonable to
  delete `OVERFLOW_POLICY` / `ForkPolicyNotImplementedError` rather than keep a
  three-way switch whose middle value throws (`'summarize'`, deliberately not
  implemented, because fork-time compaction is exactly what §10 forbids).

This is a note for the implementer, not an edit. This document does not change
`src/`.
