# Plan: `aeor-scrollview` — deterministic lazy history and virtual layout

**Status: ACTIVE DRAFT revision 3 — owner design session incorporated. No
production scroll code changes are authorized beyond the shared component and
Kikx adapter that now consume it.** The original testbed under
`spec/ui/scrollview-testbed/` remains experimental. The server page index and
`frame-page` body endpoint now expose whole-session raw pages, and the Kikx page
source projects each page into display heads with a one-page look-ahead for
boundary tool pairs.

Revision 3 keeps native browser flow but sharpens it into a **container
projection**: consecutive real messages and blank page ranges share containers;
containers always stay in the DOM and merge/split as state changes. Only item
nodes mount/unmount. Every geometry transaction is corrected by a vertical
**focal point** chosen from the surviving content that the mutation displaces.

## 1. Evidence and motivating incidents

### 1.1 Observed failures (2026-10-27)

The owner reported, on the live Kikx thread:

1. lazy loading is unreliable;
2. the viewport jumps badly;
3. it does not always reach/keep the end-turn frame visible;
4. scrolling freezes/glitches;
5. a short thread sometimes refuses to scroll;
6. there is no loading indicator while lazy history is fetched.

Live UmbraLink profiling reproduced the mechanism behind the worst typing
symptom: `syncSessionShell()` missed the unified topbar's active crumb, returned
`false`, and every `session.saved` rebuilt the entire shell. Measured full-shell
renders were **107–146 ms**, replaced the composer, and lost focus. That is fixed
in Kikx `990739d`. Frame reconciliation still measured **44–55 ms** when a new
agent frame arrived, and `syncFrameThread({force:true})` re-rendered every frame
item (138 item renders; ~80 ms wall). Typing deferral and force removal reduce
that exposure, but the scroll architecture remains a collection of competing
owners:

- `kikx-frame-scroll.mjs` (762 lines) owns snapshots, focus, sentinels, older/
  newer paging, easing, flags and shell-sync decisions.
- `scroll-focus.mjs` (226 lines) owns a second focus/pending-alignment model.
- `frame-scroll-anchor.mjs` (104 lines) owns a third anchor model.
- `kikx-frame-scroll-lock.mjs` (429 lines) owns a fourth lock/animation model.
- `kikx-chat-view.mjs` owns a fifth render-window model.
- `kikx-frame-item.mjs` changes its own height asynchronously as Markdown,
  thinking, tool output and disclosures settle.
- `syncSessionShell()` and `_requestRender()` can still replace the whole shell.

A scroll event can therefore mutate state that another owner later “corrects”,
with several `requestAnimationFrame`/ResizeObserver loops and hash updates in
between. The result is exactly the observed jump/pin/cutoff behavior.

### 1.2 Current paging facts

- `GET /api/v1/sessions/:id/frames` returns projected **message heads**, with
  `before`/`after` raw-frame order cursors, `oldestOrder`, `newestOrder`,
  `total` (raw frame-file count), `hasMore`, and `hasMoreNewer`.
- The client stores projected head objects in `framesBySessionID`, capped by
  `MAX_STORED_FRAMES`; `sessionPagingByID` carries cursors and flags.
- Older pages are prepended; when the stored window overflows the **newest** end
  is trimmed and `hasMoreNewer` is set.
- The thread renders a bounded window of heads (currently 120 by default), with
  a separate sentinel and scroll handlers.
- `total` is raw frames, not heads. There is no authoritative **total head
  count** available to the client, so a virtual scrollbar cannot know its true
  extent today.

### 1.3 Existing plan

The historical `docs/history/plans/completed/session-history-lazy-loading.md`
records the original P0/P1/P2 paging contract. It is a useful baseline but does
not define a single scroll owner, virtual layout, anchor semantics, loading UX,
or unresolved-load behavior. This campaign supersedes its client scrolling
assumptions while preserving the server cursor contract unless a later decision
changes it.

## 2. Territory

### 2.1 Server

- `src/server/routes/session-routes.mjs` — `/frames` window route.
- `src/core/runtime/frame-runtime-frames.mjs` — `listFrameWindow` pass-through.
- `src/core/aeordb/frame-store-preview.mjs` — cursor seek, read, projection,
  `total`, `oldestOrder`, `newestOrder`, `hasMore`, `hasMoreNewer`.
- `src/core/aeordb/frame-store-commit.mjs` — frame order and commit path.
- `src/core/frames/frame-manager` — `projectFrameMessages` and head collapsing.
- `src/client/state/session-state-utils.mjs` — stored window, prepend/merge,
  trimming, paging metadata.
- `src/client/components/kikx-data.mjs` — window fetch, merge, older/newer loads.

### 2.2 Client scroll and render

- `kikx-frame-scroll.mjs`, `scroll-focus.mjs`, `frame-scroll-anchor.mjs`,
  `kikx-frame-scroll-lock.mjs`, `kikx-scroll-lock.mjs`.
- `kikx-chat-view.mjs` — full/mini render windows and frame-item creation.
- `kikx-frame-item.mjs` — asynchronous height changes and item reconciliation.
- `kikx-app.mjs` / `kikx-shell-builders.mjs` — shell render, composer focus,
  snapshot/restore.
- `kikx-runtime-events.mjs` — coalescing, visibility drain, thread sync.
- `kikx-navigation.mjs` — deep links, hash restore, session transitions.

### 2.3 Framework and browser

- Aeor checkout: `/home/wyatt/Projects/aeor-web-components`.
- New generic component: `aeor-scrollview` (light DOM, ordinary ES module).
- Browser targets: current Umbrafox/Firefox and Chromium (Chrome CDP 9224/9230).
- Cross-browser risks: fractional `scrollTop`, scrollbar width, zoom, touch
  momentum, `scrollend` support, ResizeObserver timing, hidden-tab rAF pause.

### 2.4 Tests and instruments

Existing specs: `spec/client/frame-scroll-sync-spec.mjs`,
`frame-scroll-anchor-spec.mjs`, `scroll-lock-spec.mjs`,
`frame-render-containment-spec.mjs`, `streaming-render-bound-spec.mjs`,
`hidden-tab-frame-queue-spec.mjs`, `spec/ui/puppeteer/frame-bottom-scroll-puppeteer.mjs`,
`spec/ui/playwright/...`, and the `spec/ui/scrollview-testbed/` testbed.

## 3. Goals, non-goals, success criteria

### Goals

1. One owner for scroll position, layout, lazy loading, anchoring and follow.
2. Native browser flow with a stable total-height **estimate** before all
   history loads: chunks are real, gaps are one spacer each.
3. Loaded pages split gaps and replace estimates without moving the content the
   user is looking at (or while the user is intentionally following the tail).
4. A deterministic bottom state: the end-turn frame is fully visible when it
   fits; tall frames top-align and remain scrollable; no cutoff.
5. Visible loading, retry and “no more” states for both directions.
6. Short threads can trigger older-page loading without requiring a scrollbar.
7. Scroll and frame reconciliation never rebuild the composer or shell.
8. 60/120 Hz scrolling with no unexplained jumps and bounded main-thread work.

### Non-goals

- Changing message projection semantics or tool call/result collapsing.
- Replacing server storage or the frame-order contract.
- A general-purpose virtual DOM or React-like renderer.
- Animating native user scrolling. The component owns 250 ms animation for
  programmatic writes and page-entry visuals; native wheel/touch/scrollbar drag
  remains native.
- Horizontal scrolling in v1. The page/gap model is vertical-only until the
  axis contract is separately designed.
- Rewriting frame content renderers or Markdown.
- Cross-host deployment changes in this campaign.

### Success criteria

- Anchor invariant after prepend/measure: the anchor item's viewport offset
  changes by **<= 1 CSS px** unless the user is following the tail. A gap anchor
  preserves its gap-relative offset until a real page lands under it.
- Far jump invariant: jumping from page 3453 to page 56754 loads exactly those
  chunks, leaves one gap, and never loads the intervening history.
- One spacer per contiguous gap, never one DOM node per unloaded message.
- Bottom invariant: when follow is active, the last item's bottom is within
  **1 px** of the viewport bottom after settling; a short last item is visible in
  full; a tall last item is top-aligned.
- Loading indicator appears within **one frame** of a range request and remains
  until success/error/no-more.
- No full shell rebuild during scroll/lazy-load/measure.
- No `scrollTop` write without a declared intent (`follow`, `restore-anchor`,
  `jump-to-page/key`, `place-last-frame`).
- Short threads load older pages when the user wheels/touches at the top even
  when `scrollHeight <= clientHeight`.
- Testbed passes the scenario matrix in §12 on Firefox and Chromium.

## 4. Core contracts (revision 2: native flow + pages/gaps)

### 4.0 Owner rulings from the design session

- **R1.** `aeor-scrollview` belongs in `aeor-web-components`.
- **R2.** We will add the server metadata needed for page/gap layout.
- **R3.** The virtual unit is projected data (message heads) plus page-level
  estimates, not a database of physical layout.

### 4.1 Layout mechanism decision

Three mechanisms were considered:

1. **Absolute content layer.** One absolutely positioned content div, with every
   item given x/y/width/height. Rejected. It reimplements scrolling, fights
   mobile momentum and native selection/copy, and creates a second layout engine
   that we must keep correct forever.
2. **Native flow with gap spacers (chosen).** Loaded chunks are normal DOM in
   normal flow. Unloaded page ranges are represented by one or more spacer
   elements whose height is an estimate. The browser owns flow, scrollbars,
   selection, focus and mobile scrolling; we own only segment geometry,
   loading, and anchor correction.
3. **`content-visibility: auto` + `contain-intrinsic-size`.** Optional
   browser-side render skipping, not a substitute for data virtualization. It
   can reduce paint/layout for large loaded chunks, but it still needs an
   intrinsic size and has accessibility/find-in-page/copy caveats. It will be
   evaluated only after the native-flow model is correct.

Consequences of the chosen mechanism:

- The scrollview has a top spacer for pages before the first loaded chunk,
  loaded chunk elements in normal flow, a spacer for every unloaded gap, and a
  bottom spacer after the last loaded chunk.
- One spacer represents a **contiguous page range**, never one DOM element per
  message. A 56,000-page gap is one spacer, not 56,000 divs.
- No `position:absolute` for item placement. No transform-based virtual layer.
- `overflow-anchor: none` is required: the component, not the browser's scroll
  anchoring, owns anchor restoration. Native `scrollTop` remains the only
  scroll primitive.

