# Fork seam — where `planSessionFork` connects to `session-create`

Status: checkpoint 2. `src/core/context/session-fork.mjs` is a pure planner; this
document specifies the single call site that makes it live. Written by the
context-fork engineer; `src/core/tools/session-tools.mjs` is **not** in that
engineer's write lane, so nothing below is applied — it is a request with an
executable proof.

Every claim here was measured or read in the source during this checkpoint.
Claims that turned out to be wrong in an earlier draft are marked **CORRECTED**
and say what the measurement showed.

## 0. Current state: the planner is connected to nothing

`planSessionFork` has no importer in `src/`. `session-create`'s `_execute`
(`session-tools.mjs:112-278`) never mentions it, and
`FrameRuntime.createSession` (`frame-runtime.mjs:79-146`) builds a brand-new
empty `FrameEngine` per session (`frame-runtime.mjs:112-116`) with no parameter
that accepts pre-formed frames. Today `freshContext:false` silently produces a
fresh session: the flag is inert until the seam below exists.

## 1. Recommended option: (b), append through the existing engine merge path

Two candidates were evaluated.

**(a) `FrameRuntime.createSession(input)` gains `seedFrames`.** Cleanest
conceptually — seeds exist before the first durable write
(`frame-runtime.mjs:120-125`), so no intermediate empty-session state is ever
observable. **Deferred on scheduling grounds alone:** `frame-runtime.mjs` and
`frame-runtime-sessions.mjs` are both ` M` in the working tree right now, owned
by a live coordinator-scope worker. Landing there now would race that writer.
This is a sequencing objection, not a technical one; revisit it once their work
settles.

**(b) `session-tools.mjs` creates the session, then seeds via
`entry.frameEngine.merge(...)`.** Recommended. `session-tools.mjs` is clean in
the working tree — it appears in neither the 16 modified nor the 17 untracked
paths — so it is the collision-free surface.

### 1.1 Option (b) is real, not fiction — the append path already exists

| Requirement | Evidence |
|---|---|
| A merge accepts fully-formed frames, with caller-supplied `id`/`type` | `frames/frame-engine.mjs:71` — `merge()` skips only entries lacking `id` or `type` |
| A supplied `order` is preserved, **not** renumbered | `frames/frame-engine.mjs:255` — `numberOr(input.order, existing?.order \|\| ++this._frameOrder)` |
| Merging advances the order watermark, so the child's next own frame cannot collide | **Measured:** seeds at orders 1-4 → child's next own frame took order 5 |
| Merging is durable | `frameStore.connect(...)` (`frame-runtime.mjs:606-611`) subscribes to `commit`; `saveCommit` → `saveFrame` → `aeordb.putFile` (`aeordb/frame-store-commit.mjs:180-210`) |
| The idiom is already in production | `session-tool-helpers.mjs:61-70`: `merge(...)` → `await runtime.frameStore?.flush?.()` → `runtime.syncSessionManifestFromEngine?.(entry, { frames: merged, persist: true })` |
| Re-hydration after restart preserves the watermark | **Measured:** `hydrate()` folds `_frameOrder` to the max stored order (`frames/frame-engine.mjs:188`); post-reload the child's next own frame took order 5, no collision |

All five merge facts and both measured behaviours were exercised against a real
`FrameRuntime` with an in-memory AeorDB fake, not inferred from reading.

### 1.2 **CORRECTED** — what "copy into the child namespace" actually means

An earlier draft, and a comment in `session-fork.mjs`, said frames are
"physically partitioned per session" and implied a directory copy. That is
wrong, and it has been fixed at `session-fork.mjs:40-50`.

Measured:

```
/home/wyatt/.local/share/kikx/kikx.aeordb   →  one 7.6 GB file (`file` says "data")
ls .../kikx.aeordb/sessions                 →  "Not a directory"
```

The store is a single database file. What is per-session is the **store key**,
not a directory. `framePath` (`aeordb/frame-store-paths.mjs:32-35`) returns

```
/sessions/<sessionID>/interactions/<interactionID>/frames/<order>-<type>-<id>.json
```

and `saveFrame` is `aeordb.putFile(this.framePath(sessionID, frame), ...)`
(`aeordb/frame-store-commit.mjs:198-206`). So the "copy" is **one `putFile` under
a key whose session segment names the child**. There is no directory to copy, no
`cp`, and no filesystem primitive to go looking for. A child's frames land at,
for example:

```
/kikx/sessions/<childID>/interactions/<childID>%3Ainherit%3A0%3A<parentFrameID>/frames/0000000000000001-UserMessage-<childID>%3Ainherit%3A0%3A<parentFrameID>.json
```

(observed in the fake store; same key shape the real store builds).

### 1.3 Two consequences that shape the seam

