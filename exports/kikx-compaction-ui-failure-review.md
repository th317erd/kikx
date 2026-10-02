<!--
  KIKX COMPACTION — UI, WARNINGS, AND FAILURE FALLBACK REVIEW
  REV: 1   generated: 2026-10-02

  COMMENT CONVENTION: every comment applies to the block ABOVE it.
-->

# Compaction UI + failure fallback — current state and plan

Owner asks (2026-10-02):
1. The compaction message should appear in the UI: specially colored, collapsed,
   not showing the full message, expandable (like a tool-call output).
2. It should also show the user warnings or errors.
3. On an unrecoverable compaction failure (compactor bot errors: network, token
   exhaustion, etc.) → fall back to **trimming** old context until there is room.
4. When forced to trim, **warn the user** (in the compaction bubble) and, for an
   uncontrolled error, **also show the error(s)** in the bubble.
5. Provide a **Retry** button on the bubble. Retry re-runs compaction; on success
   it **overwrites** the original bubble, and bots automatically pick up the
   restored memory.

---

## 1. What already exists

### 1.1 A compaction UI component already exists
`src/client/components/kikx-compaction-frame.mjs` — a `kikx-tool-card`-styled
bubble that already renders: a "Compaction" badge, status (`running`/`success`/
`error`), a summary line, frame-count/boundary facts, a collapsible `<details>`
with the full summary (`pre`), and an error line when status is `error`. It is
registered as the `CompactionFrame` client component in
`register-built-in-tools.mjs:105` (`tagName: kikx-compaction-frame`,
`moduleURL: /client/components/kikx-compaction-frame.mjs`), and resolved via
`frame-component-registry.mjs` → `kikx-frame-item.mjs::_buildCustomFrameContent`.

So ask #1 (collapsed, expandable, like a tool output) is **largely built** —
except the coloring is generic tool-card styling, and:

### 1.2 Auto-compaction frames are HIDDEN and never stored on failure
- `buildCompactionFrame` defaults `hidden = true` (`compaction-frame.mjs:24`).
  Hidden frames are filtered out of the chat (`chat-view-model.mjs:34
  isVisibleFrame`). Only the **manual** (`/compact`) path sets `hidden:false`
  (`compaction-service.mjs:282`).
- **On async failure, `startCompaction` emits `compaction.failed` and returns
  `null` — it creates/updates NO frame.** So today an auto-compaction failure
  leaves the user with no bubble, no warning, and no error.
- There is **no server-side "failed" CompactionFrame** for the automatic path.

**FEEDBACK:**

<!-- add comments/edits here -->

---

## 2. Findings / gaps vs. the asks

### G1 — Auto-compaction must become VISIBLE (ask #1).
The automatic compaction frame is hidden. We need it visible (specially colored,
collapsed by default) so users see it. NOTE: un-hiding the *successful* compaction
frame changes what the consuming bots project (a visible compaction frame is still
projected as the compaction turn — `frame-type-base.mjs:116` handles it before the
hidden check — but it also becomes a visible history turn for the UI and any
`hidden !== true` history filter). Needs care: verify bots still receive the
compaction exactly once and trimming/selection math is unchanged.

**FEEDBACK:**

<!-- add comments/edits here -->

### G2 — Warnings + errors must live on the frame (ask #2, #4).
The frame currently has a single `status` and `content.text`. We need a structured
place for **warnings** (e.g. "fell back to trimming") and **errors** (the actual
failure chain: provider error, token exhaustion, network), so the bubble can show
them. Proposal: add `content.warnings: []` and `content.errors: []` (each
`{ message, at, kind }`), plus keep `status`.

**FEEDBACK:**

<!-- add comments/edits here -->

### G3 — Unrecoverable failure → TRIM fallback (ask #3), represented as a boundary.
Today: async failure → nothing (return null); the bot proceeds with the untrimmed
context and can 400/blow its window. Required: when compaction cannot complete, the
service must **stop sending the old context** so the requesting bot has room.
Per ruling Q1 this is **NOT deletion**: the trim fallback writes a (degraded)
**compaction frame at the boundary** whose projection start-point is after it. The
old frames remain in storage and can be re-compacted any time. Record that a trim
happened (warning) so the user is warned. This is the "never fail" floor.

**FEEDBACK:**

<!-- add comments/edits here -->