### 4.2 Pages, items, containers, chunks and gaps

- **Page** — a stable server page token covering a bounded raw-frame range
  (or, later, a projected-head range). A page contains zero or more projected
  heads. A page token, not a mutable numeric offset, is the primary cursor.
- **Item** — one projected message head inside a page. Items can be mounted
  (real DOM) or unmounted (state only, with a known measured height).
- **Page height** — for a loaded page, its measured height; for an unloaded
  page, an estimated height derived from page statistics.
- **Container** — the persistent DOM unit. A container represents a contiguous
  range of pages and is always present in the scrollview. It has a height equal
  to the sum of its page heights (measured and/or estimated) and may contain
  mounted item elements. Consecutive real messages and consecutive blank pages
  merge into the same container. Consecutive **different materialization states**
  do not merge by default, because a loaded page may need to split the container
  to insert its messages.
- **Chunk** — a contiguous run of loaded pages inside a container. A chunk may
  have mounted messages or may have been reduced to measured height after its
  messages became stale.
- **Gap** — a contiguous run of unloaded pages inside a container. Its height is
  the sum of per-page estimates.
- **Container projection** — the DOM is a projection of the in-memory page map.
  Containers never “go out of view” and never need mounting: when messages are
  dropped as stale, the container remains, its height becomes measured/estimated
  and it may merge with a neighboring blank container. When a page loads, a
  blank container splits around the new chunk. The DOM is always the minimal
  merged representation of the current page map.

```
page map (state)             DOM projection
[pages 1..40]     ────────▶  blank container (estimated height)
[page 41 loaded]  ────────▶  container with mounted messages
[pages 42..100]   ────────▶  blank container (estimated height)
[page 101 loaded] ────────▶  container with mounted messages
[pages 102..]     ────────▶  blank container (estimated height)
```

One container may summarize thousands of pages. The container is the stable
focal DOM node; item nodes inside it are what mount/unmount.

### 4.3 Container layout model (pure, no DOM)

`ContainerLayout` owns:

- `pages`: page token/index → `{ state: loaded|unloaded, measuredHeight?,
  estimatedHeight, itemCount, itemsMounted? }`.
- `containers`: ordered DOM projection containers, each with a page range,
  height ledger (per-page measured/estimated heights), and optional mounted
  item list.
- `offsetOfContainer`, `totalHeight`, `containerAtOffset`.
- `focalPoint(scrollTop, viewportHeight, mutationRange)`: chooses the surviving
  content whose screen position matters most. The owner's rule is: **keep the
  element the user is staring at from shifting**, using concrete attention
  signals before falling back to viewport center. Priority:

  1. **Active DOM focus** inside a mounted item/container, when the focused
     element intersects the viewport or is partially visible. The scrollview's
     own viewport focus does not count.
  2. **Non-collapsed text selection** whose anchor/focus node belongs to mounted
     content. If both ends are visible, use the end nearer the viewport center;
     if only one is visible, use that end.
  3. **Pointer position** over mounted content, only when it is stable: the
     pointer has been inside the viewport and stationary for at least 250 ms, no
     pointer button is down, and there is no stronger focus/selection signal.
     Resolve to the nearest item/container under the pointer, not an arbitrary
     nested text node.
  4. **Viewport center** fallback: mounted content whose visual rectangle
     contains or is nearest the center; prefer a mounted item over a container
     edge, and loaded content over a blank container when distances tie.
  5. If the mutation changes the height of the block the user is reading, that
     block's mounted top/visible rectangle still wins when it is the selected
     candidate.
  6. If no mounted content is near the center, the nearest surviving container
     edge (a blank/gap edge is valid).
  7. If the mutation is entirely above the viewport and nothing near center is
     mounted, the topmost surviving content below the mutation.
  8. unresolved → do not write scroll.

Tie-break deterministically, in order: smaller distance to viewport center; then
loaded content before blank; then topmost rectangle; then document order; then
stable page/item key. The tie-breaker exists so two runs of the same state choose
the same focal point.

The explicit focus/selection/pointer signals are **attention overrides**, not
additional geometry models. They select the same focal object the center rule
would otherwise have to guess. If the override target is unmounted or does not
intersect the viewport, fall back to the center rule. If the selected focal point
does not survive the mutation, re-resolve to the nearest surviving container edge
before writing scroll.

This rule covers two loaded chunks on opposite sides of a gap after a viewport
resize: choose the chunk whose content is closest to the viewport center. It also
covers two disjoint mutations in one batch: one focal point is selected by the
same rule; the other side is allowed to move.
- `splitContainer(containerID, pageIndex, loadedPage)`: replace one container
  with `before | loaded chunk | after`, preserving the height ledger and the
  focal point.
- `mergeContainers(left,right)`: merge adjacent blank containers; sum heights.
- `mergeChunkIntoBlank(chunk)`: when all its messages become stale/unmounted,
  replace its item DOM with its measured height and merge with adjacent blanks.
- `updateMeasuredPage(pageIndex,height)`: update the ledger, recalculate the
  container height, and expose the geometry delta.
- `captureFocalPoint` / `restoreFocalPoint`.

The model is pure; DOM projection consumes it. The testbed currently uses an
item-slot model and must be revised to this container/page ledger.

### 4.4 Estimator: pages first, item ratios second

We do not persist item heights. The client derives them:

1. **Page head count.** For loaded pages, record visible heads per page.
   Maintain a per-session rolling `headsPerPage` estimate. Use a robust statistic
   (median or trimmed mean) until a page count threshold; blend toward the mean
   as sample size grows. Keep a global prior for a new session.
2. **Item height ratios.** For loaded items, record measured height by role/type
   (user, agent text, code, compact tool, full tool, question, OCR, end-turn)
   relative to a base height. Store these as ratios in memory, bucketed by
   viewport width (wrap changes height).
3. **Page height.** `estimatedPageHeight = headsPerPage * weightedItemRatio *
   baseHeight + pageChrome`. Use the same estimator for every page in a gap.
4. **Gap height.** `gap.height = gap.pages * estimatedPageHeight`. One spacer.
5. **Correction.** When a page loads, compare measured page height with its
   estimate. Update the estimator with a bounded EWMA; never let one enormous
   tool page set the prior. Keep an explicit per-session `estimateScale` so a
   systematic 10% error is corrected globally without chasing every page.
6. **Width changes.** On viewport width change, discard width-bucket ratios,
   recalculate gaps from the new estimator, and preserve the anchor. Do not
   persist the old bucket.

No database column stores layout. A deletion/edit changes only loaded chunk
heights and the measured statistics; gaps remain derived.

### 4.4a Total height, scrollbar stability and estimator error

The total scroll height is an estimate until pages are measured. When a page's
measured height differs from its estimate:

1. replace that page's chunk height;
2. adjust the **same gap** that the page came from, so the delta is absorbed
   locally where possible;
3. preserve the anchor exactly;
4. never reset the whole viewport or recompute the total from scratch in a way
   that moves the scrollbar thumb unpredictably.

If the gap cannot absorb the delta (it is exhausted or the user is inside it),
the total height changes by the residual. This is allowed and must be bounded:
with the estimator and local absorption, a normal page load should move the
scrollbar by no more than the measured page delta, not by the whole gap. The
component records `estimatedTotalHeight`, `measuredTotalHeight` and
`lastCorrection` in its metrics so the testbed can enforce this budget.

The estimator uses a bounded correction: a systematic bias changes future page
estimates, but no single page can rewrite the global scale by more than a fixed
percentage.

### 4.5 Gap loading and splitting

- The visible page range is computed arithmetically from the segment map and
  viewport (`pageAt(segment, offset)`), not guessed from a DOM sentinel alone.
- Missing pages intersecting the viewport are requested first; adjacent pages
  are prefetched within a one-viewport budget.
- One request per page token; dedupe in-flight and loaded pages.
- When a page lands, `splitGap` inserts a chunk at the correct page position.
  The surrounding gaps shrink by one page each (or disappear). The DOM operation
  is a single batch; the anchor is captured before it and restored after it.
- A gap may be split many times. Adjacent chunks merge. A gap is deleted when
  its page count reaches zero.
- If the user jumps from page 3453 to page 56754, only those two pages are
  loaded. The middle remains one gap with an estimated height; scrolling into
  it loads the page(s) under the viewport.
- Pages with zero visible heads still consume a page token but may have near-zero
  height; do not drop them from the gap accounting.

### 4.6 Focal point and reflow transaction

The focal point is **the surviving content that the mutation moves**. If a page
loads above the viewport and pushes existing content down, the existing content
is the focal point. If a container merges/shrinks above the viewport, the content
below that moves is the focal point. It is not necessarily the top visible item;
it is the content the user’s eyes are already on that must be kept still.

Every geometry mutation is one transaction:

1. Select the focal point **before** changing the container/page map, using the
   attention signals + center fallback in §4.3. Keep that item/container mounted
   for the duration.
2. Record `focalPointOldPosition = focalPoint.getBoundingClientRect().top`
   (or the container edge if no item is mounted).
3. Apply the page/container/DOM change in one batch.
4. Read `focalPointNewPosition`.
5. `amountFocalPointMoved = focalPointOldPosition - focalPointNewPosition`.
   Apply `scrollTop += (focalPointNewPosition - focalPointOldPosition)`, i.e.
   `scrollTop -= amountFocalPointMoved`, in the same task before paint. The sign
   matters: content pushed DOWN (new > old) requires scrollTop to increase.
6. Verify next frame. If the focal point still exists and residual drift is
   > 0.5 CSS px, correct once more. If the focal point was split or removed,
   re-resolve to the nearest surviving container edge; never guess an item that
   no longer exists.
7. If no focal point survives, mark the transaction unresolved and do not write
   scroll.

`overflow-anchor: none` on the viewport and every container prevents the browser
from competing with this correction. The component never writes `scrollTop` from
an unbounded ResizeObserver loop; all geometry changes coalesce into one
transaction per frame.

**Side-by-side content:** vertical focal-point correction only guarantees the
vertical offset of the moved block. If two blocks sit side-by-side and one changes
height, the other may not move vertically; that is acceptable. The focal point is
chosen from the block that actually moves, not an arbitrary top-of-viewport node.

**Gap focal points:** a blank container has no item to measure. Use its top/bottom
edge as the focal point and preserve its gap-relative offset. When a page lands
inside it, convert to the nearest mounted item/container edge and continue the
same transaction.

### 4.7 Scroll intents

Every scroll write carries one intent:

