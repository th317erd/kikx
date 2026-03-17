# Project Details

Important details to remember across sessions.

---

## Project Identity

- **Name:** Kikx (formerly Hero)
- **Repo:** https://github.com/th317erd/kikx
- **Branch:** v2
- **Location:** ~/Projects/kikx-workspace/kikx (symlinked from ~/Projects/hero)
- **Standalone plugin:** ~/Projects/kikx-workspace/kikx-plugin-claude

## Planning Workflow

- **`.claude/conversation.md`** — Current planning conversation (overwritten per topic). User annotates with `<!-- comments -->`.
- **`.claude/TODO.md`** — Execution plan, updated as we go.
- **`bot-docs/plan/kikx/server-plan.yaml`** — Formal plan YAML (874 lines, fully updated through Round 19)
- **`bot-docs/plan/kikx/client-plan.yaml`** — V2 client plan
- **`bot-docs/plan/kikx/future-plans.yaml`** — Index of all future plan items with status
- **`bot-docs/future-plans/*.yaml`** — Individual future plan specs

## Credentials & Config

- Test login: `test-bot@kikx.com` / `securePass123`
- Test agent: `test-claude` (agt_d6k1n1wpe7dy5tq17hcg, pluginID: `claude`, has valid Anthropic API key)
- Test agent: `test-claude-2` (agt_d6n3g30pe7dwfan9erdg, pluginID: `claude`, same API key as test-claude)
- Test session: `Test Session` (ses_d6k1npepe7dy5tq17hd0)
- Config directory: `~/.config/kikx/`
- V2 database: `~/.config/kikx/kikx.db`
- V2 server port: 8089
- V2 server entry: `src/server/index.mjs`
- V2 URL: `https://wyatt-desktop.mythix.info/kikx/`
- nginx master config: `~/www/sites/wyatt-desktop.mythix.info.conf`
- nginx include: `nginx/locations.nginx-include`
- **Start server:** `KIKX_PLUGIN_PATHS=~/Projects/kikx-workspace node src/server/index.mjs` (requires Node 24)
- **Test command:** `npm test` (unit tests: `spec/{client,core,server,shared,integration,scripts}/**/*-spec.mjs`)
- **E2E test command:** `npm run test:e2e` (requires running server, `spec/e2e/**/*-spec.mjs`)

## Current Branch

`v2`

---

## V2 Build Status (as of 2026-03-15)

- **Phase 1 (MVP, Steps 1-13):** COMPLETE
- **Phase 2 (V1 Parity, Steps 14-19):** COMPLETE
- **Phase 3 (V2 Differentiators):** IN PROGRESS
- **Phase C (Frame Event Router):** COMPLETE (C1-C4)
- **E2E Integration:** VERIFIED (92 frames, 0 errors in comprehensive permission E2E)
- **Test count:** 3355 tests, 0 new failures (2 pre-existing in multi-agent-streaming-spec)

## Current Work: "Abilities" → "Behaviors" Rename (in progress 2026-03-17)

- Renaming the "abilities" system to "behaviors" across all V2 code
- Agent model methods: `getAbilities`→`getBehaviors`, `setAbilities`→`setBehaviors`, `hasAbilities`→`hasBehaviors`
- Primer delimiters: `--- ABILITIES ---` → `--- BEHAVIORS ---`
- Behaviors re-injection module renamed: `abilities-reinjection.mjs` → `behaviors-reinjection.mjs`
- Client ability-list-modal and ability-wizard-modal components DROPPED (behavior management through agent tool calls)
- Client abilities API endpoints, store scope, and i18n strings removed
- Agent model `getBehaviors()` has backward compat fallback: `config.behaviors || config.abilities || null`

## Previous Work: SSE Auto-Reconnection (completed 2026-03-17)

- SSE stream now auto-reconnects after server restart, network hiccup, or stream drop
- Exponential backoff: 2s → 4s → 8s → 16s → ... → 30s cap
- Max 20 reconnect attempts before giving up
- Backoff resets on successful reconnection
- Intentional disconnect (`_disconnectStream()`) cancels all pending reconnects
- New state: `_sseReconnectAttempts`, `_sseReconnectTimer`, `_sseSessionID`
- Methods: `_openSSEConnection()`, `_scheduleReconnect()` (split from `_connectStream()`)
- Test file: `spec/client/sse-reconnection-spec.mjs` (21 tests)

## Previous Work: Instruction Re-injection + Concurrent Multi-Agent

### Instruction Re-injection (completed 2026-03-17)
- Agent `instructions` field now re-injected after context truncation (same as behaviors)
- New module: `src/core/interaction/instructions-reinjection.mjs`
- Integrated into `InteractionLoop.startInteraction()` after `reinjectBehaviors()`
- Primer assembler now receives `participants` for multi-agent context section
- `AgentResolver.resolve()` now preserves `hasBehaviors`/`getBehaviors`/`getConfig` methods

### Concurrent Multi-Agent Execution (completed 2026-03-17)
- `SchedulerOrchestrator._triggerNext()` now fires all available agents concurrently
- Per-agent `isActive(sessionID, agentID)` check replaces session-level blocking
- `_processCommit()` calls `_triggerNext()` immediately after queuing
- Client-side `_activeInteractionCount` counter prevents premature state clearing

## Previous Work: Event-Driven DOM Rendering Refactor — COMPLETE

