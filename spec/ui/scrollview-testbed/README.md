# `aeor-scrollview` testbed

**Status: EXPERIMENTAL AND KNOWN BROKEN.** This is the first item-slot prototype,
not the final container/page model. It is retained to reproduce the failures
that motivated plan revision 3. Do not use it as acceptance evidence for the
final scrollview.

Standalone prototype and benchmark harness for the scrollview campaign. This is
not the production component and is not imported by Kikx.

## Run

```sh
node spec/ui/scrollview-testbed/serve.mjs
# http://127.0.0.1:3110/
```

`AEOR_ROOT` overrides the vendored Aeor checkout path; `PORT` overrides 3110.
The server maps `/vendor/` to the Aeor checkout so the testbed can use the real
framework modules.

## What it exercises

- Deterministic 17,000-item lorem history; pages are generated on demand.
- Virtual geometry with top/bottom spacers and a bounded rendered window.
- Follow-tail vs. anchored reading.
- Loading rows, latency, and failure injection.
- Short-thread mode (8 items) and jump-to-index.
- Streaming, append, random content update.
- Metrics: virtual/loaded/rendered counts, anchor, scroll geometry, requests,
  failures, long tasks, DOM node count.

## Current prototype limits

- The current prototype uses per-item virtual slots. Plan revision 3 replaces
  this with container projection: consecutive real/blank ranges merge into
  containers, messages mount/unmount inside them, and every page load/measure
  runs a focal-point transaction.
- The testbed's current prepend-anchor test still fails; it is intentionally the
  first failing case for the container/focal-point revision.
- The source is index-addressed and knows its total up front, as a server-side
  page index eventually will. Kikx currently has raw-frame `total`, not a page
  token/total-head index.
- Item height estimates are intentionally crude; measured heights replace them.
- The prototype does not yet implement retry buttons, keyboard paging, touch
  momentum tuning, or the full 15-scenario matrix. Those are plan P0/P2 work.
- The testbed is deliberately not committed to the production import graph.

## Planned scenarios

The matrix is in `docs/plans/scrollview-campaign.md` §12. The next testbed
increments are:

1. container merge/split projection and focal-point assertions;
2. jump-to-key with an unloaded target;
3. short-thread wheel/touch loading;
4. failure/retry;
5. Firefox/Chromium comparison runs;
6. metrics export for before/after review.

## Page/container prototype

`http://127.0.0.1:3110/page.html` is the second prototype: native-flow page
chunks with one gap element per contiguous unloaded page range. It is separate
from the broken item-slot testbed.

Current measured state:

- 17,000 items / 40-item pages / 425 pages.
- Initial tail loads one page: 40 mounted items, one gap, bottom placement exact.
- Five -600 wheel events move `scrollTop` by exactly -3,000 px; eight more move
  exactly -4,800 px. No scroll jump inside already-loaded/gap content.
- Loading page 423 above the loaded page 424 currently does **not** apply the
  expected focal correction (~937 px); focal capture/restore is the next bug.
- The page prototype has no chunk eviction yet; it currently keeps loaded pages
  mounted, so a long manual scroll will grow DOM.

## Page/container prototype status

`/page.html` is the clean second prototype. It is now materially working for the
core page/gap mechanics:

- 425 pages; one gap element for the unloaded range and page chunks in native
  flow.
- Initial tail placement reaches the exact maximum scroll position after
  measuring the last page.
- A far jump to page 300 creates `gap 0..299 | page 300 | page 301 | gap 302..423
  | page 424`; it does not load the intervening history.
- Loading page 423 above a visible page 424 captured focal item `16961` at
  `top=337.5`; after insertion the scroll correction restored it to `top=337`
  (subpixel rounding).
- Wheel scrolling inside loaded/gap content moved by the exact wheel delta in
  the tested sample.
- Rapid fire mode appends a random user/agent item every configurable interval
  (default 2.5 s), updates only the tail page chunk, and keeps follow-tail
  pinned to the exact maximum.

Known remaining work: page chunk eviction/merge after a long manual scroll,
loading pages whose visible region is entirely blank gap (no focal point), and
the two-chunk/gap viewport-resize center-focal test.

## Debounce and animation

- Page loads are settled-position requests with a 150 ms debounce. A run of 50
  rapid -100 px wheel events produced **one** page request, not dozens.
- Explicit page jumps animate for 280 ms with an eased JS scroll. In the page
  prototype the animation moved from 1,866,098 to 441,817 and settled exactly on
  the target page; render count stayed around 11 instead of one render per frame.
- Any wheel/touch/pointer/key input cancels the animation. Layout corrections,
  follow-tail and focal restores remain immediate.
- Animation is enabled for page jumps; bottom-follow remains immediate.

## All-programmatic 250 ms animation (owner ruling)

The page prototype now uses one animation owner for **every programmatic
`scrollTop` write**: page jumps, follow-tail, focal correction, container/page
geometry correction and anchor restoration. Native wheel/touch/scrollbar/keyboard
movement is not intercepted. Duration is exactly 250 ms; new targets retarget the
same animation; user input cancels it.

Observed in the page prototype: a jump animated from 1,870,437 to 441,817 over
250 ms after the target page loaded; a 6.2 s rapid-fire run kept the tail pinned
after each append. Reduced motion bypasses the animation.

## Page insertion animation

Appending a page no longer resets the source. The “Append page” control uses
`appendItem()` and patches only the tail page chunk. New page chunks animate for
250 ms: opacity 0→1 and translateY 12px→0. Measured live at 80 ms: opacity
0.295, translateY 8.46px; at 400 ms: opacity 1, translateY 0. Reduced motion
disables the entry animation. Existing page chunks are not rebuilt.