- `initial-tail` — first load; place the newest page once.
- `follow-tail` — keep the newest page at the bottom as content grows.
- `restore-anchor` — preserve the item/gap under the user's eyes.
- `jump-to-page` / `jump-to-key` — explicit navigation; pending until the target
  page is loaded and measured.
- `place-last-frame` — a new last item must be fully visible.
- `user-scroll` — native user movement; never “correct” it.

An intent has a generation token; a stale page/measure callback cannot write
scroll after a newer intent.

### 4.8 Follow, pinning, focus ownership and axis

The scrollview has three explicit scroll modes:

- **free** — the user scrolls; the component never writes scroll except for a
  page geometry correction, and only through the focal transaction;
- **follow-tail** — the newest page is pinned to the bottom; new pages,
  measurements and rapid-fire appends retarget the 250 ms scroll animation;
- **pinned** — an explicit page/item anchor is held at a chosen alignment;
  geometry changes animate back to that anchor. Kikx's manual scroll lock maps
  to this mode; it is not a separate scroll owner.

User input always cancels a programmatic animation and moves to `free` unless
follow-tail is re-armed at the exact bottom. Pinned mode is changed only by an
explicit user action or a newer navigation intent. Focus, text selection and
pointer attention override the focal choice (§4.3) but do not change the mode.

The scrollview must not focus itself during scroll, page load or animation.
Keyboard handling applies only when the viewport itself owns focus. Page
insertion and focal correction must preserve the active composer/input focus and
selection; use `preventScroll` when focusing controlled UI.

v1 is vertical-only. Horizontal scrolling is a separate design; do not infer it
from the same page/gap model.

### 4.8a Follow and bottom placement

- `follow = true` means the tail chunk is pinned to the viewport bottom.
- A real user upward gesture > 4 px breaks follow. Layout-driven `scrollTop`
  changes do not.
- Reaching the bottom with a real gesture re-arms follow.
- Sending a message sets `follow=true` + `place-last-frame`.
- Short last item: target `maxScrollTop`, so its bottom sits at the viewport
  bottom.
- Tall last item: target `offsetOf(lastItem)`, so its top is at the viewport top
  and the user can scroll through it.
- Never clamp a new last item to the old maximum before its measured height is
  known; keep the placement pending until entry animation clears and the height
  is stable for two frames.

### 4.9 Loading and status contract

Page requests are idempotent by page token. States per direction:
`idle | loading | error | exhausted`. The component shows fixed overlay rows,
not in-flow status blocks, so status text never changes virtual geometry:

- top: “Loading older messages…”, “Older messages unavailable — Retry”,
  “Beginning of conversation”.
- bottom: “Loading newer messages…”, “Newer messages unavailable — Retry”,
  “You’re at the latest message”.
- `aria-busy` while loading; status rows are announced once, not per progress.
- A failed page leaves loaded chunks, gaps, anchor and composer intact.

### 4.10 Selection, copy, accessibility and mobile

- Native flow preserves browser selection/copy for loaded content. Gaps are not
  selectable content; “select all” selects loaded items only, which must be
  stated in the component docs. This is preferable to absolute layout breaking
  selection entirely.
- Loaded items expose `role="listitem"`, `aria-posinset`/`aria-setsize` when
  known. Gaps expose a non-focusable status/hint.
- Keyboard PageUp/PageDown/Home/End scroll natively; Home/End map to page
  boundaries, not a full-history load.
- Touch momentum is native. Never cancel a touch scroll to perform a layout
  correction; queue the transaction until the scroll settles or the anchor is
  resolved.
- Do not use `content-visibility` on the scroll container; evaluate it only for
  very large loaded chunks.

## 5. Component design (revision 2)

### 5.1 Public custom element: `<aeor-scrollview>`

Light DOM, ordinary ES module, no Shadow DOM. It is generic: it knows pages,
chunks, gaps, estimates and anchors, not Kikx frames.

Attributes:

- `overscan` (number, viewport multiples)
- `follow` (`"true"`/`"false"`)
- `loading-top`, `loading-bottom`
- `has-more-top`, `has-more-bottom`
- `empty-label`, `top-loading-label`, `bottom-loading-label`

Properties/methods:

- `source` — page source contract (§5.2).
- `segments` — read-only segment map snapshot.
- `captureAnchor()` / `restoreAnchor(anchor)`.
- `scrollToPage(pageToken,{align})` / `scrollToKey(key,{align})`.
- `setFollow(value,{reason})`.
- `loadPage(pageToken)` / `retry(direction)`.
- `notifyPageChanged(pageToken)` / `notifyItemChanged(key)`.
- `metrics()`.

Events:

- `scrollview-page-request` `{pageToken, direction, reason}`
- `scrollview-page-loaded` `{pageToken, measuredHeight, estimatedHeight}`
- `scrollview-anchor-change` `{anchor}`
- `scrollview-follow-change` `{follow, reason}`
- `scrollview-state` `{loadingTop, loadingBottom, hasMoreTop, hasMoreBottom, error}`

### 5.2 Page source contract

```js
{
  pageSize: number,              // raw frames per page, stable
  totalPages: number,
  totalItems: number,
  pageToken(index): string,      // stable token for page index
  pageIndex(token): number,
  loadPage(token): Promise<{
    token, index, items,         // projected heads, may be []
    measuredHint?: number,
    hasMoreBefore, hasMoreAfter
  }>,
  renderItem(item, {index}): HTMLElement,
  updateItem(node, item, {index})?: void,
  estimatePageHeight(pageIndex, stats): number,
}
```

The component never asks for “all items”. It asks for pages.

### 5.3 Internal DOM

```
<aeor-scrollview>
  <div class="aeor-scrollview__top-status" role="status"></div>
  <div class="aeor-scrollview__viewport" role="list" tabindex="0">
    <div class="aeor-scrollview__top-spacer"></div>
    <!-- chunk: normal flow, data-page-start/end -->
    <div class="aeor-scrollview__chunk">...items...</div>
    <!-- gap: one spacer, data-page-start/end -->
    <div class="aeor-scrollview__gap" aria-hidden="true"></div>
    <div class="aeor-scrollview__chunk">...</div>
    <div class="aeor-scrollview__bottom-spacer"></div>
  </div>
  <div class="aeor-scrollview__bottom-status" role="status"></div>
</aeor-scrollview>
```

Spacers/chunks are normal flow. The top/bottom status rows are absolutely
positioned overlays so their appearance never changes scrollHeight.

### 5.4 Container projection and merge/split

- Containers are keyed by a stable range identity and remain in the DOM. They are
  not mounted/unmounted as a unit; their internal item nodes mount/unmount.
- A container’s height is the sum of its page ledger (measured where known,
  estimated otherwise). Blank containers can summarize thousands of pages.
- When a page lands inside a blank container, split it into
  `blank-before | loaded chunk | blank-after`; the loaded chunk may contain
  mounted item DOM. Do not replace the whole scroll content.
- When a loaded chunk’s messages become stale and are dropped from view, remove
  the item nodes, set the chunk container’s height to its measured height, and
  merge it with adjacent blank containers. The container never disappears just
  because its messages were unmounted.
- When adjacent containers have the same materialization state (e.g. two
  unloaded blanks), merge them. When a loaded chunk needs to remain addressable,
  keep it as its own container until its messages are stale.
- No item outside the visible/overscan containers is mounted. The retained
  message budget is bounded by:
  1. total loaded/mounted messages (memory),
  2. total mounted rendered items (render),
  3. likely scroll proximity (retention prediction).
  A far-off loaded chunk may be reduced to a measured container; it does not
  accumulate DOM.
- The focal point message/container is always retained during a transaction.
  Stale eviction never runs during a user scroll gesture.

### 5.4a Container projection, not mount/unmount

The projection is deterministic from page state:

```
pages:    [unloaded 1..40][loaded 41][unloaded 42..100][loaded 101][unloaded 102..]
containers: [blank 1..40][chunk 41][blank 42..100][chunk 101][blank 102..]
```

If the messages for page 41 are dropped as stale, page 41 becomes
`loaded-unmounted` with a measured height. Its container becomes a blank
container whose ledger is `[measured page 41]`; it then merges with neighboring
blank containers. The DOM shrinks to the minimal projection; no container
“leaves the viewport” and no container needs remounting.

Mounted item nodes are the only things that mount/unmount. The container is the
stable focal DOM node for geometry correction.

### 5.5 Loading trigger

- Compute visible page range from the segment map and scroll position.
- Request missing pages intersecting the viewport first, then one viewport of
  prefetch in the scroll direction.
- Use `IntersectionObserver` on gap-edge sentinels for edge prefetch and for
  short threads that do not fill the viewport; use arithmetic page intersection
  as the authoritative trigger. IO is an optimization, not the only trigger.
- Dedupe by token. A page request never spans a gap.
- Page requests carry the `inputEpoch` and `pageEpoch` at dispatch. A result
  whose page token is already loaded is ignored. If the user moved away before
  the result arrived, store the page in the page cache and **defer the DOM
  commit** until the gesture settles; do not insert a page and animate scroll
  under an active gesture.
- If the current input epoch is still the one that requested the page, commit
  the page with the normal focal transaction. If the page no longer intersects
  the viewport, it may be committed as a measured/unmounted container without a
  scroll write.
- Abort network work with an `AbortController` where the source supports it.
  Aborting a request must leave the gap and page map intact; a later retry uses
  the same stable page token.
- A short thread with no scrollbar still triggers adjacent pages on wheel/touch
  at the top/bottom.

### 5.5a Lifecycle, session switch and invalidation

- Disconnect cancels the page-load debounce, in-flight AbortControllers,
  animation rAF token, observers, timers and any pending focal/jump/page intent.
- A session switch is a new page source and generation: cancel everything,
  discard the old segment map, and start from the new initial mode. Do not carry
  a page token, anchor, animation target or request epoch across sessions.
- A page-index/filter invalidation increments `pageEpoch`; in-flight page
  results and worker plans from the old epoch are dropped.
- Page data eviction is independent of DOM eviction: a page may be measured and
  unmounted while its item bodies remain cached; when the cache budget is
  exceeded, drop non-anchor item bodies and reload on demand. Never drop the
  focal/anchor page or its measured height without a new anchor.
- Visibility change: settle or cancel a programmatic animation, flush pending
  page acceptance, and never leave a `requestAnimationFrame` loop armed forever.


- Observe chunk elements with `ResizeObserver`; item changes bubble to the chunk
  height. Update the segment height, recalculate gap spacers, restore anchor.
