# Kikx session-tree consolidation: the joint symphony plan

**Author:** Zav (coordinator, `99129d53`)
**Date:** 2026-10-27
**HEAD measured:** `d402558`
**Status:** DRAFT FOR RATIFICATION. Tracks are authorised to *specify*; nobody applies code until
each track has acked its section and the cross-track seams below are signed off.

This file is the single artifact the owner asked for: **three independently developed
workstreams, merged into one session, producing one plan that works together.** It is written by
the coordinator from measured evidence, not from the prongs' own summaries. Every line reference
below was read at `d402558` during this pass.

---

## 0. What is actually true right now

Measured during this pass. Where a belief was wrong, the correction is stated.

| Claim | Status | Evidence |
|---|---|---|
| Three prong sessions exist as children of this session | **TRUE** | `session-get` → `60e952cb` (305 msg, coord `255f7273`), `37856013` (262 msg, coord `be00ce68`), `d87b91c9` (402 msg, coord `e5403bc7`) |
| The three were merged into this session | **TRUE, but only 2 of 3 sources compacted** | `merge-409c7a37` `status:"complete"`; CompactionFrame `6d8e2d47` is 127,169 bytes at `interactions/compaction-c8658001-.../frames/0000000003061404-...`; `compactedSessionIDs` = root+Prong C+Prong A; **`untouchedSessionIDs` = `37856013` (Prong B)**, which was never summarized |
| Prong A's toolbar is reachable from the app | **TRUE** | `kikx-shell-builders.mjs:32` and `:34` import it; `:260` calls `buildSidebarSessionObjects(app)` |
| Prong B's ownership filter runs in the sidebar | **FALSE** | same call site passes one argument; `scopeFilter` defaults `null`; `filterSessionObjectItems` short-circuits at `kikx-sidebar-session-objects.mjs:83-87` |
| Prong C's coordinator scope is reachable | **TRUE** | `coordinator-tree-halt.mjs:19`, `session-control-tool.mjs:7` import from `session-subtree.mjs` |
| `applyJoinCoordinatorOverride` is redundant (my earlier call) | **FALSE** | `coordinator-join-override-spec.mjs` JOIN-B/JOIN-C: read path crowns a stranger, not the joiner |
| Client may delegate to `src/core/` | **FALSE** | `grep -rn "from '.*core/" src/client/` → no matches |

Gates re-run on committed bytes this pass, with no source file modified during the run:

- `node --test spec/ownership/*-spec.mjs` → **57 tests / 57 pass / 0 fail / 0 skipped**, exit 0
- coordinator specs (scope + tree-halt + late-yield + join-override) → **45 tests / 45 pass / 0 fail**, exit 0

---

## 1. The architectural constraint that decides every seam

`src/client/` imports **nothing** from `src/core/`. This is not a convention, it is the build
boundary: the browser receives `/shared/` (`src/server/static-files.mjs:75-77`) and the client
bundle. Therefore:

> **Any rule that both the browser and the server must evaluate lives in `src/shared/` and
> nowhere else.** `src/shared/session-ancestry.mjs` is that place, and both surfaces are thin
> re-exports over it.

This single fact retires three would-be plans, including one I endorsed myself:

1. You cannot "have the client delegate to core" — the import does not exist and cannot.
2. You cannot delete the shared `descendantSessionIDs` in favour of the core one.
3. You cannot make core the only owner of the ancestry rule while the sidebar filters rows.

The same rule has an inverse: a rule that only the **server** evaluates (index predicates, halt
fan-out, invite-time promotion) belongs in `src/core/` and must **not** be copied into
`src/shared/` just because two core files wanted it.

---

## 2. File ownership table

Nobody writes outside their row. A path appearing in two rows is a defect in this table — report
it, do not resolve it locally.

