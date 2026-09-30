# Plan: Session history lazy-loading

## Goal
Open a long session and always see the NEWEST messages; scroll up to load older
pages on demand; never load the whole session. Required for dogfooding.

## Observed facts
- `FrameRuntime.listFrames` -> `ensureSessionEntry` loads the OLDEST `limit`
  frames (store `listFrames` lists `interactions/**/frames/*.json`, basename
  sorted == order asc, `offset 0`), hydrates a full `FrameEngine`. So for a
  session with >1000 frames the newest are never shown, and paging slices a
  truncated set. (Store `listFrames` also mis-aligns `offset` between frames and
  commits.)
- The store already does a correct bounded TAIL read for previews
  (`loadSessionPreviewHeads`): `total` from a `limit:1` listing, then
  `offset = total - rawLimit`, read only that tail, project + trim.
- Frame paths are basename-sorted; the numeric prefix is the stable `order`.
- Client stores projected message HEADS (`framesBySessionID`), renders them, and
  anchors scroll to the bottom. `/frames` is client-only over HTTP (agents use
  the engine in-process), so its shape is safe to extend.

## Contract
`GET /api/v1/sessions/:id/frames?limit=N&before=<order>`
- `before` absent -> the newest N frames.
- `before` present -> the newest N frames with `order < before`.
- Response: `{ frames, total, hasMore, oldestOrder, newestOrder }` where `frames`
  are projected visible heads in display order, `total` is the raw frame-file
  count, and `hasMore` is true if older frames exist before this page.
- Backward compat: existing callers keep working; a small-session fetch returns
  all frames (behaviourally identical).

## Phases
- P0 (server): `AeorDBFrameStore.listFrameWindow(sessionID, { limit, before })`
  + `FrameRuntime.listFrameWindow` passthrough (no engine hydration) + route.
  Specs: newest window, `before` paging, `hasMore`, small session = all.
- P1 (client): per-session window meta (`{ hasMoreOlder, oldestOrder, loading,
  total }`). Load newest page on open, scroll to bottom. On scroll near top,
  load the previous page and PREPEND heads not already present (never replace an
  existing head, so newer complete heads are not regressed by older partials),
  preserving scroll position. Session messageCount for display uses server
  `total`, not the loaded-window count.
- P2: verify unit + Stagehand (open long session shows newest; scroll-up loads
  older) + live Brave.

## Risks
- Page boundary can split a tool call/result or agent deltas; mitigated by
  merge-by-id-on-insert-only (existing heads win).
- SSE `frame.added` upserts must not recompute session messageCount from the
  window (would corrupt counts); use `total`.
- `FrameEngine` remains for agents/commits; the client history path deliberately
  bypasses it.