- Do not observe every item separately unless item-level measurement is needed
  for statistics.
- Batch all geometry writes in one rAF/observer callback.
- If the viewport is in a gap, an anchor is `{gap, relativeOffset}`; splitting
  the gap preserves that relative position until a real chunk is under it.

### 5.7 Commit pipeline: one clean-shot DOM update and optional worker projection

The lazy-load jolt has two separate causes and therefore two separate fixes.

**A. Main-thread commit cost.** A page load must not rebuild the entire segment
tree. It must patch only the affected gap:

1. Build the new page chunk and its 20–40 item nodes in a detached
   `DocumentFragment` (or in an idle task before the page is needed).
2. Capture the focal point.
3. Replace the single gap element with `before-gap | page-chunk | after-gap` in
   one DOM operation.
4. Force one layout read after all writes (`scrollHeight`/chunk rect).
5. Apply the focal correction in the same task.
6. Verify once on the next frame; do not re-render the whole scroll view.

No `innerHTML` rebuild, no re-creating existing page/gap elements, no second
measurement pass that triggers another render. The prototype currently rebuilds
its segment list and moves every segment node on each page load; that is the
first thing to remove.

**B. Pure projection math.** The page ledger, gap offsets, visible-page range,
estimator statistics, and focal target can run in a module Web Worker. The worker
never touches DOM and never measures layout. The main thread sends page state
changes and measured page/chunk heights; the worker returns a `LayoutPlan` with
segment offsets, the minimal DOM patch, and the focal target. The main thread
remains the sole owner of DOM reads, measurements and scroll writes.

Worker protocol:

```
main → worker: {
  type:'query',
  planID,
  inputEpoch,        // increments on every wheel/touch/key/pointer/scroll input
  pageEpoch,         // increments on every page/container mutation
  requestedAt,
  scrollTop,
  viewportHeight,
  pages:[...],
  measuredHeights:{...},
  focus:{...}
}
worker → main: {
  type:'plan',
  planID,
  inputEpoch, pageEpoch,
  patch:{ replaceGap, insertChunk, mergeLeft?, mergeRight? },
  offsets:{...}, focal:{key,index,expectedTop},
  visiblePages, loadingPages
}
```

Use a generation token on every message. Ignore stale worker plans; a plan that
does not match the current page generation may not write scroll.

If Workers are unavailable or the session is small, run the same pure functions
on the main thread with a time budget. Worker projection is an optimization, not
a correctness dependency.

**C. Prewarming.** Load the page one viewport ahead of the user, and when idle,
build its detached chunk DOM before it is needed. Do not insert it until the
viewport reaches it. This moves item construction out of the critical scroll
path. A hidden staging container may be evaluated for measuring real page height
before insertion, but it is not the default: hidden layout is still main-thread
layout and may itself jolt.

**D. Page size.** Page size is a latency/jolt knob. Smaller pages commit faster
but produce more requests and more gaps. The testbed must measure 10/20/40-item
commits and choose a default with a commit budget (target: page commit ≤ 8 ms
main-thread work on the reference machine, never > 16 ms without a documented
exception).

**E. What cannot move off-thread.** Text layout, ResizeObserver measurements,
scrollTop writes and native selection are main-thread. Do not promise a
worker-only lazy load. The worker removes arithmetic and planning from the
critical path; the clean-shot patch removes the DOM churn.

### 5.7a Asynchronous plan ordering and cancellation (latency is an input)

A worker/WASM plan is **not** a command. It is a proposal computed from a
snapshot that may already be stale. The scrollview must treat event order and
input latency as first-class correctness inputs.

**Epochs**

- `inputEpoch` increments immediately on every real wheel, touch, pointer,
  keyboard, or scroll gesture. Bump it in the input event, not when the delayed
  `scroll` event arrives. Our own programmatic `scrollTop` writes do not bump it.
- `pageEpoch` increments on every page/container mutation (page load, eviction,
  merge/split, filter change).
- Every query carries both epochs plus `requestedAt`; every plan echoes them.
- A plan may apply only when **both** epochs still match. If either changed, drop
  the entire plan; do not apply half (patch without scroll, or scroll without
  patch). Store the page data; request a fresh plan from current state.

**User input wins**

- On any user scroll after a plan was requested, cancel any pending scroll
  correction derived from that plan. The new input epoch makes the plan stale by
  definition.
- Never apply a scroll target computed for an older `scrollTop`, even if the
  target is “close.” There is no fuzzy acceptance for a plan whose input epoch
  changed.
- During touch momentum, do not write scroll from a plan. Either wait for the
  gesture/momentum to settle or discard the plan and recompute. Layout patches
  may be prepared off-thread but must not move the viewport under the finger.

**One outstanding plan**

- Coalesce queries: keep at most one in-flight plan per scrollview, plus at most
  one queued latest snapshot. If the user scrolls while a plan is in flight,
  discard the result and queue the latest state.
- A plan result older than the current `planID` is ignored.
- Worker/WASM work may be cancelled cooperatively between chunks. A worker
  result that arrives after cancellation is still checked against epochs.
- `SharedArrayBuffer`/`Atomics` may carry a cancellation epoch for WASM, but the
  message-level epoch check remains mandatory.

**Two-phase commit**

- If the plan is current, apply its DOM patch first.
- Re-read the focal point from the live DOM after the patch.
- Only then apply the scroll correction. If the focal point cannot be resolved,
  do not write scroll and mark the transaction unresolved.
- Verify next frame; a user input before verification cancels the correction.

**Priority**

Event priority is explicit:

1. user input and native scroll;
2. scroll correction for the current generation;
3. DOM patch for a loaded page;
4. page prefetch/prewarm;
5. estimator/statistics updates.

The main thread may do a synchronous fallback plan for a small session or when
the worker misses a frame budget. The fallback obeys the same epochs and the same
cancellation rules.

**Tests**

- Delay a worker plan response, scroll the wheel in between, assert **no**
  scroll write from the stale plan.
- Change page state while a plan is in flight; assert the whole plan is dropped.
- Deliver two plans out of order; assert only the newest generation applies.
- Touch momentum with a pending plan; assert scroll is not written until
  settled, and the plan is recomputed from the settled position.
- Fake a 50/150/500 ms worker latency; assert input remains responsive and the
  UI never jumps.

### 5.8 Page-load debounce and scroll animation

#### Page-load debounce

Scrollbar dragging produces a continuous stream of viewport positions. Requesting
a page for every intermediate position is wrong; it floods the server and makes
the UI feel busy. Page requests must be **settled-position** requests.

- `scroll`/wheel/touch/pointer movement updates `inputEpoch` and clears any
  pending page-load timer. It does not request a page while the user is actively
  moving.
- After a quiet period (`pageLoadDebounceMs`, default 150 ms; tune 100–250 ms),
  compute the visible page range from the final position and request only that
  page plus at most one adjacent prefetch page.
- If `scrollend` exists, use it as an additional signal, not the only one.
  Fall back to the debounce timer.
- Deep links, initial open, short-thread fill and an explicit “load this page”
  action bypass the debounce because they are not scrollbar-drag streams.
- While dragging, show a subtle “Release to load older/newer” or loading
  placeholder only if the current position is inside an unloaded gap; do not
  request intermediate pages.
- Cancel the timer on wheel/touch/pointer/key input; a new settled position
  schedules a new timer. Only one debounce timer exists per scrollview.
- Track `stalePageRequests` in metrics: a request whose input epoch changed
  before it was dispatched must never be sent.
- Test: 50 rapid scrollbar-position changes must produce **at most two** page
  requests (the final visible page plus adjacent prefetch), not dozens.

#### New page insertion animation

A newly inserted page chunk must not flash into place. In addition to the scroll
animation, every newly created page chunk gets a **250 ms entry animation**:

- opacity `0 → 1`;
- small vertical translate (12 px, direction-aware if needed);
- no height transition — the real measured height is inserted once, then the
  focal/scroll correction animates;
- `prefers-reduced-motion` disables the entry animation;
- existing page chunks are never re-animated or rebuilt on append;
- an incremental append must use `appendItem`/patch, never a full source reset
  (`setSource`) that destroys and recreates the view.

The testbed's “Append page” control was resetting the entire source and therefore
flashed. It now appends incrementally and the new page chunk animates.

#### Why scroll-position animation must be JavaScript

The scroll position itself cannot be animated correctly with CSS for this
component. The JS animation is not a convenience; it is part of the correctness
model.

- CSS `scroll-behavior: smooth` is browser-owned. It does not guarantee a fixed
  250 ms duration, a specific easing curve, exact final position, retargeting, or
  cancellation semantics. It also applies to writes we do not want animated.
- CSS scroll-driven animations (`animation-timeline: scroll()`) react to scroll;
  they do not drive `scrollTop`.
- Scroll snap changes resting positions; it does not animate a scroll from A to
  B or preserve a focal transaction.
- WAAPI can animate transform/opacity on a content layer, but that is the
  absolute/transform virtual layout already rejected. Animating a proxy layer
  fights native scroll, selection and mobile momentum.
- CSS transitions cannot observe the input epoch, page generation, measured
  height, worker plan or focal transaction. They cannot cancel and retarget from
  the current position on a wheel event.
- Worker/WASM can calculate the target and the plan, but the actual scroll write
  must happen on the main thread through `requestAnimationFrame` (with a
  visibility/setTimeout fallback). There is no off-main-thread `scrollTop`.

Therefore:

- one JS animation owner is mandatory for all programmatic scroll writes;
- exact 250 ms duration and exact final target are JS guarantees;
- CSS remains appropriate for non-scroll visual entry (opacity/transform of a
  page chunk), but never for scroll position;
- hidden tabs may pause rAF, so an animation must snap/settle on visibility
  change rather than remain pending indefinitely;
- reduced motion bypasses the JS animation.

#### Scroll-position animation

**Owner ruling: every programmatic scroll position change uses a 250 ms
animation.** This supersedes the earlier explicit-jumps-only rule.

- `SCROLL_ANIMATION_MS = 250`.
- "All" means all programmatic `scrollTop` writes owned by the scrollview:
  page jumps, deep links, bottom-follow, focal corrections, anchor restoration,
  page-load geometry corrections and container merge/split corrections.
- Native user scrolling (wheel, touch, scrollbar drag, keyboard) is not
  intercepted or animated. The browser owns that movement.
- `scroll-behavior` remains `auto`; do not use CSS smooth scrolling because it
  would animate native/user movements and cannot be cancelled precisely.
