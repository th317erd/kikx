# TODO: Add Solr Docker Container to Kikx

## Phase 1: File Creation — COMPLETE
- [x] Create `docker-compose.yml` — Solr 9 service with persistent volume
- [x] Create `scripts/solr-start.sh` — standalone quick-start script (includes auto-permission fix)
- [x] Create `solr/kikx/conf/schema.xml` — schema with frame/tool-log/generic fields
- [x] Create `solr/kikx/conf/solrconfig.xml` — minimal config with autocommit
- [x] Create `solr/kikx/conf/stopwords.txt` — standard English stopwords
- [x] Create `solr/kikx/conf/synonyms.txt` — empty synonyms placeholder
- [x] Create `.dockerignore` — exclude node_modules, data, spec, etc.
- [x] Update `.gitignore` — add `data/solr/`

## Phase 2: Verification — COMPLETE
- [x] `docker-compose up -d` — Solr starts without errors
- [x] Verify kikx core exists via admin API — `initFailures: {}`, core status OK
- [x] Verify all 17 schema fields present via `/solr/kikx/schema/fields`
- [x] Test indexing a document — status 0, QTime 153ms
- [x] Test searching for the document — found 1 result, correct content
- [x] Test `scripts/solr-start.sh` standalone — starts correctly
- [x] Verify data persists across container restart — test doc survived restart

## Notes
- Schema file is `schema.xml` (not `managed-schema.xml`) — required by ClassicIndexSchemaFactory
- Data volume at `./data/solr/` needs UID 8983 ownership — scripts handle this automatically
- Solr 9.10.1 pulled and tested