### Track A — client shell, toolbar, sidebar surface (`255f7273` Node-Eng)
```
src/client/components/kikx-topbar.mjs                  325 L
src/client/components/kikx-sidebar-session-objects.mjs 122 L   ← owns the seam signature
src/client/components/kikx-shell-builders.mjs         640 L   ← owns the call site
src/client/styles/topbar-unified.css                  191 L
src/client/index.html
spec/ui/stagehand/*.mjs                                (7 specs, re-pointing)
```
**A must not touch:** `app.css`, `src/shared/`, `src/core/**`, `../kikx`, any other crew's files.

### Track B — ownership rule, shared ancestry, query layer (`be00ce68` Ownership-Eng)
```
src/shared/session-ancestry.mjs                       283 L   ← THE shared rule, both surfaces
src/client/state/session-scope.mjs                    173 L   ← client surface over it
src/core/ownership/session-ownership.mjs              112 L   ← core surface over it
src/core/ownership/ownership-query.mjs                145 L   ← indexed path for scoped routes
spec/ownership/*.mjs                                  57 tests
```
**B must not touch:** `src/core/agents/**` (C), `src/client/components/**` (A),
`aeordb-agent-store.mjs` / `aeordb-team-store.mjs` (needs a routing decision, see §6).

### Track C — coordinator resolution, tree halt, subtree walk (`e5403bc7` Runtime-Eng)
```
src/core/agents/coordinator-scope.mjs                 513 L   ← OVER SOFT CAP, see §5
src/core/agents/coordinator-tree-halt.mjs             425 L
src/core/agents/session-subtree.mjs                   118 L   ← canonical downward walk
spec/core/agents/coordinator-*.mjs                    45 tests
```
**C must not touch:** `src/shared/`, `src/client/**`, `src/core/ownership/**`.

### Coordinator (Zav) — sole committer
All commits, all pushes, this document. No track commits or pushes.

---

## 3. Cross-track seams — the part that must be agreed, not discovered

### Seam B→A: the scope filter (the live unblock)

**Current state, measured:** `kikx-shell-builders.mjs:260` calls
`buildSidebarSessionObjects(app)`. `kikx-sidebar-session-objects.mjs:102` accepts
`(app, { scopeFilter = null })`. `filterSessionObjectItems` (`:83-87`) returns the array
unchanged when the filter is not a function. **The shipped sidebar does not filter at all.**

**Contract, to be written by B and applied by A:**

```js
// A's file — the import (A writes this line)
import { filterItemsInScope } from '../state/session-scope.mjs';

// A's file — the call site at kikx-shell-builders.mjs:260 (A changes this)
buildSidebarSessionObjects(app, {
  scopeFilter: (item, scopeSessionID, appState) =>
    filterItemsInScope(viewerSessionID, [ item ], sessionsForViewer).length === 1,
});
```

B owes A, in writing: where `viewerSessionID` comes from on the client (the current session's
id), where `sessionsForViewer` comes from (`getVisibleSessions()` at `kikx-state.mjs:357`), and
confirmation that reading an owner from `sessionID`/`sessionId`/`ownerSessionID`/`ownerSessionId`
and dropping ownerless rows (fail-closed) is the intended behaviour.

**The proving test must assert a count and a sibling's absence** — e.g. build the sidebar for
viewer `C` where sibling `S` also owns rows, then assert `S`'s rows are absent and the total row
count matches the expected scoped set. A test that only asserts the filter "was called" is
worthless and B has already been told this.

**Definition of done:** the sidebar for a viewer shows exactly `{viewer} ∪ ancestors(viewer)`
owned sessions, and a sibling session's rows are provably absent, demonstrated on `:3001` and by
a spec that fails if the filter is removed.

### Seam C→all: one upward walk

C owns the **only** upward parent/coordinator walk for the server. Both `agent-route/normalize.mjs:46`
and `frame-runtime-normalize.mjs:143` currently carry duplicated coordinator-fallback copies;
C owns consolidating them and neither A nor B may add a third. B's shared
`ancestryChain`/`visibleOwnerIDs` is the **ownership** rule (who may see a row), which is a
different question from **authority** (who may halt/route) — both walks exist, both are named,
and they are not to be collapsed in either direction. The two-session test cannot distinguish
them; the parity spec can.