**Status:** ALL STEPS COMPLETE. Session page reduced from ~2463 to ~2046 lines.
**Plan:** `bot-docs/future-plans/event-driven-rendering.yaml`
**TODO:** `.claude/TODO.md` (detailed step-by-step with completion status)

**Completed steps:**
- Steps 1-3: `createFrameElement()` factory + `frame:added`/`frame:updated` event handlers
- Step 5: Unified entry points (all data through `merge()`)
- Step 6: Optimistic user messages with ghost styling (`.pending` class)
- Step 4: Phantom frames for streaming (replaced manual DOM with FrameManager phantoms)
- Step 7: Bulk load performance (DocumentFragment batch rendering)
- Step 8: Cleanup (~417 lines of dead code removed)

**Commits:**
- `459d148` — Steps 1-3, 5, 6, 8
- `644c2c7` — Steps 4, 7 (phantom streaming + batch load)

**Key files modified:**
- `src/client/components/kikx-session-page/kikx-session-page.mjs` — Main refactor target
- `src/client/components/kikx-interaction/kikx-interaction.mjs` — Pending ghost CSS
- `spec/client/multi-agent-streaming-spec.mjs` — Rewritten for phantom interface
- `spec/client/create-frame-element-spec.mjs` — Pure factory TDD tests
- `spec/client/event-driven-rendering-spec.mjs` — Event pipeline TDD tests

**Test count:** ~3291 tests, 0 failures

### Completed Future Plans

| Feature | Completed |
|---------|-----------|
| Markdown Conversion | 2026-03-13 |
| Ed25519 Identity + ValueStore + Danger Level | 2026-03-14 |
| Behaviors System (formerly Abilities) | 2026-03-12 |
| Inter-Agent Streaming | 2026-03-10 |
| Agent Memory Context | 2026-03-11 |
| Agent Deliberation (child sessions) | 2026-03-11 |
| Sessions-as-Frames | implemented |
| Generator Suspension | implemented |

### Remaining Future Plans (not yet implemented)

| Feature | Priority |
|---------|----------|
| ~~Event-Driven DOM Rendering~~ | COMPLETE (all 8 steps) |
| Device Approval Auth | Medium |
| Key Rotation | Medium |
| Applicable Permitters | Low |
| Constraint Warnings | Low |
| Configurable Plugin Ordering | Low |
| General Re-feed Recovery | Low |
| checkPermission API Rename | Low |
| Agent Avatar Picker | Low (deferred) |
| Message Screenshots | Low (deferred) |
| Rich Content Renderers | Low (deferred) |
| Signatures & Federation | Low (deferred) |

## V2 Key File Locations

- **V2 server entry:** `src/server/index.mjs`
- **Server scaffold:** `src/server/app/application.mjs`
- **Auth system:** `src/server/auth/index.mjs` (AuthService, JWT helpers, middleware)
- **Permissions:** `src/core/permissions/permission-engine.mjs` (PermissionEngine)
- **Permission model:** `src/core/models/permission-rule-model.mjs` (PermissionRule)
- **Internal plugins:** `src/core/internal-plugins/` (shell, websearch, help)
- **Help index:** `src/core/help/help-index.mjs`
- **WebSocket transport:** `src/server/transport/websocket-transport.mjs`
- **FrameManager:** `src/shared/frame-manager/frame-manager.mjs`
- **Frame Router:** `src/core/routing/frame-router.mjs`
- **Selector Compiler:** `src/core/routing/selector-compiler.mjs`
- **Base Plugin Class:** `src/core/routing/base-plugin-class.mjs`
- **Interaction Loop:** `src/core/interaction/index.mjs`
- **Context Truncation:** `src/core/interaction/context-truncation.mjs`
- **Message History:** `src/core/interaction/message-history.mjs`
- **Behaviors Re-injection:** `src/core/interaction/behaviors-reinjection.mjs`
- **Frame Signing Utility:** `src/core/crypto/frame-signing.mjs`
- **Markdown Converter:** `src/core/lib/markdown-converter.mjs`
- **Primer Assembler:** `src/core/primer/index.mjs`
- **Agent Model:** `src/core/models/agent-model.mjs`
- **V2 Client:** `src/client/` (Waves A-I complete, 38 components)
- **Plan YAML:** `bot-docs/plan/kikx/server-plan.yaml`
- **Future plans index:** `bot-docs/plan/kikx/future-plans.yaml`
- **Future plan specs:** `bot-docs/future-plans/*.yaml`
- **User message pipeline:** `bot-docs/docs/user-message-pipeline.md` — full data flow from HTTP request to frame creation

## Known Issue: node:sqlite

Node 24 is required for the built-in `node:sqlite` module (used by mythix-orm-sqlite).

---

## Mythix UI Resources

- **Docs:** `~/Projects/mythix-ecosystem/mythix-ui-core/docs/`
- **Example apps:** `~/Projects/genesis-forge-client`, `~/Projects/mythix.info`
- **Pattern:** Split files (HTML + JS), `Component.register()`, `@@expression@@` templates

## AGIS

- **Runtime:** `/home/wyatt/Projects/agis/docs/runtime.md`
- **Scripts:** `/home/wyatt/Projects/agis/scripts/*.agis`
- **Invocation:** `::agis.script_name topic`
- **Mandatory reflexes:** `::agis.test_check` before writing/committing code
