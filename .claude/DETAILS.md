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
- **Test command:** `npm test` (runs `node --test --test-force-exit --test-timeout=30000 'spec/**/*-spec.mjs'`)

## Current Branch

`v2`

---

## V2 Build Status (as of 2026-03-12)

- **Phase 1 (MVP, Steps 1-13):** COMPLETE
- **Phase 2 (V1 Parity, Steps 14-19):** COMPLETE
- **Phase 3 (V2 Differentiators):** IN PROGRESS
- **Phase C (Frame Event Router):** COMPLETE (C1-C4)
- **E2E Integration:** VERIFIED
- **Test count:** 2398 tests, 0 failures

### Completed Future Plans

| Feature | Completed |
|---------|-----------|
| Markdown Conversion | 2026-03-13 |
| Abilities System | 2026-03-12 |
| Inter-Agent Streaming | 2026-03-10 |
| Agent Memory Context | 2026-03-11 |
| Agent Deliberation (child sessions) | 2026-03-11 |
| Sessions-as-Frames | implemented |
| Generator Suspension | implemented |

### Remaining Future Plans (not yet implemented)

| Feature | Priority |
|---------|----------|
| Danger Level Permissions | Medium |
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
- **Abilities Re-injection:** `src/core/interaction/abilities-reinjection.mjs`
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