### Seam C→B: two `descendantSessionIDs`, both stay

`src/shared/session-ancestry.mjs:231` `(viewerSessionID, sessions = [])` and
`src/core/agents/session-subtree.mjs:116` `(rootSessionID, options = {})` are same-named and
different. Core's is the bounded BFS (`maxNodes` default 1000, returns
`{sessionIDs, truncated}`) and is used by the halt fan-out, which is exactly where an unbounded
walk would be a denial of service. Shared's serves the browser, which cannot import core.
**Decision: both stay. B adds a comment at `:231` cross-referencing core's bounded contract.
No rename, no deletion, no third implementation.**

---

## 4. Sequencing — what is parallel and what is ordered

```
STEP 1 (ordered, blocking)      B writes the seam spec  ──►  A applies it
                                  ▲ the only true serial chain in this plan
STEP 2 (parallel)               C wires applyJoinCoordinatorOverride
                                A measures the double-header in a real browser
                                A re-points the 7 stagehand specs
STEP 3 (parallel, after Step 1) B documents the two-walk split + starts the scoped-route work
STEP 4 (coordinator)            land C's join-override spec, then A's seam, then B's comment
```

**Why Step 1 is serial:** A's file and B's spec are the same behaviour seen from two sides. If
both move at once, neither can be proven — the spec would be written against a call site that is
changing. B specifies, A applies, one commit pair.

**Why Step 2 is genuinely parallel:** C's work is server-only and touches no client file; A's
browser measurement touches no core file. They share no path.

**Do not start Step 3's scoped route before Step 1 lands.** The route needs to know the filter
contract is real, or it will be an index built for a predicate that shifts.

---

## 5. Rulings this plan depends on

1. **`ownership-query.mjs` (145 L) stays.** It is the only indexed ownership path; its own header
   explains that post-load filtering is ~20k frames per sidebar render. Spec-only import graph
   reflects "no scoped route yet", not "useless".
2. **`session-ownership.mjs` (112 L) stays.** `ownership-query.mjs:30` imports
   `normalizeSessionID` from it; deleting the "thin naming table" breaks the query layer.
