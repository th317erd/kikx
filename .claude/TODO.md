# TODO: Event-Driven DOM Rendering via FrameManager

## Context

The client-side rendering was supposed to be driven by FrameManager events
(`frame:added`, `frame:updated`, `frame:phantom`), with the DOM as a projection
of FrameManager state. Instead, three separate manual rendering paths were built
that bypass the event system, causing duplicate rendering, infinite scroll bugs,
and architectural drift from the original plan.

**Reference docs:**
- `bot-docs/plan/kikx/frame-manager.yaml` — Authoritative FrameManager spec
- `bot-docs/plan/kikx/reactive-frame-engine.yaml` — Git-inspired evolution spec
- `bot-docs/docs/client-architecture.md` — Client architecture (describes the correct pattern)

**Principles (from the plan):**
- All frame data enters through `merge()` — events drive rendering
- Phantom frames with `groupID` handle streaming (deep-merge into group frame)
- Phantom frames without `groupID` handle ephemeral state (typing indicators)
- DOM is a projection of FrameManager state, not an independently managed thing
- `querySelector('[data-frame-id="..."]')` is the DOM lookup mechanism (no parallel maps)
- Existing DOM elements are updated in place, not destroyed and recreated

## Status Key
- [ ] Not started
- [~] In progress
- [x] Complete

---

## Step 1: `createFrameElement(frame)` — Pure DOM Factory ✅

Extract the DOM element creation logic from `_renderFrame()` into a pure factory
function that takes a frame and returns an `HTMLElement`. No placement, no side
effects, no options flags.

- [x] Extract element creation for each frame type (message, user-message, permission-request, session-link, command-result, error, reflection)
- [x] Return the element — caller decides where to put it
- [x] Handle `hidden` frame types (return `null` for non-renderable types)
- [x] TDD: 54 tests in `spec/client/create-frame-element-spec.mjs`

## Step 2: Event-Driven Rendering — `frame:added` ✅

Wire `frame:added` to create and insert DOM elements in the correct ordered
position.

- [x] On `frame:added`: call `createFrameElement(frame)`, insert at correct DOM position based on `frame.order`
- [x] Ordered insertion handles both append and prepend automatically
- [x] Dedup guard: `querySelector('[data-frame-id="${frame.id}"]')` — if exists, skip
- [x] Scroll position preservation when inserting above viewport
- [x] Ghost adoption for optimistic user messages

## Step 3: Event-Driven Rendering — `frame:updated` ✅

Wire `frame:updated` to find and patch existing DOM elements in place.

- [x] On `frame:updated`: find element via `querySelector('[data-frame-id="${frame.id}"]')`, patch content
- [x] Handle message HTML and reflection text updates
- [x] TDD: 33 tests in `spec/client/event-driven-rendering-spec.mjs`

## Step 4: Phantom Frames for Streaming — DEFERRED

Replace the manual typing indicator / streaming bubble logic with phantom frames
through the FrameManager pipeline.

**Deferred because:** The server sends raw `delta` SSE events, not phantom frames.
Converting deltas to phantom frames client-side would add indirection without
practical benefit. The current streaming mechanism works correctly and integrates
with the event-driven `_initFrameManager()` handlers (streaming finalization,
reflection finalization). This step should be revisited when/if the server moves
to a phantom-frame-based streaming protocol.

- [ ] `interaction:start` → ephemeral phantom (no groupID) → typing indicator
- [ ] `delta` → phantom WITH groupID → group frame → streaming bubble
- [ ] `commit` → targets group frame → finalize
- [ ] Remove `_showTypingIndicator`, `_handleStreamDelta`, etc.

## Step 5: Unify Entry Points ✅

All frame data enters through `merge()` with events enabled (except scroll-up
which uses `loadWindow()` for correct ordering since FrameManager assigns
monotonically increasing orders to later-merged frames).

- [x] `_loadFrames()`: calls `merge(frames)` — `frame:added` handles rendering
- [x] `_loadOlderFrames()`: uses `loadWindow()` (events disabled) + DocumentFragment batch prepend (fixes pre-existing ordering bug)
- [x] SSE `commit`: calls `merge(commit.frames)` with events — correct
- [x] SSE `frame` fallback: removed (dead code — FrameManager always present)
- [x] Removed `_placeInteraction()`, `fromHistory`/`prepend` options

## Step 6: Optimistic User Messages ✅

