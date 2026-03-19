# TODO: Solr Integration

## Docker Container Setup — COMPLETE
- [x] `docker-compose.yml`, `scripts/solr-start.sh`, schema, config, .dockerignore, .gitignore

## SolrService Module — COMPLETE
- [x] `src/core/lib/solr-service.mjs` — SolrError + SolrService (fetch-based)
- [x] Methods: ping, getCoreStatus, search, indexDocuments, deleteDocuments, deleteByQuery, commit, stream
- [x] Wired into Application._initializeCore() → context.setProperty('solrService')
- [x] ControllerBase.getSolrService() accessor added
- [x] 58 unit tests, full suite 3758/3758 passing
