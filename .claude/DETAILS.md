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

- **`.claude/conversation2.md`** — V2 server planning Q&A (Rounds 1-19 complete). User answers inline in HTML comments. OVERWRITE each round.
- **`.claude/conversation.md`** — Owned by another bot instance. DO NOT USE.
- **`bot-docs/plan/kikx/server-plan.yaml`** — Formal plan YAML (874 lines, fully updated through Round 19)
- **`bot-docs/plan/kikx/client-plan.yaml`** — V2 client plan (existing from earlier sessions)
- **`bot-docs/plan/kikx/frame-manager.yaml`** — FrameManager spec
- **`bot-docs/test/meta.yaml`** — AGIS plan test assertions (93 assertions)
- **`.claude/TODO.md`** — Execution plan, updated as we go.

## Credentials & Config

- Test login: `claude` / `claude123`
- Test agent: `test-claude` (has valid Anthropic API key)
- Config directory: `~/.config/kikx/`
- V2 database: `/tmp/kikx/kikx.sqlite`
- V2 server port: 8089
- V2 URL: `https://wyatt-desktop.mythix.info/kikx/`
- nginx config: `nginx/locations.nginx-include`

## Current Branch

`v2`

---

## V2 Server Planning Status (as of 2026-02-28)

### Rounds 1-19 COMPLETE — Plan YAML fully updated

All 19 rounds of design Q&A are complete and captured in `bot-docs/plan/kikx/server-plan.yaml` (874 lines). No open items remain.

### Key Decisions (summary)

**Architecture:** Embeddable core (`src/core/`) + thin Mythix server (`src/server/`). Entry: `createKikxCore(config)`.

**Data:** Mythix ORM (no StorageAdapter). Models from context, never direct imports. Versioned as static property.

**Plugins:** `setup(context)` returns teardown closure. Classes inside `setup()`. Conflicts: implicit override with warning.

**Interaction:** Async generator. Permission hard-break (generator destroyed, action persisted as frame, new interaction on approval). Queue + cancel UX for concurrent messages.

**Agent Output:** HTML (not HML). Two-channel: structured tool calls for server actions, inline HTML for display. Server-side sanitization via allowlist. Prompts via `<kikx-hml-prompt>` WebComponents.

**Security:** Zero-knowledge JWT-as-vault (UMK wrapped by REK). Password-only auth for now. No magic links. No server slot. Dev mode: deterministic REK.

**Build Phases:** 25 steps across 3 phases (MVP, V1 Parity, V2 Differentiators). See YAML for details.

---

## V1 Key File Locations (reference)

- **V1 Server entry:** `server/index.mjs`
- **V1 Database:** `~/.config/kikx/kikx.db`
- **V1 Streaming routes:** `server/routes/messages-stream.mjs`
- **V1 Interactions:** `server/lib/interactions/`
- **V1 Frames:** `server/lib/frames/`
- **V1 Test count:** ~2275 tests, 0 failures

## V2 Key File Locations

- **Server scaffold:** `src/server/app/application.mjs`
- **Auth system:** `src/server/auth/index.mjs` (AuthService, JWT helpers, middleware)
- **Auth tests:** `spec/server/auth-spec.mjs` (56 tests)
- **FrameManager:** `src/shared/frame-manager/` (will move to `src/core/frame-manager/`)
- **V2 Client:** `src/client/` (Waves A-I complete, 38 components)
- **Plan YAML:** `bot-docs/plan/kikx/server-plan.yaml`

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
