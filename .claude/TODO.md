# Phase 4 — Foundation (Client Infrastructure)

## Prerequisites
- [x] FrameManager (Phase 3 — complete, in src/shared/frame-manager/)
- [x] Client plan (7 rounds of design Q&A — complete, in bot-docs/plan/hero/client-plan.yaml)
- [x] Commit planning work

## Tasks

### Wave A: Base Infrastructure (sequential — everything depends on these)
- [x] 1. Project structure: src/client/index.html (importmap), directory layout
- [x] 2. Base utilities: src/client/lib/base-utilities.mjs + constants.mjs
- [x] 3. Design system CSS: src/client/styles/theme.css (black-glass vars, reset, scrollbars)

### Wave B: Core Libraries (parallel — independent of each other)
- [x] 4. Query engine: src/client/lib/query-engine.mjs ($m / $$m) + tests
- [x] 5. Elements: src/client/lib/elements.mjs (ElementGenerator, Term, build) + tests
- [x] 6. i18n: src/client/lib/i18n.mjs + src/client/lib/locales/en.mjs + tests
- [x] 7. Store: src/client/lib/store.mjs (seqda global store with scopes) + tests
- [x] 8. API client: src/client/lib/api.mjs (REST client layer) + tests
- [x] 9. Router: src/client/lib/router.mjs (history-based) + tests
- [x] 10. nginx config: update for static file serving

### Wave C: Root Components (depends on Wave B)
- [x] 11. hero-application: src/client/components/hero-application/hero-application.mjs + tests (10 tests)
- [x] 12. hero-login-page: src/client/components/hero-login-page/hero-login-page.mjs + tests (15 tests)
