# Incident: production session history appeared to vanish on browser reload

**Date:** 2026-10-05
**Severity:** High (perceived complete data loss of an active production session)
**Status:** Diagnosed; fix implemented and unit-verified. Not yet deployed.
**Owner report:** "I just had a huge interaction with Kikx in the production
deploy... and upon browser reload, it is all gone."

## Summary

No data was lost. Every frame of the affected production session
(`a07faa16-4eed-44a9-b823-f2e9c0c10df5`, title "Kikx") is present in AeorDB:
**2742 frame files** and **2925 commits**, with the newest frames timestamped
2026-10-05T22:28:04Z (the interaction the owner was in).

The history *appeared* gone because the browser's default frame load hit a
latent scan-cap bug in `AeorDBFrameStore.listFrameWindow()`: for any session
with more frames than the default directory-scan limit, the "newest page" was
anchored to the end of the **first 1000** directory entries rather than the true
tail. The session had 2742 frames, so the newest ~1700 frames (everything from
roughly 2026-10-01 onward) were unreachable, and a reload showed only stale
history.

## Evidence

- AeorDB direct listing `/kikx/sessions/<id>/interactions?depth=-1&glob=**/frames/*.json`:
  `total: 2742`; commits `depth=-1`: 2925.
- `AeorDBFrameStore.listFrames(ses, { limit: 5000 })`: **2742** frames, max
  order **248435** (a `WriteFileToolFrame` at 22:28Z).
- Before the fix, `AeorDBFrameStore.listFrameWindow(ses, { limit: 100 })`
  reported `total: 1000`, `newestOrder: 102453` — the client's default load
  path, anchored to the oldest 1000 frames.
- After the fix: `total: 2742`, `newestOrder: 248435`, and paging back with
  `before` walks the true tail (`229887 → 248435`, then `213313 → 229886`).
- `listSessionPreviews` (session-list sidebar) already anchored correctly and
  showed newest orders `[246448, 246888, 246965, 246967, 248434]`, which is why
  the session list still looked current while the thread did not.

## Root cause

`src/core/aeordb/aeordb-frame-store-preview.mjs::listFrameWindow()` called
`listDirectoryPaths(interactionsPath, { depth: -1, glob: '**/frames/*.json' })`
with no explicit `limit`. `listDirectoryPaths` defaults to
`DEFAULT_FRAME_LIST_LIMIT = 1000` (`aeordb-frame-store-constants.mjs`). The
directory is returned in ascending zero-padded-order order, so the scan
returned the **oldest** 1000 frame paths; `sortedPaths` then only ever contained
those, `total` was computed as `sortedPaths.length` (1000), and the default
window `slice(total - limit, total)` anchored to order ~102453 instead of the
real tail.

The same cap also made the `before` cursor unable to reach anything beyond the
first 1000 entries.

## Fix

`listFrameWindow()` now anchors to the true tail:

1. It already probes the directory once for total; it now uses that `total`
   (the recursive count AeorDB reports) instead of the truncated scan length.
2. With no `before`, it fetches exactly the tail window via
   `offset = total - limit`.
3. With a `before` cursor, it binary-searches the (order-sorted) directory for
   the first offset whose frame order is `>= before` (`findFrameOffsetAtOrAfter`),
   then fetches that window. This is O(log n) one-entry probes.
4. When the directory reports no pagination metadata (`total` absent), it falls
   back to an uncapped scan bounded by `MAX_FRAME_LIST_LIMIT`.

`hasMore` is now computed from the true `startOffset`.

## Regression coverage

- `AeorDBFrameStore window anchors to the true newest frame in a large session`
  (2500 frames; asserts `total: 2500`, `newestOrder: 2500`, correct paging back).
- `AeorDBFrameStore window anchors correctly just above the default scan cap`
  (1001 frames; the off-by-one boundary).
- Existing window/paging/before-cursor tests still pass.

Full core suite: 744/744, eslint clean.

## Notes / follow-ups

- This bug was pre-existing and unrelated to the `d5e295f` durable-process-state
  deploy that immediately preceded the report; that deploy did not touch frame
  listing or delete data.
- `listSessionPreviews`/`loadSessionPreviewHeads` already anchored to the tail
  (`offset = total - rawLimit`) and were not affected.
- A session with an extremely large frame count will now issue O(log n)
  directory probes for a `before` page; each probe recursively traverses the
  directory server-side. This is acceptable at current scale but is a candidate
  for a server-side order-range index later.
- **Deployment caveat:** at diagnosis time the live production Kikx container
  (which mounts `$KIKX_HOME` read-write) had an agent actively editing this same
  git working tree (uncommitted session-soft-delete and todo-summary work).
  Restarting the container to deploy this fix would interrupt that in-flight
  work, and the uncommitted changes are not part of any image. Coordinate deploy
  timing with the owner.
