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

## Step 1: `_createFrameElement(frame)` — Pure DOM Factory

Extract the DOM element creation logic from `_renderFrame()` into a pure factory
function that takes a frame and returns an `HTMLElement`. No placement, no side
effects, no options flags.

- [ ] Extract element creation for each frame type (message, user-message, permission-request, session-link, command-result, error, reflection)
- [ ] Return the element — caller decides where to put it
- [ ] Handle `hidden` frame types (return `null` for non-renderable types)

## Step 2: Event-Driven Rendering — `frame:added`

Wire `frame:added` to create and insert DOM elements in the correct ordered
position. This replaces the manual rendering loops in `_loadFrames()` and
`_loadOlderFrames()`, and the existing append-only listener in `_initFrameManager()`.

- [ ] On `frame:added`: call `_createFrameElement(frame)`, then insert at the correct DOM position based on `frame.order` relative to existing `[data-frame-id]` elements
- [ ] Ordered insertion handles both append (new frames at end) and prepend (older frames at top) automatically — no `prepend: true` flag needed
- [ ] Dedup guard: `querySelector('[data-frame-id="${frame.id}"]')` — if element exists, skip (DOM is truth)
- [ ] Scroll position preservation: when inserting above the viewport, adjust `scrollTop` (like current `prependInteraction`)

## Step 3: Event-Driven Rendering — `frame:updated`

Wire `frame:updated` to find and patch existing DOM elements in place.
The existing `_updateRenderedFrame()` is a starting point but needs to handle
all frame types, not just message content.

- [ ] On `frame:updated`: find element via `querySelector('[data-frame-id="${frame.id}"]')`, patch content in place
- [ ] Handle content updates for all types (message HTML, reflection text, permission state, etc.)
- [ ] Streaming content: phantom frames with `groupID` deep-merge into a group frame — `frame:updated` fires, content element gets patched with accumulated text

## Step 4: Phantom Frames for Streaming

Replace the manual typing indicator / streaming bubble logic with phantom frames
through the FrameManager pipeline.

- [ ] `interaction:start` SSE event → merge a phantom frame (no groupID) for typing indicator → `frame:phantom` event creates ephemeral DOM element
- [ ] First `delta` SSE event → merge a phantom frame WITH `groupID` (the interactionID) → FrameManager creates persistent group frame (hidden:true) → `frame:added` creates DOM element
- [ ] Subsequent `delta` events → merge phantom frames with same `groupID` → deep-merge content → `frame:updated` patches the DOM element in place
- [ ] Final `commit`/`frame` SSE event → merge the real frame (targets the group frame or replaces it) → `frame:updated` finalizes content
- [ ] Remove `_showTypingIndicator`, `_removeTypingIndicator`, `_handleStreamDelta`, `_handleReflectionDelta`, `_clearStreamingState`, `_agentStreams` Map — all replaced by FrameManager events

## Step 5: Unify Entry Points

All frame data enters through `merge()` with events enabled. Remove all
`{ events: false }` and `loadWindow()` calls from the session page.

- [ ] `_loadFrames()`: call `merge(frames)` (events enabled) — `frame:added` handles rendering. Remove manual rendering loop.
- [ ] `_loadOlderFrames()`: call `merge(frames)` (events enabled) — `frame:added` handles ordered insertion. Remove manual rendering loop. Keep `_oldestLoadedOrder` tracking from raw API orders.
- [ ] SSE `commit`: already correct (calls `merge(commit.frames)` with events)
- [ ] SSE `frame` fallback: remove (FrameManager is always present)
- [ ] Remove `_placeInteraction()`, `fromHistory` option, `prepend` option — placement is determined by order

## Step 6: Optimistic User Messages

User messages render immediately before the server confirms. The FrameManager
needs to handle adoption of optimistic elements.

- [ ] `_renderUserMessage()` creates element WITHOUT `data-frame-id` (no frame exists yet)
- [ ] When server confirms via SSE (user-message frame arrives), `merge()` adds the frame → `frame:added` fires
- [ ] `frame:added` handler checks: is there an unattributed user element (`[alignment="user"]:not([data-frame-id])`)? If yes, adopt it (set `data-frame-id`, update metadata). If no, create new element.

## Step 7: Bulk Load Performance

Initial load of 100+ frames should not cause 100+ individual DOM insertions
that each trigger layout recalculation.

- [ ] Use `DocumentFragment` to batch DOM insertions during initial load
- [ ] Option A: Listen for `frames:bulk-loaded` event, iterate FrameManager, batch-render into fragment, append once
- [ ] Option B: Use `requestAnimationFrame` coalescing in the `frame:added` handler
- [ ] Choose approach based on testing — measure actual perf before over-optimizing

## Step 8: Cleanup

Remove dead code and bandaids that were symptoms of the broken architecture.

- [ ] Remove `_renderFrame()` (replaced by `_createFrameElement` + event handlers)
- [ ] Remove `_placeInteraction()`
- [ ] Remove `fromHistory` / `prepend` options throughout
- [ ] Remove `_streamingInteraction`, `_streamingContent`, `_streamingHTML`, `_streamingReflection`, `_reflectionText` instance variables (replaced by phantom frame state in FrameManager)
- [ ] Remove `_typingIndicator`, `_typingDots` instance variables
- [ ] Remove the duplicate-check bandaid in `_loadOlderFrames` (no longer needed)
- [ ] Verify all existing tests still pass
- [ ] Puppeteer E2E test: send message, verify agent responds, scroll up, verify history loads correctly

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
