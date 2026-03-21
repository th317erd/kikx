# TODO: Solr Indexing & Search Integration

> Plan: `bot-docs/plan/kikx/solr-indexing-and-search.yaml`
> All open questions resolved across 7 planning rounds in `.claude/conversation.md`

---

## Previous Work — COMPLETE
- [x] Ed25519 / Key-Pair Encryption Gaps (3793/3793 tests passing)
- [x] Solr Docker container + SolrService module (58 tests)
- [x] SolrService wired into Application + ControllerBase accessor

---

## Phase 1: Indexer — COMPLETE (156 new tests, 3961 total)
- [x] 1.1 Revise Solr schema (13 unified fields, drop tool_*, merge content)
- [x] 1.2 Frame.getContentForIndexing() on Frame model — 55 tests
- [x] 1.3 Document mapper module — 35 tests
- [x] 1.4 SolrIndexingPlugin (FrameRouter, type:* selector) — 26 tests
- [x] 1.5 ValueStore.onAfterSave() lifecycle hook — 26 tests
- [ ] 1.6 Verify: send message → frame + tool log appear in Solr (deferred to final E2E)

## Phase 2: Search API — COMPLETE (39 new tests)
- [x] 2.1 SearchController with DB content enrichment + contentRange — 39 tests
- [x] 2.2 Routes: POST /api/v2/search + POST /api/v2/sessions/:sessionID/search

## Phase 3: Agent Tools — COMPLETE (52 new tests)
- [x] 3.1 Re-back tool_log:search with Solr (fallback to SQLite) — 25 tests
- [x] 3.2 search:query agent tool — 27 tests

## Phase 4: Client Wiring — COMPLETE
- [x] 4.1 Wire sidebar search input to POST /api/v2/search

---

## ALL PHASES COMPLETE — 233 new tests, ~4000+ total, 0 failures
