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

- Test login: `test-bot@kikx.com` / `securePass123` (V2 database)
- Test login (V1/browser): `claude` / `claude123`
- Test agent: `test-claude` (agt_d6k1n1wpe7dy5tq17hcg, pluginID: `claude`, has valid Anthropic API key)
- Test session: `Test Session` (ses_d6k1npepe7dy5tq17hd0)
- Config directory: `~/.config/kikx/`
- V2 database: `~/.config/kikx/kikx.db`
- V2 server port: 8089
- V2 server entry: `src/server/index.mjs`
- V2 URL: `https://wyatt-desktop.mythix.info/kikx/`
- nginx master config: `~/www/sites/wyatt-desktop.mythix.info.conf`
- nginx include: `nginx/locations.nginx-include`
- **Start server:** `KIKX_PLUGIN_PATHS=~/Projects/kikx-workspace node src/server/index.mjs` (requires Node 24)

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

## V2 Build Status (as of 2026-03-02)

- **Phase 1 (MVP, Steps 1-13):** COMPLETE
- **Phase 2 (V1 Parity, Steps 14-19):** COMPLETE
  - Step 14: Permissions System (PermissionRule model + PermissionEngine)
  - Step 19: Permission Fingerprinting (HMAC-SHA256 via Keystore)
  - Step 17: Shell Plugin (shell-quote command parser + per-command permissions)
  - Step 16: Websearch Plugin (Puppeteer + Turndown html-to-markdown)
  - Step 18: Help System (HelpIndex aggregator + HelpTool plugin)
  - Step 15: WebSocket Transport (ws, reconnection via lastSeenOrder)
- **Phase 3 (V2 Differentiators):** NOT STARTED
- **E2E Integration:** VERIFIED (2026-03-02)
  - V2 server running on port 8089 with Mythix framework
  - Auth (login/register) working with password-based JWT
  - Agent plugin loading via KIKX_PLUGIN_PATHS env var
  - API key encryption/decryption via JWT vault (UMK → user key → AES-GCM)
  - Full interaction loop: user message → Claude API → HTML response → frames persisted
  - Multi-turn conversation verified (context preserved across turns)
  - Browser login + session page rendering via Puppeteer

## Bugs Fixed During E2E Testing

1. **Route param names:** Routes used `capture('id')` but controllers expected `params.sessionId`, `params.agentId`. Fixed to use descriptive capture names (`capture('sessionId')`, `capture('agentId')`, `capture('participantId')`).
2. **Agent pluginID mismatch:** Agent created with `pluginID: 'claude-agent'` but plugin registers as `'claude'`. Fixed agent record.
3. **Plugin API key resolution:** `kikx-plugin-claude` tried to re-decrypt `agent.encryptedAPIKey` inside generator instead of reading pre-decrypted `agent.apiKey`. Fixed to check `agent.apiKey` first.
4. **KikxCore table creation:** `createTable(Model)` failed if table existed. Fixed with `{ ifNotExists: true }`.
5. **Auth middleware:** Mythix sets `request.mythixApplication`, not `request.application`. Fixed.
6. **skipAuthorization:** Mythix passes `context.controllerMethod`, not `context.methodName`. Fixed.
7. **Mythix route DSL:** `endpoint('')` (empty string) adds extra path segment. Rewrote routes with non-empty endpoint names.

## V2 Key File Locations

- **V2 server entry:** `src/server/index.mjs`
- **Server scaffold:** `src/server/app/application.mjs`
- **Auth system:** `src/server/auth/index.mjs` (AuthService, JWT helpers, middleware)
- **Auth tests:** `spec/server/auth-spec.mjs` (56 tests)
- **Permissions:** `src/core/permissions/permission-engine.mjs` (PermissionEngine)
- **Permission model:** `src/core/models/permission-rule-model.mjs` (PermissionRule)
- **Internal plugins:** `src/core/internal-plugins/` (shell, websearch, help)
- **Help index:** `src/core/help/help-index.mjs`
- **WebSocket transport:** `src/server/transport/websocket-transport.mjs`
- **FrameManager:** `src/shared/frame-manager/` (will move to `src/core/frame-manager/`)
- **V2 Client:** `src/client/` (Waves A-I complete, 38 components)
- **Plan YAML:** `bot-docs/plan/kikx/server-plan.yaml`

## UI Redesign: Friends, Avatar, Sidebar, Settings (2026-03-02)

### New Components
- `kikx-user-avatar` — Circular avatar: base64 → Gravatar → initials fallback, inline MD5
- `kikx-friends-list` — Flat list of friends (agents + users) with avatar, name, AI badge
- `kikx-add-friend-modal` — Multi-step wizard: type selection → agent config / user invite

### Redesigned Components
- **Top bar:** Removed agents/new-session/logout buttons. Added avatar button (navigates to settings). `hide-back` attribute.
- **Sidebar:** Replaced Participants with Friends section. Added "+" buttons for add-friend and add-session events.
- **Settings page:** 6 tabs (added Logout). Profile tab has avatar upload/remove, editable email with verification stub.
- **Session page:** Event wiring for add-friend/add-session modals, agent loading → friends list

### Server Changes
- `User` model: added `avatar` field (TEXT long)
- `AuthController`: added `updateProfile` (PUT /auth/me), `me()` now returns avatar
- Routes: added PUT /auth/me
- Client API: added `updateProfile()`, Store: added `profile.updateUser()`

### Test Count
- Client tests: 102 (was 61)
- Total: 855 tests, 445 pass (was 395)

## Client UI Fixes (2026-03-02)

- **Login page:** Fixed CSS box-sizing on inputs/button, "Sign In" label (was "Send Magic Link"), password placeholder
- **Status bar:** Fixed `connection.subscribe()` → `store.on('update')` (seqda pattern)
- **Auth persistence:** Added localStorage save/load/clear for JWT token + user
- **Settings page:** Fixed back button (uses `navigate()` directly, was custom event), real form layouts in all 5 tabs
- **Top bar:** Removed Abilities button (user request), Agents button dispatches `open-agents-modal` event
- **Locale:** Updated `en.mjs` with all settings form strings, removed "Magic Link" references
- **Client tests:** 61 jsdom unit tests in `spec/client/` (api-spec.mjs + components-spec.mjs)
- **Test count:** 742 total (731 pass, 11 pre-existing Phase 3 failures)

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
