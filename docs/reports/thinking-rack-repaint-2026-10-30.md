---
title: Thinking rack never repainted on a thinking-only batch
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
---

# Thinking rack: panels stayed dead while an agent was thinking

Measured 2026-10-30 in kikx2, at `6e8b32f8` before the fix.

## Symptom

The Playwright spec `spec/ui/playwright/thinking-rack-playwright.mjs` failed at
its first panel assertion: `one panel per thinking agent — 0 !== 1`. The pinned
thinking dock rendered an empty rack while an agent was streaming reasoning. One
of the four pre-existing browser-lane failures was this defect, not test drift.

## What was ruled out, by measurement

- **The rack is absent from the DOM.** No. A probe reported `racks: 1, docks: 1`.
- **The injected event never arrives.** No. The probe drove
  `app._onRuntimeEvent({type:'frame.phantom', ...})` and the thinking buffer
  updated exactly as intended: `order: ["session_1\0agent:agent_1"]` with entry
  `{ id: 'agent_1', agentID: 'agent_1', name: 'Zav' }`.
- **The live-frame type set dropped the injected types.** No.
  `LIVE_FRAME_TYPES` still contains `BeginTyping`, `AgentThinking`,
  `AgentMessageDelta` and `EndTyping` (`thinking-state.mjs:15-20`).
- **The routing dropped `frame.phantom`.** No. `kikx-runtime-events.mjs:116-119`
  queues it, and `applyThinkingFrame` runs at `:399` *before* the visible-window
  guard.
- **The rack is not in the shell.** No. `kikx-shell-builders.mjs:474` creates it
  and `:494` places it in the dock.

The buffer was correct and the rack was present, so the failure had to be the
repaint, not the data.

## Root cause

`syncThinkingRack(app)` has exactly two entry points, both requiring a *visible
thread frame*:

- `afterRender()` at `kikx-frame-scroll.mjs:184` — runs only when a render
  happened.
- `syncFrameThreadBody()` at `:282` — runs only when the thread has frames to
  reconcile.

Thinking frames are deliberately excluded from the thread (`isLiveThreadFrame`
is the inverse predicate, `thinking-state.mjs:22-30`). In
`processFrameRuntimeEvents` the sequence is:

1. `applyThinkingFrame(...)` updates the buffer — always.
2. `if (!incomingFrameMatchesWindow(...)) return;` — returns for exactly the
   thinking frames.
3. `addTouchedFrameIDs(...)` is only reached after that guard.

At `:427-433` the rack is repainted only inside `if (touchedFrameIDs)`. A batch
carrying only thinking frames therefore never repaints the rack: the buffer
advanced and the dock kept rendering its previous state. No render is scheduled
either, so `afterRender` does not rescue it.

## Fix

`src/client/components/kikx-runtime-events.mjs`, +19/-1:

- `applyThinkingFrame` already returns a boolean for "the buffer changed". That
  return value is now captured into a per-batch `thinkingSessions` set.
- After the event loop, every session in that set triggers `syncThinkingRack(app)`
  inside its own `guardClientOperation` boundary, deliberately independent of the
  visible thread sync.
- The repaint is keyed on an actual buffer change, so an event that changes
  nothing does not repaint.

## Proof

- **Real Chromium, same probe before and after:** `panels: 0` → `panels: 1`.
- **The authoritative lane:**
  `node --test spec/ui/playwright/thinking-rack-playwright.mjs` →
  tests 1 / pass 1 / fail 0, `RACK_EXIT=0`. Before the fix the same spec was
  red (`RACK_EXIT=1`).
- **New guard:** `spec/client/thinking-rack-repaint-spec.mjs`, 4 tests, driving
  the real `queueFrameRuntimeEvent` + `flushFrameRuntimeEvents` path (not the
  pure buffer helpers, which pass with and without the fix).
- **Red-green-red, with the fix reverted and restored byte-identically:**
  without the fix 1 pass / 3 fail (`NO_FIX_EXIT=1`); with the fix 4 pass / 0 fail
  (`WITH_FIX_EXIT=0`). The single test that passes both ways is the deliberate
  "an event that changes nothing must not repaint" control. Restored hash
  `4801abd6d0336826d53862f63e0b55edbeea18bdd165bc758d9b3413833e3049`.

## Scope and limits

- Only the thinking-rack failure is addressed here. The two
  `answer-feedback-playwright` failures and the
  `inbox-draft-preservation-playwright` failure are separate and remain open.
- The new spec must install the vendor shim
  (`spec/client/support/frame-item-loader.mjs`) **before** importing the event
  layer, because the repaint path now reaches `kikx-shell-builders` and its
  `/vendor/aeor-web-components/*` imports. Specs that import
  `kikx-runtime-events` without that loader rely on the event layer never having
  reached the shell; if a future import makes that unconditional, they will need
  the same registration.
- `kikx-frame-scroll.mjs` does not import `kikx-runtime-events.mjs`, so this
  import direction introduces no cycle. Verified by reading both import blocks.
- Not proven: that a live agent run on a real deployment paints the panel. The
  proof is a real browser driving the production event entry point against the
  fixture server.
