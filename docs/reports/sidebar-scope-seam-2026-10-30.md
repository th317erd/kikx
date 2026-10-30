---
title: Sidebar scope seam
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
last_verified: 2026-10-30
summary: Evidence for the sidebar session-scope correction.
---

# Sidebar scope seam: a latent field mismatch, and what the seam actually is

Date: 2026-10-30
HEAD at time of work: `ddfbc733` (after `git fetch` + `--ff-only`; `origin/main...HEAD` = `0 0`)
Author: Zav (coordinator)

## Why this exists

Todo "Inbox mounts real QuestionFrame + wire the dead sidebar scope seam" carried two
gaps. One was real work. The other was already shipped, and had been chased twice.

This report records both, because the first delegation to measure it (Kikx-Node-Eng,
session `8c6aff97`) and my own recon both reached a conclusion that needed correcting.

## Gap 1 — Inbox mounting the real QuestionFrame: ALREADY DONE, not touched

Commit **`88400fe3`** (2026-10-23 22:11, "fix(inbox): stop the close control drifting
left, and match the frame's box") changed `kikx-inbox-list.mjs:23` to:

```js
import { renderInboxQuestionRow } from './kikx-question-frame.mjs';
```

`kikx-question-surface.mjs:132-166` builds `<article class="kikx-question-card"
data-question-id>` and appends a real `<kikx-question-frame>` via `createElement`,
handing it `inboxChrome: true` plus `groupCount` / `now` / `handlers`. That is exactly
the adapter shape the owner approved: wrapper keeps the Inbox selectors, frame does NOT
carry `.kikx-question-card` (which would double-count in the list reconciler, `:128-131`).

**Browser proof at HEAD** (not spec-level), real Chromium:

```
node --test spec/ui/playwright/inbox-frame-visual-parity-playwright.mjs
-> tests 1 / pass 1 / fail 0, PARITY_EXIT=0
-> find src spec -newermt @START : empty
```

Test name: "the Inbox row and the in-thread Question frame compute to the same visual
style". It carries 16 assertions and fails on `pageerror` and any 4xx response, so the
"nothing compares equal to nothing" trap cannot pass it.

### Why it kept looking unfinished

`kikx-question-card.mjs` still exists (692 lines) and is still imported — by
`kikx-question-frame.mjs:32` for `bindDismissControl` / `buildDismissControl`. Checking
"does the card reference kikx-question-frame" therefore returns 0 and reads as "the old
renderer is still live", while the actual render path is `renderInboxQuestionRow` in a
different file. Two separate agents drew the same wrong inference from the same grep.

## Gap 2 — the scope seam: a real defect, but not the one described

### The mismatch

`buildSessionObjectItems` stamps every descriptor with **`scopeSessionID`**.
`sessionIDOf` (`src/client/state/session-scope.mjs`) read only
`sessionID` / `sessionId` / `ownerSessionID` / `ownerSessionId`.

Measured consequence before the fix:

```
sessionIDOf({id:'agents', scopeSessionID:'CHILD'})   ->  ''
createSessionScope('ROOT').filter(items5)            ->  0/4 kept
createSessionScope('CHILD').filter(items5)           ->  0/4 kept
```

So wiring the seam as-is would have produced a **blank sidebar**, not a scoped one.

### Why two green specs missed it

- `spec/ownership/sidebar-seam-spec.mjs` pins the CONTRACT. It supplies its own filter
  and receives `scopeSessionID` as the second argument — it never calls `sessionIDOf`.
- `spec/ownership/session-scope-filter-spec.mjs:42-49` tests `sessionIDOf` against the
  four names it already supported. Nothing asserted `scopeSessionID`.

The real seam — a descriptor **built by the sidebar** arriving at the predicate — fell
in the gap between them.

### The fix

`sessionIDOf` now reads `scopeSessionID` first, keeping the other four names because
other row shapes carry them (assignment, question, activity rows); dropping one would
silently widen what is visible.

New spec `spec/ownership/sidebar-scope-field-spec.mjs` (6 tests) asserts on **real built
descriptors**, never hand-written rows, because a hand-written row is how the blind spot
survived.

Mutation-proven: removing the `scopeSessionID` lookup from `sessionIDOf` gives
`MUT_EXIT=1`, **5 pass / 1 fail** (the one survivor is the chip/identity test, which does
not depend on that field). Restore verified byte-identical by sha256
(`55ab4ec1ab3deee27c1aaaac16cbd1d9e7cfd402fa1f7a2328e594be443fbbe7`).

### One test correction of my own

My first version asserted "5 of 5 kept" from the bare scope. It failed at the leaf —
correctly. The account chip carries `scopeSessionID: null`, so ownership can never vouch
for it and it needs the **identity carve-out** on top (the seam spec's trap 1). The test
now asserts the two facts separately: the four scoped controls survive ownership, and all
five survive only through the documented contract filter. Asserting one number would have
blurred a real design requirement.

## What the seam actually is — the correction that matters

Wiring a filter into `buildSidebarSessionObjects` today is a **provable no-op**, and this
is the part both the older todo note and my own earlier framing got wrong.

Every one of the five descriptors is either:

- the global account chip (`scopeSessionID: null`), or
- stamped with `getScopeSessionID(app._state)` — the session **currently being viewed**.

So owner === viewer for all five. A visibility predicate can only ever pass them.
Scope enforcement against real owned entities **already lives elsewhere and is live**:

```
src/client/components/kikx-agent-team-views.mjs:30-43
  scopedAgents(app)  -> getEffectiveSessionAgentIDs(app._state, sessionID)
  scopedTeams(app)   -> same
```

That path does **not** route through `session-scope.mjs` or `buildSidebarSessionObjects`.

The stale claim in `kikx-sidebar-session-objects.mjs:12-19` ("Prong B can filter the array
via its `filterSessionsInScope`") has been corrected in the source, with the measurement
recorded there so the next reader does not repeat the delegation.

## Evidence

| Check | Result |
| --- | --- |
| `node --check` on both changed files | OK |
| 3 scope specs (new + 2 siblings) | 19 tests / 19 pass / 0 fail / `EXIT=0`, freshness empty |
| Mutation (drop `scopeSessionID` lookup) | `MUT_EXIT=1`, 5 pass / 1 fail, restore byte-identical |
| Browser parity spec at HEAD | 1 pass / 0 fail, `PARITY_EXIT=0`, freshness empty |
| Full `npm test` | see `/tmp/scope-gate.log` |

## Not verified / limits

- **No browser evidence for the field fix itself.** It changes a predicate that no
  production call site currently invokes with a filter, so there is nothing visible to
  observe. The proof is at the module boundary plus the mutation.
- The seam remains scaffolding. It gains meaning only when an item owned by a *different*
  session is rendered in that cluster.
- `questions.css` (1,037 L) and `app.css` (4,031 L) both exceed the 800-line hard cap in
  `AGENTS.md`. Pre-existing; untouched here.

## Process failures worth recording

1. I used `write-file` with `mode: overwrite` on a **ranged** read, which replaced the
   whole file with only the section I had read. First occurrence was caught immediately
   and restored from git byte-identically (`git checkout --`, 6,463 B, `git diff --stat`
   empty). Second occurrence destroyed the new spec moments after writing it; it was
   untracked, so no git recovery — rewritten complete.
   **`expectedContentHash` guards against a concurrent writer, not against my own
   truncation.** For section edits, edit the whole file or use a targeted replacement.
2. The delegation to `8c6aff97` could not start the worker: `SessionMessageTool.inputSchema`
   admits only `text` (`additionalProperties: false`) and `_execute` contains no wake call,
   so a posted assignment is a visible message, not a prompt. `session-control resume`
   returned `resumed: false` (the agent was never suspended). With no way to start the
   worker and the goal otherwise idle, I took the work over rather than leave it stalled.