3. **`applyJoinCoordinatorOverride` is DELETED, not wired.** (Superseded: this
   ruling previously read "gets wired, not deferred", on the grounds that JOIN-B and JOIN-C
   contradict the owner's sentence. That version is withdrawn.)

   Wiring the helper grants an unrelated joiner coordinator authority -- lateral takeover -- and
   writes `coordinatorAgentID` on the join path, while the resolver's own rule is that authority
   flows **DOWN** the ancestry chain and is **derived, not stored**. `isCoordinatorOfSomeSession`
   had no implementation anywhere in `src`, so "wiring" meant inventing a tree-wide oracle *and*
   turning a derived property into a persisted one.

   Landed in `b7504ed6`: the helper is removed (`coordinator-scope.mjs` 514 -> 469 L) and
   `coordinator-join-override-spec.mjs` is repurposed as `coordinator-join-boundary-spec.mjs` --
   6 tests against the live resolver, the first asserting the export stays gone (mutation-proven:
   re-adding a trivial export gives 5 pass / 1 fail on exactly that assertion).

   **Live conflict, recorded rather than resolved unilaterally:** the owner's literal P3 sentence
   ("If a coordinator is added to a child frame, then that coordinator takes over responsibility
   for itself, and all child bots") does support the wired behaviour for JOIN-B and JOIN-C. Those
   two shapes are therefore now knowingly **unsupported**, pinned by executable assertions. If the
   owner wants P3 to hold literally, the fix is a rule change in the read path's ancestor ordering
   plus a tree-wide coordinator index -- **not** a revival of the deleted helper, which was the
   wrong mechanism for it. See `docs/reports/coordinator-lane2-decision-2026-10-30.md`.
4. **`coordinator-scope.mjs` is now 469 L, under the soft cap.** The previous "513 L accepted
   debt" note is closed by the deletion in ruling 3.
5. **No participant-removal primitive exists.** There is no way to kick an agent from a session
   at `d402558`; suspend is a freeze. This is a reported product gap, not a track task.

---

## 6. Needs an owner decision (routed, not assumed)

- **Inbox / Activities scope.** `kikx-shell-builders.mjs:266-271` documents Inbox as "visible
  from anywhere, above the project tree" — the direction the ownership rule forbids. Either that
  comment predates the requirement (both views become subtree-scoped) or the owner grants an
  explicit global exception for them. Unresolved, the filter hides both.
- **Agent/team record ownership.** Adding `ownerSessionID` to agent and team rows at create
  (`aeordb-agent-store.mjs` ~:52, `aeordb-team-store.mjs`), indexing it, and filtering on read
  would make agents themselves session-scoped. Consequence: pre-existing ownerless rows vanish
  until backfilled. This is a product decision with data migration, not a refactor.

---

## 7. The merge, honestly

The three prongs remain **three child sessions**. The consolidation this plan describes is
architectural (one shared rule), not conversational. `session-merge` reported `running` and left
`{"merges":[]}`; no CompactionFrame is present in this session. The plan therefore does not
depend on the merge having landed, and the prongs were messaged **in their own sessions** so the
work proceeds regardless. If the owner wants the histories merged, that is a separate step to
re-attempt; it is not a precondition for the symphony.

---

## 7. The merge, honestly — CORRECTED 2026-10-27T04:58Z

**This section previously said the merge had NOT landed. That was wrong.** Kept here as a
corrected record rather than deleted, because the reasoning error is instructive.

### Verified now (measured, not inferred)

Merge `merge-409c7a37-963d-4402-9ca9-88bcc375574b` — `status: "complete"`.

- Record: `/kikx/session-merges/merge-409c7a37-963d-4402-9ca9-88bcc375574b.json`, 1,083 bytes
- Compaction frame: `6d8e2d47-34c0-462c-93f4-7cc18e4aa1e8`, **127,169 bytes**, at
  `/kikx/sessions/cb551b14-.../interactions/compaction-c8658001-6e3b-4dc2-b3d6-5c2d471ca1ac/frames/0000000003061404-CompactionFrame-6d8e2d47-....json`
- `targetSessionID`: `cb551b14` (this session)
- `sourceSessionIDs`: `37856013` (Prong B), `d87b91c9` (Prong C), `60e952cb` (Prong A)
- `compactedSessionIDs`: `cb551b14`, `d87b91c9`, `60e952cb`
- **`untouchedSessionIDs`: `37856013` (Prong B) — NOT compacted**
- `closedSessionIDs`: `[]` — all four sessions still live

### What this means

Shared memory **does** exist in this session for root + Prong A + Prong C. Prong B's history was
listed as a source but was never summarized: `_runJob` seeds `selected` from
`planSessionCompactions()` and only grows it under budget pressure, so a requested source can be
left untouched silently.

### Why this section was wrong before

`session-merge-status` is the only agent-facing way to check a merge outcome, and it cannot report
a completed merge in either mode:

- no args → `{"merges":[]}` — `listMerges()` reads the in-memory `_active` map plus a
  `store.list()` that does not enumerate the merge-record namespace, so nothing survives a restart
- with `merge_id` → all fields `null`, `compactionFrameID: null` — `store.get()` resolves but
  `sanitizeJob()` fails to map the stored record's field names

So "merge silently failed" and "tool cannot report" are indistinguishable. I concluded the former.
The frame file was the disambiguation and I did not look for it. Filed as
feedback `eff727c9c3b2fce52fdf1247` (high).

**AeorDB correction:** the daemon is NOT retired. `:6830` is live on `127.0.0.1`, running
`aeordb start -D /home/wyatt/.local/share/kikx/kikx.aeordb` (pid 1358773) — a different database
from this project's `.aeordb/kikx.aeordb`. Earlier instruction to Prong A to "re-point the
stagehand specs off a dead daemon" was based on a bad read.

The prongs are still messaged **in their own sessions**, which remains correct: all four sessions
are live and each prong's own context is intact.