- **Persist-then-route fires.** The store's `onCommitted` callback drives the
  router (`frame-runtime.mjs:606-611`). Seeding via `merge` therefore enqueues
  routing for inherited frames exactly as if the child had authored them. The
  router receives `sessionID = child`, so nothing leaks into the parent stream,
  but the child may react to inherited content on turn one. That is intended —
  it is what "immediately up-to-speed" means — but it is a behavioural
  consequence, not a no-op. `merge()` accepts `{ silent: true }`, which
  `_createCommit` copies to `commit.silent` (`frames/frame-engine.mjs:412`) and
  which makes `FrameRouter.enqueueCommit` return without enqueuing
  (`routing/frame-router.mjs:53-57`). **Decision needed at the call site:** for a
  true "context, not conversation" seed, `silent: true` is the closer match. The
  recommendation in §2 uses it.
- **`commitOrder` is rewritten, symmetrically.** `_applyCommitOrder`
  unconditionally sets `frame.commitOrder = commitOrder`
  (`frames/frame-engine.mjs:435-447`, called at `:109`). **Measured:** parent
  frames supplied at commitOrders 9 and 2 persisted as 1 and 1; the forked child
  came out 1 and 1 too, and both projected in the same order. The rewrite is
  therefore harmless for the cache claim, but the planner's preservation of
  `commitOrder` is **not** what buys the cache hit. Recorded at
  `session-fork.mjs:63-75`.

## 2. Exact insertion point

`src/core/tools/session-tools.mjs`, in `session-create`'s `_execute`.

- `reuseExisting` early-return: `:234-250`
- `createSession(...)`: `:251-259`
- `initialMessage` read: `:261`
- `postAgentSessionMessage(...)`: `:262-272`

Insert **between** `:259` and `:261`.

```js
// after:  let session = await this.frameRuntime().createSession({ ... });   (:251-259)
// before: let initialMessage = normalizeOptionalString(params.initialMessage); (:261)

let runtime = this.frameRuntime();
let parentFrames = [];
if (sourceSession?.id && params.freshContext !== true) {
  let parentEntry = await runtime.ensureSessionEntry(sourceSession.id);
  parentFrames = parentEntry.frameEngine.toArray();
}

let plan = planSessionFork({
  parentFrames,
  childSessionID: session.id,
  parentSessionID: sourceSession?.id || null,
  freshContext: params.freshContext === true,
});

if (plan.seedFrames.length > 0) {
  let entry = await runtime.ensureSessionEntry(session.id);
  let merged = entry.frameEngine.merge(plan.seedFrames, {
    authorType: 'agent',
    authorID: createdByAgentID,
    silent: true,          // context, not conversation — see §1.3
  });
  await runtime.frameStore?.flush?.();
  runtime.syncSessionManifestFromEngine?.(entry, { frames: merged, persist: true });
  await runtime.frameStore?.flush?.();
}
```

New import, alongside the existing helper imports at the top of
`session-tools.mjs`:

```js
import { planSessionFork } from '../context/session-fork.mjs';
```

### 2.1 Ordering constraint that must not be violated

Seeding must run **before** `initialMessage` is read (`:261`). Two mechanical
reasons:

1. `postAgentSessionMessage` takes its own stamp and merges one frame
   (`session-tool-helpers.mjs:17-19`, `:61`). If it ran first it would claim the
   lowest order and the seed would land *after* the child's opening message,
   putting the parent's context behind the child's first turn.
2. The parent's frames must be read before the child has any frame of its own, so
   that the child's projected prefix is the parent's context and nothing else.

### 2.2 `messageCount` — named, as requested

A forked child's `messageCount` does **not** stay 0, provided the seam follows
the production idiom above.

- `createSession` initialises `messageCount` from `input.messageCount`
  (`frame-runtime.mjs:94`), defaulting to 0, so at birth the child reports 0.
- `merge()` emits `commit`, whose handler forwards to
  `syncSessionManifestFromEngine(entry, { frames, persist: true })`
  (`frame-runtime.mjs:585-586`).
- `syncSessionManifestFromEngine` sets
  `entry.session.messageCount = countMessageFrames(frames)` when it changed
  (`frame-runtime-sessions.mjs:655-676`).
- **Measured:** after merging 4 seed frames and flushing, the child's
  `session.messageCount` was 4 — matching the parent's 4 — and stayed 4 after a
  rehydrate from the store.

So the sidebar-consistency risk is real but **handled for free by the existing
commit listener**, as long as the seed goes through `merge()`. It would NOT be
handled by writing frames straight to the store with `putFile`, which bypasses
the `commit` event entirely. That is precisely why the seam must use `merge()`
and not a direct write.

## 3. Data shape crossing the seam

**Input — `parentFrames`:** the parent engine's raw frames, exactly
`entry.frameEngine.toArray()` (`frames/frame-engine.mjs:141`). Do **not**
pre-filter `hidden`/`deleted`: the child's own `FrameContextBuilder` applies
those filters at read time, and filtering twice risks dropping a frame the child
would keep.

**Output — `planSessionFork` returns:**