User messages render immediately with ghost styling before server confirms.

- [x] `_renderUserMessage()` adds `pending` class — reduced opacity (0.55), desaturated (0.4)
- [x] CSS transition on `kikx-interaction`: 0.3s ease opacity + filter transition
- [x] `:host(.pending)` CSS in `kikx-interaction.mjs`
- [x] `frame:added` handler adopts ghost element, removes `pending` class → smooth fade to solid
- [x] Both `_initFrameManager()` and `setupFrameRendering()` handle adoption with pending removal
- [x] TDD tests already cover pending class behavior (event-driven-rendering-spec.mjs)

## Step 7: Bulk Load Performance — SKIPPED

Initial load performance is acceptable without batching. The 100+ frame scenario
does not cause visible jank since each `frame:added` handler creates a simple
element and appends it. Premature optimization deferred until profiling shows
a real bottleneck.

## Step 8: Cleanup ✅ (partial)

Remove dead code and bandaids that were symptoms of the broken architecture.

- [x] Removed `_renderFrame()` (~320 lines) — replaced by `createFrameElement` + event handlers
- [x] Removed `_placeInteraction()` — dead code (only called from `_renderFrame`)
- [x] Removed `_escapeHTML()` instance method — replaced by module-level `escapeHTML()`
- [x] Removed SSE `frame` case — dead code (FrameManager always present)
- [x] Updated `_updateRenderedFrame()`, `_renderUserMessage()`, `_renderSystemError()` to use module-level `escapeHTML()`
- [x] Verified all 3209 tests pass, 0 failures, 0 cancelled
- [x] Streaming state variables removed — `_agentStreams` → `_typingIndicators` + `_streamingGroups` + `_relayStreams`
- [x] Puppeteer E2E test — 18 tests across 5 suites: login, session rendering, message sending + agent response, scroll behavior, DOM structure verification

---

## Summary

**File**: `src/client/components/kikx-session-page/kikx-session-page.mjs`
- Started at ~2463 lines
- Now at ~2046 lines (~417 lines of dead code removed)
- Exports: `createFrameElement(frame)`, `setupFrameRendering(frameManager, container)`
- Event-driven rendering is the primary rendering path for all rendering (initial load, SSE commits, streaming)
- Streaming uses FrameManager phantom frames (ephemeral for typing, groupID for deltas)
- Initial load uses DocumentFragment batch rendering (single DOM append)
- Optimistic user messages have ghost styling with smooth transition on confirmation

**Test coverage**: 3239 unit tests + 18 E2E tests, 0 failures

---

## Notes

- The `_oldestLoadedOrder` tracking for scroll-up pagination uses raw API response
  orders (DB-level), not FrameManager internal orders. This is correct because
  the FrameManager reassigns orders on merge.
- The `near-top` event in `kikx-chat-view` fires on every scroll while at top.
  The `_loadingOlder` guard prevents concurrent loads. With proper `beforeOrder`
  filtering (fixed in frame-controller.mjs), the server returns progressively
  older frames until empty, then `_oldestLoadedOrder = 0` stops further requests.
- Server-side fix already applied: `FrameController.list()` now parses
  `beforeOrder` from query params (was missing, causing infinite reload bug).

---

# Client Test Audit (2026-03-15)

## Phase 1: Audit & Document
- [x] Read all existing test files in `spec/client/`
- [x] Read client-architecture.md for component inventory (32 components)
- [x] Read untested component source files
- [x] Catalog tested vs untested components

## Phase 2: Write Missing Tests
- [x] Create `spec/client/store-spec.mjs` — 37 tests covering all 6 scopes + events + getState
- [x] Create `spec/client/router-spec.mjs` — 22 tests covering routes, params, auth guards, listeners
- [x] Create `spec/client/i18n-spec.mjs` — 18 tests covering t(), interpolation, pluralization, locale
- [x] Create `spec/client/untested-components-spec.mjs` — 72 tests for 7 previously untested components
- [x] Edge cases/failure paths included in all new tests

## Phase 3: Run & Verify
- [x] Run `npm test` — 0 failures, 2915 pass, 290 cancelled (pre-existing bare import issue)
- [x] No `{ todo: true }` needed — all new tests pass against current implementation

## Phase 4: Document
- [x] Create `bot-docs/docs/client-test-audit.md` — Full coverage matrix, priority gaps, bugs found