### G4 — Retry button + overwrite (ask #5).
No retry endpoint exists. Proposal:
- New server route `POST /api/v1/sessions/:id/compaction/:frameID/retry` (or a
  command) that re-runs compaction for the same boundary window.
- On success OR failure, **overwrite the original CompactionFrame** (same frame id)
  with the new result, emit `frame.updated`, so every bot's next projection picks
  up the restored memory automatically (and the UI bubble repaints in place).
- On failure again, the overwritten bubble shows the new error (still proceed).
- The bubble gets a **Retry** button (visible when status is warning/failed).

**FEEDBACK:**

<!-- add comments/edits here -->

### G5 — "Specially colored" bubble (ask #1).
Pick a distinct accent (e.g. amber for warnings, red for errors, a neutral
"compaction" tint for success). Add CSS classes to the existing card. Icon/color
TBD by owner.

**FEEDBACK:**

<!-- add comments/edits here -->

---

## 3. Proposed approach (non-destructive)

Guiding invariant (Q1): **frames are immutable history; compaction only ever adds a
boundary frame.** The model context = `[most recent compaction/boundary frame] +
[frames after it]`. Nothing is deleted; any point can be re-compacted.

1. **Frame shape (core).** Add `warnings[]` + `errors[]` to the compaction frame
   `content` (and mirror on `compaction`). Make **all auto-compaction frames
   visible** (`hidden:false`) with a distinct subtype/marker so projection still
   treats them as compaction memory.
2. **Failure path (core).** In `startCompaction`/`runCompaction`, on failure:
   - write a **visible** CompactionFrame with `status:'failed'`, `errors:[…]`;
   - perform the **trim fallback** by writing a boundary compaction frame (a
     "trimmed, not summarized" marker) at the same prior boundary so the bot's
     projection start-point moves forward and it has room — **without deleting any
     frame**;
   - set `status:'trimmed'` (or keep `failed` + `trimmed:true`) with a
     `warnings:['Context was trimmed to proceed…']`.
   Never return a bare `null` that leaves the session broken; bots proceed.
3. **Retry (core + server + client).** Route + button; re-run compaction for the
   **same prior boundary frame** (strategy recomputed from the CURRENT session,
   per Q3); **overwrite the same frame id**; emit events; bubble repaints; bots
   automatically regain memory.
4. **UI (client).** Extend `kikx-compaction-frame.mjs`: color by status, warnings
   section, errors section, Retry button → calls the route; collapsed by default,
   always visible.
5. **Tests.** Visibility; projection correct when visible; failure writes a
   warning/error boundary frame (never deletes); trim fallback moves the projection
   start and warns; re-compaction from any historical boundary works; retry
   overwrites and restores; retry failure overwrites with the new error; a retried
   compaction after a new small bot joins uses the new (smaller) window.

**FEEDBACK:**

<!-- add comments/edits here -->

---

## 4. Owner answers (2026-10-02) — RULINGS

### Q1 — WE NEVER DELETE FRAMES. EVER.
The compaction model, stated by the owner:
- Compaction picks **a frame somewhere in history**. **EVERY FRAME BEFORE IT**,
  summed together, is the "context" that gets compacted.
- The **context calculation always STARTS from the MOST RECENT compaction frame**,
  and sends `[most recent compaction] + [all messages after it]` to bots.
- **Nothing is ever lost. Nothing is ever deleted.** Frames remain in storage
  forever. We can always re-compact, from ANY point in history, AT ANY TIME.
- Therefore the "trim fallback" is **NOT deletion**. Trimming is represented as a
  compaction: a new (degraded/trim) **compaction frame** at the boundary, so the
  projection starts after it and stops sending the old context. The old frames
  still exist and can be re-compacted later (e.g. by Retry).

### Q2 — ALWAYS VISIBLE.
Every compaction is always visible to the user (not just manual ones). The user
must be able to inspect the compaction now, and fine-tune it in the future.

### Q3 — Same boundary, strategy may change.
Retry usually targets the **same prior boundary frame**, but the compaction
**strategy may change** between attempts. Example: compaction runs, the session
continues, a new (smaller) bot joins, compaction fails, the user retries — now a
small bot is present, so the trigger/strategy must account for it. We still compact
the **same prior boundary message**; only the compaction itself changes (to satisfy
the new smaller bot).

### Q4 — Let bots proceed with trimmed context; warn the user.
Yes. Trimming is not ideal, which is why we warn. But bots **WILL proceed** with
the trimmed context. It is up to the user to see the warning/error on the
compaction bubble and act.