- Implement one JS animation owner. Every programmatic write starts or retargets
  the same 250 ms eased animation from the current position. A new target within
  the window cancels/replaces the previous animation; do not stack animations.
- The animation has a generation token. Wheel/touch/pointer/keyboard input cancels
  it immediately and the user’s native position wins. Do not restart a
  correction animation during an active gesture.
- Also cancel on a `scroll` event whose `scrollTop` differs from the last value
  written by the animation by more than 1 px. That is the scrollbar-drag / native
  scroll path where a pointer event may not reach the viewport listener. On
  cancellation, clear the pending page intent and the programmatic-write guard
  so the user’s position is authoritative.
- Page-load transactions capture the focal point, apply the DOM patch, then
  animate the focal correction over 250 ms. This means content eases into place
  instead of snapping; it must never start from a stale scroll position.
- Follow-tail retargets the animation to the newest bottom on each new frame or
  measurement. Streaming updates coalesce; only one animation runs.
- If `prefers-reduced-motion` is set, use an immediate write. If the scrollview
  is hidden or the target cannot be resolved, do not animate.
- Tests must cover: all intent types use exactly 250 ms; retargeting; user
  interruption mid-animation via wheel, touch, pointer and native scroll drift;
  focal correction animation; follow-tail retargeting; reduced motion; hidden
  tab.

### 5.9 Extension API: callbacks first, protected OOP seams second

`aeor-scrollview` is generic, so product-specific data, rendering, estimates and
container policy must be supplied from outside. The recommendation is a
**composition-first API with a small protected OOP surface**, not a large
inheritance hierarchy and not a god-config object.

### Required source callbacks

The consumer provides a page source (a plain object, not a subclass):

```js
{
  pageSize,
  totalPages,
  pageToken(index),              // stable token
  pageIndex(token),
  loadPage(token, { signal, generation }): Promise<PageResult>,
  renderItem(item, { index, signal }): HTMLElement,
  updateItem?(node, item, { index }): void,
  estimatePageHeight?(pageToken, { stats, viewportWidth }): number,
  estimateItemHeight?(item, { stats, viewportWidth }): number,
}
```

The component owns page state, container merge/split, geometry, anchoring,
scroll writes and DOM mounting. A callback may provide content and estimates; it
may **never write `scrollTop`, mutate the container tree, or own the page map**.

### Optional behavior callbacks

A separate `behavior` object carries policy, with defaults supplied by the
component:

```js
{
  kindForPage?(page, context),                 // optional semantic label only
  canMergeContainers?(left, right, context),   // may narrow, never expand geometry
  renderChunk?(container, context): HTMLElement|null,
  renderGap?(container, context): HTMLElement|null,
  estimatePageHeight?(page, stats, context),
  onPageLoad?(event),
  onPageError?(event),
  onLoadingChange?(event),
  onStatsChange?(stats),
  animationDuration?(): number,                // default 250, owner policy
}
```

`renderChunk`/`renderGap` customize the inside of a container, not its height or
position. The component wraps the result and owns the measured height.

### Protected OOP seams

Export the class and document a small protected surface for advanced consumers:

- `captureFocalPoint(context)`
- `resolveFocalPoint(plan, context)`
- `estimatePageHeight(page, stats)`
- `createPageChunk(page, items)`
- `createGap(pageRange)`
- `onPageCommit(transaction)`
- `onPageLoadState(state)`

These are **versioned protected APIs** (semver), not public subclass requirements.
Subclassing is appropriate when a product needs to change the projection policy
itself. Ordinary consumers should compose callbacks and never need a subclass.

### Why not callbacks for everything

- Container geometry must have one owner. A callback that “defines a container”
  by returning arbitrary DOM/height would let consumers reimplement the scroll
  layout and reintroduce the bugs this component exists to eliminate.
- A giant options object with dozens of callbacks is hard to validate and test.
  Use `source`, `behavior`, and events as three named surfaces.
- Callbacks can be async and stale. Every callback receives
  `{ signal, inputEpoch, pageEpoch, generation }`; results from an older token are
  ignored. Render callbacks are synchronous; load/estimate callbacks may be
  async.
- Worker projection cannot serialize callbacks. The worker receives derived page
  state and stats, not functions. Main-thread callbacks build DOM and supply
  estimates; the worker computes geometry only.

### Why export the class anyway

- Custom elements are classes; exporting the base preserves the option to
  subclass for a product-specific projection without forking the component.
- Tests can instantiate a subclass with deterministic timing.
- A consumer that needs a different focal policy can override one protected
  method while retaining page loading, DOM patching and animation ownership.
- Subclasses must register their own tag; the base `aeor-scrollview` remains the
  default and is not monkey-patched.

### API rules

1. No consumer callback may write scroll or mutate container geometry directly.
2. Every callback result carries a generation/epoch and may be discarded.
3. Defaults exist for every optional behavior callback.
4. Source/render callbacks are main-thread; pure estimators may run in a worker.
5. Protected methods are documented and semver-versioned; private internals are
   not part of the contract.
6. The same source contract must support the Kikx adapter, a lorem testbed and a
   non-chat generic list.

### 5.10 Configuration is its own category

The previous API discussion mixed three different things. The component needs a
separate, small **configuration** surface for scalar, serializable settings that
do not depend on a page/item and are not notifications.

### Configuration: attributes and matching properties

| Attribute | Property | Default | Meaning |
|---|---|---|---|
| `scroll-animation-duration` | `scrollAnimationDuration` | `250` | Duration in ms for every programmatic scroll write. `0` disables scroll animation entirely (immediate exact write). |
| `page-enter-duration` | `pageEnterDuration` | `250` | Page-chunk entry visual duration. `0` disables the opacity/translate entry effect. |
| `page-load-debounce` | `pageLoadDebounce` | `150` | Quiet window before a settled-position page request. `0` requests immediately after the current task. |
| `overscan` | `overscan` | `1.5` | Rendered overscan in viewport multiples. |
| `mounted-page-budget` | `mountedPageBudget` | `3` | Maximum non-anchor loaded pages kept mounted. |
| `mounted-item-budget` | `mountedItemBudget` | `400` | Soft cap on mounted item elements. |
| `page-cache-budget` | `pageCacheBudget` | `40` | Soft cap on loaded page/item data retained in memory; the anchor page is exempt. |
| `prefetch-pages` | `prefetchPages` | `1` | Adjacent pages to prefetch after settling. |
| `follow-on-open` | `followOnOpen` | `true` | Initial tail-follow intent (maps to `initial-mode: follow-tail`). |
| `initial-mode` | `initialMode` | `follow-tail` | `follow-tail` or `free`; `pinned` requires an explicit anchor and is not an initial scalar. |
| `top-loading-label` | `topLoadingLabel` | component default | Localized loading text. |
| `bottom-loading-label` | `bottomLoadingLabel` | component default | Localized loading text. |
| `empty-label` | `emptyLabel` | component default | Empty-state text. |

Rules:

- Configuration is **serializable and static**: strings, numbers, booleans. No
  functions, DOM nodes, promises or per-item decisions in this surface.
- Attributes are the declarative form; matching properties are the JS form.
  Property assignment wins over attribute; both win over defaults.
- `scroll-animation-duration="0"` disables scrolling animation for every intent;
  it is not “use the default.” The same applies to `page-enter-duration="0"`.
- `prefers-reduced-motion` forces the effective scroll and page-entry durations
  to zero without destroying the configured values.
- Changing `scrollAnimationDuration` during an animation captures the new value
  for the next animation. Setting it to `0` cancels the current animation and
  performs an immediate exact write to its target.
- Invalid values fall back to the default and report a configuration warning; do
  not silently coerce `NaN`, negative durations or negative budgets.
- Page size, total pages and page tokens are **source metadata**, not generic
  configuration. The source owns them because they define the page identity.
- A per-page height estimate, merge decision or focal policy is a **behavior
  callback/protected seam**, not configuration, because it depends on data and
  state.
- Loading notifications and lifecycle events are **events**, not callbacks in
  configuration.

### The full category split

1. **Configuration** — scalar/static behavior: durations, debounce, overscan,
   budgets, labels, initial follow.
2. **Source** — page identity and data: page size, tokens, loadPage, renderItem,
   updateItem, item content.
3. **Behavior policy** — data-dependent decisions: estimators, container kind,
   merge eligibility, optional focal policy.
4. **Protected OOP seams** — advanced projection changes in a subclass.
5. **Events** — notifications: loading, page loaded, error, anchor/follow/stats.
6. **Read-only state** — segments, metrics, layout plan, current anchors.
7. **Internal state** — page ledger, DOM patch, animation token, epochs. Never
   exposed as configuration or a callback.

### Attribute/property lifecycle

- `observedAttributes` updates the corresponding property and validates it.
- Attributes never carry callbacks. A consumer that sets a function property still
  uses the `source`/`behavior` surface; it does not become a config key.
- The testbed's hardcoded 250 ms values must become `scroll-animation-duration`
  and `page-enter-duration` so the owner can test `0` and other durations live.
- The generic component must not expose a `container` callback that returns
  arbitrary DOM/height. Container structure remains component-owned.

## 6. Kikx adapter (revision 2)

`kikx-thread-scrollview` (or a configured `<aeor-scrollview>` instance) maps
Kikx pages and projected heads to the generic page source:

- The source is **page based**, not item-array based. `totalPages`,
  `pageToken(index)`, `pageIndex(token)` and `loadPage(token)` come from the new
  server page index (§7).
- A page response contains the projected message heads whose raw frames live in
  that page. If a tool call/result or agent delta spans a page boundary, the
  adapter must merge the complete head across adjacent pages before handing it
  to the scrollview; a head is never split into two rendered items.
- `key` is the projected head id; `order` is the head's newest raw order.
- Loaded chunks can contain zero visible heads (a page of collapsed tool
  frames); it still occupies a page in the segment map and may be nearly zero
  height.
- `renderItem` returns `kikx-frame-item`; the scrollview owns only the wrapper,
  segment flow and geometry. Frame item reconciliation and Markdown behaviour
  stay in Kikx.
- `estimatePageHeight` uses the shared estimator statistics from the page index
  prior plus per-session measured pages. Per-type item ratios are a client
  detail for the adapter, not stored in the database.
- `totalItems` is the authoritative projected-head count from the page index;
  the raw `total` is only a page-count input.
