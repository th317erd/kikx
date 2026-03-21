# TODO: Solr Indexing & Search Integration

> Plan: `bot-docs/plan/kikx/solr-indexing-and-search.yaml`
> All open questions resolved across 7 planning rounds in `.claude/conversation.md`

---

## Previous Work — COMPLETE
- [x] Ed25519 / Key-Pair Encryption Gaps (3793/3793 tests passing)
- [x] Solr Docker container + SolrService module (58 tests)
- [x] SolrService wired into Application + ControllerBase accessor

---

## Phase 1: Indexer
- [ ] 1.1 Revise Solr schema (unified fields, drop tool_*, merge content)
- [ ] 1.2 Frame.getContentForIndexing() on Frame model (TDD)
- [ ] 1.3 Document mapper module (TDD, depends on 1.2)
- [ ] 1.4 SolrIndexingPlugin — FrameRouter plugin (TDD, depends on 1.3)
- [ ] 1.5 ValueStore.onAfterSave() — model lifecycle hook (TDD)
- [ ] 1.6 Verify: send message → frame + tool log appear in Solr

## Phase 2: Search API
- [ ] 2.1 SearchController with DB content enrichment + contentRange (TDD)
- [ ] 2.2 Routes: POST /api/v2/search + POST /api/v2/sessions/:sessionID/search

## Phase 3: Agent Tools
- [ ] 3.1 Re-back tool_log:search with Solr (fallback to SQLite) (TDD)
- [ ] 3.2 search:query agent tool (TDD)

## Phase 4: Client Wiring
- [ ] 4.1 Wire sidebar search input to POST /api/v2/search
