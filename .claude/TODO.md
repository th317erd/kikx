# Mythix Routes Refactoring + ClaudeAgent Plugin Extraction

## Workstream A: Mythix Controllers + Routes

### Step 1: Foundation
- [ ] `src/server/controllers/controller-base.mjs` — Extends Mythix ControllerBase with core accessors
- [ ] `src/server/controllers/controller-auth-base.mjs` — Extends V2 ControllerBase, adds getMiddleware()
- [ ] `src/server/middleware/auth-middleware.mjs` — Mythix-compatible (request, response, next) middleware
- [ ] `src/server/middleware/index.mjs` — Re-exports

### Step 2: Controllers
- [ ] `src/server/controllers/auth-controller.mjs` — register, login, me
- [ ] `src/server/controllers/session-controller.mjs` — Session CRUD + archive/revive (7 methods)
- [ ] `src/server/controllers/participant-controller.mjs` — Participant list/add/remove (3 methods)
- [ ] `src/server/controllers/agent-controller.mjs` — Agent CRUD with API key encryption (5 methods)
- [ ] `src/server/controllers/interaction-controller.mjs` — sendMessage, cancel, approve, deny (4 methods)
- [ ] `src/server/controllers/frame-controller.mjs` — list (1 method)
- [ ] `src/server/controllers/stream-controller.mjs` — SSE stream connect (1 method)
- [ ] `src/server/controllers/index.mjs` — Re-exports all controllers

### Step 3: Routes + Application
- [ ] `src/server/routes/index.mjs` — Replace with Mythix DSL routes
- [ ] `src/server/application.mjs` — V2 Application extending MythixApplication

## Workstream B: ClaudeAgent Plugin Extraction

### Step 4: Plugin Migration
- [ ] `plugins/claude-agent/index.mjs` — ClaudeAgent class + setup(), using @anthropic-ai/sdk
- [ ] `plugins/claude-agent/package.json` — Declares @anthropic-ai/sdk dependency
- [ ] `src/core/plugins/index.mjs` — Remove ClaudeAgent re-export
- [ ] Delete `src/core/plugins/claude-agent/` directory

## Workstream C: Test Migration

### Step 5: Tests
- [ ] `spec/server/routes-spec.mjs` — Refactor to test controllers
- [ ] `spec/server/integration-spec.mjs` — Adapt to controller-based testing
- [ ] `spec/plugins/claude-agent-spec.mjs` — Move + update imports, mock SDK
- [ ] `spec/server/auth-spec.mjs` — Add Mythix middleware tests

### Step 6: Verification
- [ ] All server tests pass
- [ ] All plugin tests pass
- [ ] All core tests pass (no regressions)
- [ ] Commit