- Deep-link/hash `#message=<id>` becomes `scrollToKey(id)`. If the key is not
  loaded, the adapter finds its page from the index (or a page-at-order lookup),
  requests that page, and keeps the jump intent pending until the head is
  measured. Never load the whole session.
- Composer send sets `follow=true` + `place-last-frame`. A new end-turn frame in
  an already-loaded tail chunk uses the same intent.
- Thinking rack, sub-session cards, session grid and composer remain outside the
  scrollview. The scrollview must never rebuild the shell or composer.
- Session filters/search replace the page source and reset the segment map;
  the adapter must choose and document the resulting anchor policy (default:
  reset to the newest matching page, or preserve the nearest loaded match).

The old scroll files are not deleted until adapter parity is green. The
scrollview owns geometry, page/gap loading and anchoring; old code may only
supply page data and item content during migration.

## 7. Server page/index contract (revision 2)

The server must expose stable page tokens and enough aggregate data to size gaps.
Recommended additions to the existing window route:

`GET /api/v1/sessions/:id/frame-page-index`

- `pageSize`: raw frames per page.
- `totalFrames`: raw frame count.
- `totalPages`: stable page count.
- `totalItems`: projected visible head count.
- `indexVersion`: increment on session mutation.
- `prior`: `{ headsPerPage, heightPerHead, samplePages }` learned globally or
  from the session cache.
- `pages`: optional paged descriptors `{token, index, startOrder, endOrder,
  itemCount?}` for arbitrary jumps.

`GET /api/v1/sessions/:id/frame-page/:token`

- Returns the projected heads for one page plus `pageIndex`, `startOrder`,
  `endOrder`, `hasMoreBefore`, `hasMoreAfter`, `measuredHint` (optional).

Compatibility:

- Existing `/frames?before|after` remains for agents/legacy clients.
- The new page route may be implemented over the existing cursor scan; a page
  token is derived from the page's raw start order.
- `totalItems` is computed/cached; a cold index returns `indexing:true` and a
  prior, never a fake exact count.
- Cache invalidation uses the session manifest revision/frame order watermark.
- Raw frame pages may split a projected head; the page response must return the
  complete projected head (merge adjacent raw frames) or explicitly mark the
  boundary so the client can merge across pages. This decision must be tested.

Fallback until the index is ready:

- Use `totalFrames`/`pageSize` for page count.
- Use global prior `headsPerPage`/`heightPerHead` for gap estimates.
- Label the UI “Indexing history…”.
- Never claim an exact total height while indexing.

## 8. Scroll state machine (authoritative)

| Event | Preconditions | Action | Scroll write |
|---|---|---|---|
| open session | no loaded chunk | load newest page, `follow=true` | initial-tail after page lands |
| user scroll up | real gesture, delta < -4 | `follow=false`, capture item/gap anchor | none |
| user reaches bottom | real gesture | `follow=true` | place last frame |
| page requested | page intersects viewport/gap edge | show overlay loading state | none |
| page lands | anchor captured | split gap / merge chunk, measure | restore anchor once |
| page lands at tail | follow | append chunk, measure | follow-tail |
| user in gap | gap anchor unresolved | load page under viewport; preserve gap-relative offset | none until page measured |
| item/chunk resizes | ResizeObserver | update segment height | restore anchor or follow |
| send message | explicit send | `follow=true` | place last frame once settled |
| deep link | hash key | find page, request it, suppress follow | jump-to-key once |
| page error | request failed | keep chunks/gaps, show retry | none |
| unresolved | no anchor/target/measurement | queue intent; do not guess | none |
| filter/search change | new page source | rebuild segment map; preserve nearest match or jump newest | explicit only |

At most one pending scroll intent; a new intent cancels the old one. A gap split
or chunk merge must never occur without a captured anchor.

## 9. Loading/error/empty UX

- Top/bottom status rows are always present but `hidden` when idle/exhausted.
- Loading row is an absolutely positioned overlay so its appearance never
  changes scrollHeight; it uses a small spinner + text.
- Error row includes Retry and the exact cursor/range.
- Initially empty session: “No messages yet” only after an authoritative empty
  response, not while indexing.
- Short thread: after the first page, if content does not fill the viewport and
  there is more history, load another older page before declaring the top.
- Failed load does not clear the composer, the thread, or the anchor.
- All status text is localizable via properties; no hard-coded Kikx language in
  the generic component.

## 10. Cross-browser and performance

- Test Firefox/Umbrafox and Chromium.
- Use `overflow-anchor: none` on the viewport and all item wrappers; the
  component owns anchoring.
- Use `scrollbar-gutter: stable`; measure actual scrollbar width and set the
  trailing gutter if needed.
- Do not use `scrollIntoView`; it can scroll ancestors and ignores virtual
  geometry.
- Use `getBoundingClientRect` only for rendered items and batch reads before
  writes.
- Use `contain: layout paint style` on item wrappers where safe; never
  `content-visibility` on the scroll container.
- Hidden tabs may pause rAF; the layout model must remain correct and flush on
  visibility. Do not depend on rAF for data acceptance.
- Test fractional `scrollTop` (Firefox) and integer clamping (Chromium), zoom
  80–200%, 120 Hz and 60 Hz, and touch momentum.

## 11. Phases and landing gates

### P0 — Evidence and testbed (this exception)

- Build `spec/ui/scrollview-testbed/` with a deterministic lorem engine.
- Prototype native-flow chunks/gaps and the page model only in the testbed.
- Capture baseline: 17k messages, page size 40, 0–1500 ms latency, failures,
  streaming, a far jump with a 50k-page gap, resize, short thread.
- Deliverable: scenario runner and metrics; no Kikx production changes.

### P1 — Pure `SegmentLayout` model and worker contract

- Page tokens, chunks, gaps, segment offsets, gap split/merge.
- Pure `LayoutPlan`/patch contract usable by a module Worker, with generation
  tokens and a main-thread fallback.
- Anchor forms: item anchor and gap anchor.
- Estimator statistics: heads/page, item-height ratios by role/type and width
  bucket, trimmed mean/median fallback and bounded EWMA correction.
- Unit tests with property invariants: total height, segment/index round-trip,
  anchor stability across split/merge, no negative/NaN heights.
- Gate: model tests green; no DOM dependencies.

### P2 — `aeor-scrollview` component and clean-shot commit

- Native-flow DOM: spacers, chunks, gap spacers, overlays, loading rows.
- Page source contract, settled-position page-load debounce, arithmetic page
  intersection + IO edge prefetch, anchor/focal transaction, ResizeObserver
  batching, follow/placement.
- One 250 ms animation owner for every programmatic scroll write, including
  focal and follow corrections; native user scroll is untouched.
- Patch only the affected gap; one DOM write batch, one forced layout read,
  one focal correction. No full segment rebuild.
- Optional worker `LayoutPlan` consumer with main-thread fallback.
- Page prewarm/idle chunk construction and measured commit budget.
- Unit + real-browser tests in the testbed.
- Gate: testbed matrix green in Firefox and Chromium, including the far-gap and
  prepend-anchor scenarios.

### P3 — Server page/index contract

- `frame-page-index`, `frame-page/:token`, page tokens, `totalPages`,
  `totalItems`, prior statistics, `indexing` state and cache invalidation.
- Benchmark cold/warm index on the 17k session; cap memory.
- Gate: warm index < 500 ms, no full-session hydration; page-boundary head
  merging tested; fallback documented.

### P4 — Kikx adapter

- Map pages/heads, estimator stats, deep link, send/end-turn, filters.
- Keep old scroll code live until adapter parity; do not delete.
- Gate: parity scenarios + live UmbraLink profiling.

### P5 — Replace old scroll owner

- Switch thread rendering to `<aeor-scrollview>`.
- Delete/reduce `kikx-frame-scroll.mjs`, `scroll-focus.mjs`,
  `frame-scroll-anchor.mjs`, `kikx-frame-scroll-lock.mjs` responsibilities.
- Grep-gate removed imports/flags; update specs and docs.
- Gate: full suite, live typing/scroll profile, no full-shell rebuilds.

### P6 — Cross-browser polish

- Firefox/Chromium, zoom, touch, hidden tab, 17k stress.
- Remove scroll debug logger only after owner acceptance.

Each phase is one revertable landing. No phase starts before its predecessor's
gate is green.

## 12. Testbed matrix

Scenarios (all deterministic seeds):

1. 17k messages, initial tail, follow on, 40-frame pages.
2. Loaded old page 3453 then jump to page 56754: exactly two chunks loaded and
   one giant gap; scrollbar/segment map remains coherent.
3. Scroll through the far gap; pages under the viewport load, the gap splits and
   the anchor is preserved; no whole-history load.
4. Prepend 10 pages while anchored in the middle; anchor drift <= 1 px.
5. Jump to random page/key; request exact page, place once after measurement.
6. Append/stream while at bottom; follow stays pinned.
7. Append while reading older history; viewport and gap anchor do not move.
8. Short thread (< viewport) with more pages; wheel/touch at top/bottom loads.
9. Load latency 0/250/1500 ms; loading row visible within one frame; no blank
   state.
10. Load failure and retry; existing chunks, gaps and anchor intact.
11. Duplicate/out-of-order page responses; keyed merge, no duplicates.
12. Item height changes (short→long, code block, image/font) while visible.
13. Page with zero visible heads (collapsed tools) and page-boundary head split.
14. Estimator deliberately biased ±20%; measure gap correction and anchor drift.
15. Resize viewport/zoom so a gap spans two loaded chunks; choose the focal point
    nearest the viewport center and keep that content fixed; tie-break is stable.
16. Deep link to unloaded key; exact placement after page load.
17. End-turn short frame fully visible; tall frame top-aligned.
18. Rapid wheel/touch momentum; no forced correction after user intent.
19. Hidden tab then visible; queue flushes, no stale jump.
20. Two disjoint page mutations in one batch; center-nearest focal point wins and
    the other side is allowed to move.
21. Page commit timing: 10/20/40-item pages, one DOM patch, one layout read,
    commit <= 8 ms target (never >16 ms undocumented).
22. Worker plan: stale generation ignored; main-thread fallback produces the same
    segment/focal result.
23. Scrollbar drag: 50 rapid position changes produce at most two page requests;
    only the settled page loads.
24. All programmatic scroll writes animate for exactly 250 ms; retargeting,
    user cancellation, focal-correct animation, follow retargeting, reduced
    motion and hidden-tab behavior are covered.
25. Disconnect/session switch/filter invalidation cancels debounce, in-flight
    loads, rAF animation and pending intents; no stale page/plan commits.