```js
{
  seedFrames,              // fully-formed frames: child sessionID, fresh id, parentID: null
  inheritedCount,          // seedFrames.length
  droppedFrameCount,       // 0 under the default copy policy
  sourceCompactionFrameID, // null unless overflowPolicy:'clamp' was opted into
  mode,                    // 'fork' | 'fresh'
  overflowPolicy,          // 'copy' by default
  reason,                  // FORK_REASON.*
  parentSessionID,
}
```

Each seed frame carries the child's `sessionID`, a fresh `id`, `parentID: null`,
and the parent frame's `order` **verbatim** (`session-fork.mjs:247-260`).
Preserving `order` is what keeps the child's own subsequent frames *after* the
seed: the engine folds its watermark to the highest order it has seen
(`frames/frame-engine.mjs:188`) and stamps new frames `++this._frameOrder`
(`:254`).

## 4. Tool schema must declare the flag — it is model-facing only

`session-create`'s parameter object sets `additionalProperties: false`
(`session-tools.mjs:108`), and `initialMessage` (`:203-206`) sits inside that
closed set. **`freshContext` is not declared anywhere.**

Correction to the assumed failure mode: `additionalProperties` is **not
enforced at runtime** in this codebase — there is no schema validation of tool
arguments anywhere in `src/core`
(`grep -rn "validateToolCall|validateArgs|validateSchema|ajv|jsonschema"` → no
matches), and `_execute` reads `params` directly (`session-tools.mjs:112`). So an
undeclared `freshContext` is not stripped; it is simply **invisible to the
model**, which will never emit a parameter its tool definition does not
advertise. Same practical outcome, different mechanism, same fix: declare it.

Add alongside `reuseExisting` (`session-tools.mjs:207-211`); `additionalProperties` closes the set at `:108`:

```js
freshContext: {
  type: 'boolean',
  description: 'Defaults to false: the child inherits the parent\'s frames as context, so it starts already up to speed and reuses the provider cache. Set true only for a short-lived child that should start empty (today\'s behaviour).',
},
```

and mention the choice in `static help` (`:214`).

## 5. Interaction with `reuseExisting` (a real trap)

`reuseExisting` defaults to reuse (`session-tools.mjs:235-250`), returning an
existing child and **skipping creation entirely** (`:244-249`). If a caller asks
for `freshContext:true` and receives a reused child, it gets one that may
already carry inherited frames — the flag silently does not apply.

Recommended: treat a mismatched reuse as a reason not to reuse, e.g.
`if (params.reuseExisting !== false && params.freshContext !== true)`, or at
minimum return `freshContext: null` (unknown) rather than implying it was
honoured.

## 6. The one-line test that proves the seam is live

The seam is proven live when a real `session-create` against a parent of N frames
yields a child whose engine holds N frames:

```js
assert.equal(childEntry.frameEngine.toArray().length, plan.inheritedCount);
```

with the same run under `freshContext: true` yielding `0`. The second half is
what makes the first non-vacuous — a planner that returned `[]` unconditionally
would satisfy the fresh case while failing the fork case. Both halves are
measured to work end to end today; only the wiring is missing.

## 7. The cache claim, measured

The justification for the whole feature is that the forked child's prompt shares
a byte-identical prefix with the parent's, so the provider cache hits.

**Measured**, with parent and child *both rehydrated from the store* so the
comparison is apples to apples:

- `frameToModelTurn` over each frame on both sides: **4 turns vs 4 turns,
  deep-equal and `JSON.stringify`-identical** — same roles, same content, same
  order.
- `buildModelMessages` (the full provider prompt): `[0]` system prompt equal;
  `[1..4]` history turns equal; message counts 6 and 6.
- The only difference is at the **tail** (index 5), and it is a volatile
  timestamp inside the injected turn-context block. **Control:** calling
  `buildModelMessages` twice on the *same parent frames* also differs, at the
  same place, by the same kind of timestamp. So that difference is pre-existing
  per-request behaviour and is **not** introduced by forking.

The claim holds. It is not softened below what was measured, and the residual
difference has a control proving it is unrelated to the fork.

## 8. The gate is red on purpose

`spec/core/context/session-fork-seam-spec.mjs` fails the wiring assertions today.
That is the intended state: a red gate naming "session-tools.mjs does not import
session-fork.mjs" is harder to ignore than a green planner nobody calls. Do not
silence it by deleting tests; make it green by applying §2.

## 9. Wording change requested for the read-only team's README

`spec/core/context/README.md:47` says:

> Frames are additionally *physically* partitioned by session:

and line 351 refers to "the session's own directory". Both are the same error
this document corrects in §1.2. **This engineer has not edited that file** — it
belongs to the contract team; reporting per instruction.

Suggested replacement for line 47: frames are *keyed* by session — each frame is
stored under `/sessions/<sessionID>/interactions/...` inside the single AeorDB
file, so no cross-session read can see them, but they are keys in one database,
not directories on disk.
