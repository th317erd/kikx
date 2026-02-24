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

# Phase 5 — Layout Shell & Core Features (Wave 1)

## Tasks

### Wave D: Layout Shell (parallel — independent components)
- [x] 13. hero-session-page: full layout container (top-bar + chat + sidebar + status-bar) + tests (12 tests)
- [x] 14. hero-top-bar: top nav (back arrow, session name, action buttons) + tests (18 tests)
- [x] 15. hero-sidebar: right panel (session list + participant list) + tests (12 tests)
- [x] 16. hero-status-bar: bottom bar (connection status, cost tracking) + tests (10 tests)

### Wave E: Session & Chat Core (depends on Wave D shell)
- [x] 17. hero-session-list: sidebar session list with categories, archive/revive + tests (17 tests)
- [x] 18. hero-chat-view: interaction stream container + scroll management + tests (17 tests)
- [x] 19. hero-message-input: compose area with send button + tests (20 tests)
- [x] 20. hero-scroll-anchor: jump-to-bottom floating button + tests (13 tests)