26. Page-cache eviction while DOM is unmounted; anchor page is never evicted;
    remount/reload preserves height and anchor.
21. Focus, text selection and stable pointer over mounted content override the
    center focal point; each falls back correctly when its target is unmounted
    or off-screen.

Metrics per run: FPS/gaps, long tasks, render ms, DOM mutation count, chunk count,
gap count, rendered items, virtual pages, anchor drift, gap-anchor drift, bottom
error, loading latency, page requests, estimator error, DOM nodes.

## 13. Verification spine

- Characterization tests for current server window/paging (keep existing).
- New failing-first tests for each defect listed in §1.1.
- Model unit tests: 10k random sequences, offset/index round-trip, anchor
  invariants, height updates.
- Component tests in mini-DOM where possible; real-browser tests for layout,
  scroll, ResizeObserver, and input.
- Testbed acceptance: §12 scenarios × Firefox/Chromium.
- Live Kikx: typing while a frame arrives, end-turn, 17k session, deep link,
  failed page, hidden tab.
- Performance budgets: p95 input delay < 16 ms; no composer replacement; anchor
  drift <= 1 px; loading indicator <= 1 frame; bottom error <= 1 px; full-shell
  renders during scroll = 0.

## 14. Decisions, risks and open concerns (revision 2)

### Ratified by the owner

- **D1.** `aeor-scrollview` is a generic Aeor component; the Kikx adapter remains
  in Kikx.
- **D2.** The server provides page/index metadata; the client does not invent an
  exact total.
- **D3.** The layout unit is projected data plus page-level estimates; physical
  item layout is never stored in the database.
- **D4.** Native browser flow with gap spacers is the chosen mechanism. Absolute
  item positioning is rejected.
- **D5.** One spacer per contiguous gap/page range, not one DOM node per message.
- **D6.** Loading is triggered by arithmetic page intersection, with
  IntersectionObserver as an edge-prefetch/short-thread aid, not as the sole
  source of truth.
- **D7.** Page statistics are per-session, not a single global average.
- **D8.** Messages unmount, but containers do not mount/unmount. Containers merge
  and split as the projection of page state changes.
- **D9.** Consecutive real messages and blank page ranges share merged containers;
  the container is the stable DOM unit.
- **D10.** The focal point is whatever keeps the element the user is staring at
  from shifting. Use active focus, non-collapsed selection, or a stable pointer
  over mounted content first; fall back to mounted content nearest viewport
  center. Tie-break loaded over blank, topmost, stable key. Correct scroll by the
  inverse focal-point delta; if no focal point survives, do not scroll.
- **D11.** Page tokens are raw-frame page tokens with projected heads returned
  per page, merged across page boundaries by the adapter.

### Recommended architecture additions

- **Worker projection:** run page/gap offsets, visible-page math, estimator stats
  and focal selection in a module Worker; keep DOM measurement and scroll writes
  on the main thread. Recommendation: yes, behind a pure `LayoutPlan` contract
  with a main-thread fallback.
- **Clean-shot commit:** patch only the changed gap, build the new page chunk
  off-DOM, use one DOM write batch and one layout read, then one focal
  correction. Recommendation: mandatory before any performance claim.
- **Prewarm:** load one viewport ahead and build the detached page chunk when
  idle. Recommendation: yes; do not insert hidden staging DOM by default.
- **Page-load debounce:** settled-position requests only; default 150 ms quiet
  window, one pending timer, at most one adjacent prefetch. Recommendation:
  mandatory.
- **Scroll animation:** one JS animation owner for every programmatic scroll
  write, exactly 250 ms, immediate cancellation on user input. No global CSS
  `scroll-behavior: smooth`. Owner ruled all programmatic changes animate.
- **JS is mandatory for scroll:** CSS cannot drive `scrollTop` with exact
  duration, cancellation, retargeting and epoch priority. CSS is limited to
  non-scroll visual entry effects.
- **Page size:** measure 10/20/40-item commits; choose the largest page that
  fits the 8 ms commit budget on the reference machine.
- **Extension API:** composition first — required `source` callbacks plus an
  optional `behavior` object and events. Export the class with a small protected
  OOP seam for advanced projection changes. Consumers never define container
  geometry or write scroll. Recommendation: adopt this split.
- **Configuration is separate:** scalar/serializable settings use attributes and
  matching properties. `scroll-animation-duration` defaults to 250 ms and `0`
  disables scroll animation; `page-enter-duration` defaults to 250 ms and `0`
  disables page entry. Page size/tokens remain source metadata, and estimators
  remain behavior/OOP policy.

### Recommended but still open

1. **Page boundary policy.** Raw-frame pages can split a projected head.
   Recommendation: server pages return complete heads by extending the raw read
   across the boundary, or return boundary metadata the adapter can merge. A
   split rendered item is not acceptable.
2. **Estimator statistic.** Recommendation: per-session median/trimmed mean for
   page head count and height ratios, blended toward a per-width prior as sample
   size grows; use a bounded EWMA scale correction. Mean-only is too vulnerable
   to huge tool pages; median-only can drift the total height.
3. **Focal-point attention signals.** Focus, selection and stable pointer are
   stronger than the center proxy; center is the fallback. Only use them when the
   target is mounted and intersects the viewport. Text selection uses the visible
   end nearer center; pointer uses the nearest mounted item/container under the
   pointer after 250 ms stationary, with no button down. Owner ratified this.
4. **Focal-point multiplicity.** A batch or a viewport resize can create two
   plausible focal points (for example, a gap spanning two loaded chunks).
   Choose the content whose rectangle is nearest the viewport center. Tie-break:
   loaded over blank, topmost, then stable key. One focal point per transaction;
   allow the other side to move.
5. **Container split identity.** When a blank container splits around a loaded
   page, page-range identity changes. Recommendation: derive container identity
   from the page range, and keep the focal point as a page/item token, not a DOM
   ID that may disappear.
6. **First-load gap.** Recommendation: initial tail load does not create a top
   gap until the newest page is measured; then the segment map is built with the
   global prior. This avoids a visible height change during open.
7. **Copy/select-all.** Recommendation: native selection covers mounted content
   only; document the limit and provide “load all” only as an explicit,
   expensive user action outside the scrollview.
8. **Short thread.** Recommendation: if total pages fit the viewport, render all
   pages; if the index is still building, show “Indexing history…” and allow
   wheel/touch at the top/bottom to request adjacent pages.
9. **Filters/search.** Recommendation: a filter change creates a new page source
   and container projection; preserve the nearest mounted match if possible,
   otherwise jump to the newest match. Do not silently mix filtered and
   unfiltered pages.

### Risks

- A wrong `heads/page` prior makes every gap wrong in the same direction. The
  bounded scale correction and measured-page replacement are mandatory.
- Raw pages with wildly different content mixes (tool-heavy vs chat-heavy) can
  make a global page average poor. Per-session and per-width buckets reduce this;
  a page-type classifier would be a later optimization.
- ResizeObserver loops and scroll correction can fight each other. One geometry
  transaction per frame, `overflow-anchor:none`, and no correction while the
  anchor is unresolved.
- Mobile momentum can be cancelled by a scroll write. Defer correction until
  momentum settles when the anchor is a gap; never cancel a touch gesture.
- Hidden tabs pause rAF; page acceptance and segment updates must not depend on
  rAF. Flush on visibility.
- `content-visibility` can break measurement/selection if applied too broadly.
  Keep it out of P1/P2.
- The old Kikx scroll code has many hidden consumers and tests. It cannot be
  deleted until the adapter parity suite is green.
- Focal-point selection can be wrong if the moved block is itself replaced by the
  mutation. Keep the focal block mounted or convert its token to the nearest
  surviving container edge before mutating.
- Container merging is a geometry change even when no page loads. Every merge or
  split must run the same focal-point transaction; never mutate container DOM
  outside it.
- Side-by-side blocks can move one axis but not the other. The focal point only
  guarantees the vertical offset of the block that actually moves; horizontal
  reflow is outside this component.
- Total-height changes move the scrollbar thumb. Local gap absorption minimizes
  this; if a page is taller than every adjacent blank can absorb, the thumb must
  move and the UI must not pretend otherwise.

## 15. Definition of done

- All §12 scenarios pass on Firefox and Chromium.
- The scrollview uses native flow plus one spacer per contiguous gap; no
  absolute item placement and no per-message virtual DOM nodes.
- A far jump loads only the two target chunks; the gap between them is one
  segment and remains coherent while scrolling.
- `aeor-scrollview` is the sole owner of scroll geometry, page/gap loading and
  anchoring; old scroll/focus/anchor/lock modules are removed or reduced to thin
  data adapters with no duplicate scroll writes.
- `totalPages`/`totalItems` are authoritative after indexing; the indexing
  fallback is visibly labelled and never claims exactness.
- Anchor drift <= 1 px for loaded items; gap anchors preserve relative position;
  no unexplained jump > 1 px.
- End-turn placement meets §4.8.
- Loading/failed/exhausted/indexing states are visible and accessible.
- No full-shell rebuild or composer replacement on scroll, load, measure, or
  frame arrival.
- Live Kikx profiling shows no unexplained jump, freeze, or composer loss after
  a far jump, a page load and a typing burst.
- Full suite green; docs and handoff updated.

## 16. P0 testbed findings so far

The first testbed prototype is under `spec/ui/scrollview-testbed/`. It currently
uses per-item virtual slots with top/bottom spacers, demand-loaded pages and a
bounded rendered window. At 17k total it renders typically 16–27 items and
137–193 DOM nodes. It already demonstrates the intended jump and follow model.

Two findings are load-bearing:

1. **Jumping into a virtual range must move the render window first.** Setting
   `scrollTop` only after the window was chosen rendered the old tail, then
   moved the viewport into a range that had not been materialized. The prototype
   now places the viewport at the target's estimated offset before choosing the
   window; a pending jump is held until the target is loaded and measured.
2. **Anchor capture must happen before the layout model changes.** Capturing
   after `replaceRange()` preserves whatever item the *new* geometry put under
   the viewport, which is the jump we are trying to eliminate. The prototype
   captures a pending anchor before a page lands and carries it through render
   and measurement.

The prototype still has a known prepend-anchor failure: prepending a page while
anchored in the middle can move the top item, even though the residual offset is
small. Revision 3 replaces the anchor logic with the center-nearest focal-point
rule and a container projection; the item-slot prototype now implements the
center selection but still fails because multiple page/measurement renders can
overwrite the pending focal transaction. The next testbed revision must:

