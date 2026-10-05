# P9 dev verification — scheduled-frame lookup (CORRECTED)

Date: 2026-10-04. Status: corrected diagnosis after reading
`~/Projects/aeordb-workspace/aeordb/docs`.

## Correction of an earlier wrong diagnosis

An earlier commit (`ac5bef5`) stated: "AeorDB 0.9.5 has no `/files/query`
endpoint." **That was wrong.** Per `docs/src/api/querying.md`, `POST /files/query`
exists, and a 404 there means **"Query path or index not found"** — a missing
index at that path, not a missing endpoint.

The real cause: Kikx queried `${root}/sessions` for fields `scheduledAt`/
`scheduledStatus`, but those are indexed **per session** under
`.../interactions/.aeordb-config/indexes.json` (glob `**/frames/*.json`). The
live 404 body is exactly:

```
{"error":"Index not found for field 'scheduledAt' at path '/kikx/sessions'"}
```

A cross-session lookup must use the global `POST /files/search` endpoint, which
fans out across every directory indexing the requested fields.

## Correct fix

`AeorDBFrameStore.searchScheduledFrames` now calls `/files/search` (scoped to
the root) and, on any index/search error, falls back to the authoritative
per-session scan. Every returned frame is re-verified with
`isPendingScheduledFrame`, so correctness never depends on the index filter.

Observed AeorDB behavior worth noting: `/files/search` combinator filtering on
`scheduledStatus` is **index-only** and can return non-pending frames; the body
check is authoritative.

## Verification (dev + live)

1. Live dev AeorDB 0.9.5: `/files/search` for `scheduledAt > 0` returns matching
   frame paths; body verification of each yields the pending set.
2. `node scripts/verify-scheduled-frames.mjs` against dev →
   `OK: store returned 0 pending scheduled frame(s), matching body verification.`
   (the one previously-stale wake `7e1a689f` was already cancelled).
3. The earlier stale-wake cancellation (`7e1a689f` → `scheduledStatus:'cancelled'`)
   remains valid and is the boot-sweep behavior working against the real DB.

## Repeatability

`scripts/verify-scheduled-frames.mjs` is the reusable check; `kikx-docker/deploy.sh`
runs it post-start (`verify_deploy`, non-fatal by default, enforced with
`DEPLOY_VERIFY_REQUIRED=1`). This is what would have caught the original miss.

## Deploy status

NOT pushed, NOT deployed (owner ruling R7). Awaiting final dev pass + owner go.
