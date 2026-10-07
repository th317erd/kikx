# Kikx stability campaign

**Lane split (owner directive, 2026-10-07):** the assistant owns Kikx *stability*
(crashes, memory, wedging, responsiveness, monitoring). *Feature development*
belongs to the **Production Kikx bot**, so that Kikx dogfoods itself.

**Goal:** Kikx should fail *softly and observably*. No single bad message, stream
event, or frame renderer may wedge, freeze, or silently kill the UI; no structure
may grow without bound; a failure must be visible to the user (and to us).

## Evidence already in hand

| # | Finding | Evidence |
|---|---------|----------|
| 1 | A throwing frame render **wedged the thread permanently** | `buildFrameThread(...).build is not a function` killed `syncFrameThread`, leaving the placeholder forever (fixed in `397f592`) |
| 2 | A render entry point **died entirely** | the prod tab's `_render` was a dead sandbox function; the whole shell stopped updating until repaired in place |
| 3 | The coalesced frame-event queue **cannot drain while the tab is hidden** | `queueFrameRuntimeEvent` -> `scheduleAnimationFrame` = raw rAF; rAF fires ~1 tick/6 s hidden; queue measured ~12k events / ~60 MB during a burst |
| 4 | Client memory is **flat** in the current build | prod tab 185->150 MB / 16.5 h; dev 146 MB; whole prod DB is 49 MB |

## Work items (ranked)

### S1 — Error containment: one bad render must not wedge the app
- Guard the render/update entry points (shell render, frame-item update, chat-view
  sync, SSE dispatch) so a throw is caught, reported, and the rest of the UI keeps
  working; keep the previous DOM instead of half-applying.
- Add a bounded "recent errors" surface in the UI (small, dismissible) plus
  `window.onerror` / `unhandledrejection` capture, so a dead UI is never silent.
- Specs: a frame renderer that throws must not stop later frames/sessions from
  updating; the error must be reported exactly once.

### S2 — Unbounded-growth hardening
- `queueFrameRuntimeEvent`: add a `setTimeout` fallback so the queue drains while
  hidden, flush on `visibilitychange`, and a hard cap with coalescing (collapse
  repeated updates for the same frame id; drop payloads beyond the cap and mark
  the session for a full refresh).
- Audit every Map/Set/array that is only ever added to (client **and** server:
  `FrameRuntime.sessions`, todo stores, previews, batches) and give each an
  eviction or a cap.
- Timer/listener/observer lifecycle: nothing may be registered per render or per
  reconnect without a matching teardown.

### S3 — Responsiveness under streaming load
- Remaining step of the smoothness pass (`3f8b5e1` did element stability):
  throttle/coalesce the re-render storm during a live turn so typing/scrolling
  stays smooth; keep the compositor-friendly animation rules.
- Re-verify with the in-page probe used for `3f8b5e1`.

### S4 — Failure-path coverage for stability-critical paths
- Specs for: stream error/close mid-burst, malformed runtime event, unknown frame
  type, oversized frame body, storage read failure, delete failure, hidden->visible
  transition with a backed-up queue.

### S5 — Monitoring (keep running)
- Client leak watchdog `leak-watch.py` (armed, tracks Kikx pids; captures an
  attribution bundle before a blow-up).
- Add a cheap server-side RSS sampler for the container + dev server so server
  growth is caught as early as client growth.
- Keep the caveat prominent: `127.0.0.1` pages share one site process, so
  attribute any blow-up to the *site*, not automatically to Kikx.

## Rules of engagement
- Reproduce with a failing spec before fixing; cover the failure path.
- Verify client fixes in a real browser (dev `:3001` via a magic link) before
  claiming stability — a green suite hid defect #1.
- Never regress the owner's running dev/prod instances while investigating.