- replace the item-slot layout with `SegmentLayout` chunks/gaps;
- load page 3453 then page 56754 and assert one gap, two chunks;
- scroll through the gap and assert gap splitting + anchor stability;
- add page-boundary head merging and zero-head pages;
- add estimator bias/correction scenarios;
- implement merged containers for consecutive real/blank ranges and verify that
  only messages unmount, never the containers;
- choose the focal point from the moved surviving block and assert
  `oldPosition - newPosition` correction on a page load above the viewport;
- test two side-by-side blocks where only one moves vertically;
- implement and verify focus/selection/stable-pointer attention overrides.

The testbed currently knows its total item count up front. Kikx does not yet have
an authoritative projected-head count, which is why §7 proposes the page index
before the adapter phase. Until then, Kikx cannot honestly promise a stable
virtual scrollbar.


## 17. Item-slot prototype failure (2026-10-27)

The first testbed is useful precisely because it fails. A single 500 px wheel
event near item 16491 moved `scrollTop` from **1,551,340 to 1,542,418** (≈8,922
px), moved the top item by **90 items**, and produced **69 renders** plus three
page loads. The initial tail also sat ~194 px above the true bottom until item
margins were removed from the layout experiment; that is exactly the kind of
flow-chrome mismatch the page/container ledger must include.

The cause is structural, not a missing condition:

- the prototype uses per-item estimated slots and item-level DOM;
- multiple concurrent page loads overwrite one pending focal/anchor;
- a page load changes the geometry above the viewport by thousands of pixels;
- layout estimates and real item heights diverge, and each ResizeObserver
  correction can trigger another render/scroll pass;
- the browser's native flow is still doing the positioning, while the prototype
  is trying to own it through item offsets.

This prototype therefore **does not validate the final model**. It validates the
opposite: the container/page projection with a real focal-point transaction is
required. The next prototype must be a clean `ScrollPageView` built on page
ledgers and merged containers, not another patch to item slots.


## 18. Second prototype status (page/container)

`spec/ui/scrollview-testbed/page.html` is now a separate native-flow
page/container prototype. It uses 40-item pages, one gap element per contiguous
unloaded page range, and normal-flow page chunks.

Initial measurements:

- 425 pages, 40 mounted items after the tail page loads.
- Two segments initially: one gap and one page chunk.
- Initial bottom placement is exact after forcing flow layout before reading
  `scrollHeight`.
- Five -600 wheel events move `scrollTop` by exactly -3,000 px; eight more move
  exactly -4,800 px. No jump inside loaded/gap content.
- Loading page 423 above page 424 still does not apply the expected focal
  correction (~937 px). The next bug is in focal capture/restore across the
  page insertion; it is not being hidden as “good enough.”
- No chunk eviction yet; long manual scrolls will grow DOM until the page/container
  retention phase is implemented. A separate loaded-page cache budget must bound
  item data even when DOM is unmounted.

The second prototype is materially closer than the item-slot one: page geometry
and native flow are behaving, and the remaining failure is a focal transaction,
not a whole-layout scramble.


## 19. Page/container prototype progress

The second prototype (`/page.html`) now demonstrates the core mechanics without
the item-slot failure:

- 425 pages of 40 items; native-flow page chunks and one gap element per
  unloaded page range.
- Initial tail placement reaches exact `maxScrollTop` after measuring the last
  page.
- Far jump to page 300 creates `gap 0..299 | page 300 | page 301 | gap 302..423
  | page 424` and loads only the target pages.
- Loading page 423 above visible page 424 captured focal item `16961` at
  `top=337.5`; after insertion the correction restored it to `top=337`.
- Wheel movement inside loaded/gap content followed the wheel delta exactly in
  the sampled cases.
- Rapid fire mode appends a random message every 2.5 s by default; it updates
  only the tail page chunk and keeps follow-tail pinned exactly. A 6.2 s run
  added three messages, grew page 425 from empty to 276 px, and kept
  `scrollTop === maxScrollTop`.

The container model is therefore viable. Remaining P0/P1 work: page chunk
eviction/merge, loading when the viewport is entirely inside a blank gap, the
two-chunk/gap resize center-focal test, and moving the prototype from one chunk
per page to merged containers.

## 20. Adjacent future work — workerized frame/SSE pipeline

**Owner todo (deferred, not part of this scrollview campaign):**

Move all Kikx frame management and SSE/WebSocket handling into workers so they
cannot gum up the renderer thread.

Scope to revisit later:

- SSE parsing, reconnection, heartbeat and event dedupe;
- frame ingestion, projection, merge/coalescing and priority ordering;
- frame-store/API fetches and payload normalization;
- transferring only bounded batches to the renderer;
- the same epoch/priority/cancellation rules as the scrollview: user input and
  rendering always outrank background frame work, and no delayed batch may
  overwrite a newer input or layout generation.

This is explicitly **not** authorized by the scrollview plan and does not block
P0–P6. It should be its own campaign with its own memory, cancellation,
backpressure and main-thread handoff contract.


## 21. Debounce and animation measurements

The page/container prototype now implements the settled-position load debounce
and is being updated to the owner's all-programmatic-250 ms animation rule.

- 50 rapid -100 px wheel events near the tail produced **one** page request, not
  dozens. The request happened only after the 150 ms quiet window.
- All programmatic writes now animate with exactly 250 ms. A page jump moved
  from 1,870,437 to 441,817 after the target page loaded. Render count stayed
  modest because the animation suppresses intermediate renders.
- Wheel/pointer/key input cancels the animation. Follow-tail, focal restoration
  and page geometry corrections remain immediate writes.
- Page 101 was prefetched after the jump settled; no intermediate pages were
  requested during the animation.


## 22. All-programmatic 250 ms animation (implemented in prototype)

The page/container prototype now uses a single animation owner for every
programmatic `scrollTop` write: page jumps, follow-tail, focal corrections,
anchor restorations and container/page geometry corrections. Native wheel, touch,
scrollbar and keyboard scrolling remain native.

Measured: a page jump animated from 1,870,437 to 441,817 over 250 ms after the
target page loaded. A 6.2 s rapid-fire run kept the tail pinned after each
append. The animation retargets on new page/measurement updates and is cancelled
by user input. `prefers-reduced-motion` performs an immediate write.


### Measured animation cancellation

The page prototype animates with `requestAnimationFrame` at 250 ms. In a live
test the jump was at `scrollTop=445,976` mid-animation; a user scroll changed it
to `445,876` and dispatched `scroll`. The animation stopped immediately and the
position remained `445,876` after 80 ms instead of continuing to the target
`441,817`. The pending page intent was cleared as well.


## 23. Page insertion flash fix

Cause: the page testbed’s “Append page” button called `setSource(source)`, which
reset every page/segment element and rebuilt the view. That is a full flash, not
an animation. The control now calls `appendItem(item)` and patches only the tail.

New page chunks use a 250 ms CSS keyframe entry animation (opacity 0→1 plus a
12 px translate). Measured live: 80 ms after append the new page was at
`opacity=0.295`, `translateY=8.46px`; after 400 ms it was `opacity=1`,
`translateY=0`. Existing page chunks are not rebuilt. Reduced motion disables the
entry animation.

## 24. Remaining details checklist before production

The page/container prototype now proves the core behavior, but these details are
still open. This is the working checklist, not a claim that the prototype is done.

### Geometry and DOM

- Replace one-chunk-per-page with true merged containers: adjacent loaded pages
  merge when no split/focal transaction is pending; loaded-but-unmounted chunks
  become measured containers.
- Implement page/chunk eviction after long manual scrolling. Current prototype
  keeps every loaded page mounted.
- Make page insertion a true clean-shot patch: replace only the affected gap,
  never rebuild/move all segment elements. The prototype still does a full
  segment pass.
- Page-boundary head merging: a projected head must never be split across pages.
- Measure page commit timing for 10/20/40-item pages and choose the page size.
- Verify measured container height includes margins/page chrome; the item-slot
  prototype proved this can be off by hundreds of pixels.

### Async/worker and event order

- Implement the worker `LayoutPlan` contract, `inputEpoch`, `pageEpoch`, planID,
  stale-plan drop, one-in-flight, retargeting and cooperative cancellation.
- Verify a delayed plan cannot write scroll after a user scroll.
- Verify page mutation during a plan drops the whole plan.
- Hidden-tab rAF pause: settle/snap on visibility, never leave an animation or
  plan pending.
- Prewarm one viewport ahead; evaluate idle detached chunk construction.

### Loading and failure UX

- Loading when the viewport is entirely inside a blank gap (no focal point).
- Top/bottom loading rows, retry, exhausted and indexing states.
- Short-thread fill and wheel/touch at the top when no scrollbar exists.
- Scrollbar-drag debounce verification on real scrollbars, not just wheel.
- Failure leaves chunks, gaps, anchor and composer untouched.

### Focal point and animation

- Implement focus, text-selection and stable-pointer attention overrides in the
  page prototype; it currently uses center only.
- Gap anchors: preserve proportional position until a real page lands.
- Two loaded chunks around a gap after viewport resize: center-nearest focal and
  deterministic tie-break.
- Animation cancellation/retarget tests for wheel, touch, pointer, keyboard and
  native scroll drift; page load during animation; reduced motion.
- All programmatic writes exactly 250 ms, including focal/follow corrections.
- Page entry animation and scroll animation must not fight each other.
- Config regression: `scroll-animation-duration=0`, `page-enter-duration=0`,
  attribute/property precedence, live changes during an animation, invalid values.

### Accessibility, selection and browsers

- Native selection/copy for mounted content only; document detached-content
  behavior.
- `aria-posinset`/`aria-setsize`, list roles, loading announcements, keyboard
  Home/End/PageUp/PageDown.
- Firefox/Umbrafox and Chromium, zoom 80–200%, touch momentum, 120 Hz/60 Hz,
  fractional scrollTop and hidden tabs.

### Integration and cleanup

- Generic `aeor-scrollview` API and Aeor packaging, main-thread fallback.
- Kikx page source adapter; server `frame-page-index`/`page-token` and
  `totalItems`; filters/search, deep links, send/end-turn.
- Remove old scroll/focus/anchor/lock owners and grep-gate dead flags/imports.
- Automated testbed scenario runner and metrics capture.
- Production profiling on the 17k session before any claim of completion.

The page prototype is a valid core proof; the remaining work is hardening,
integration and measurements, not another redesign of the native-flow/page-gap
model.
