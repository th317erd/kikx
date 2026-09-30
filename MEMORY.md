# Kikx Session Memory

Last updated: 2026-09-30 (session approaching context limit; compaction failing)

## How to resume
1. Read `~/.codex/startup.md` (already mandatory), then `.codex/DETAILS.md`, `.codex/quirks.md`,
   `bot-docs/plans/session-work-area.md`, and this file.
2. Repos: `kikx` (`main`, remote `th317erd/kikx`), `kikx-plugin-ollama` and
   `kikx-plugin-codex` (private, `th317erd/*`). All were pushed clean at last check.
3. Dev stack: AeorDB at `127.0.0.1:6830` (binary v0.9.5), Kikx at `127.0.0.1:3001`.
   Restart Kikx after client changes: kill `start-kikx-dev`/`src/server/index.mjs`, then
   `set -a; . ./.env.dev; set +a; nohup npm run start:kikx:dev > /tmp/codex/kikx/kikx.log 2>&1 &`.
4. Login links: `npm run magic-link` (strip ANSI; verify via GET
   `/api/v1/auth/magic-link/verify?code=`). UI tests: UI scripts run through
   `scripts/with-aeordb-token.mjs` which exchanges the AeorDB root key ONCE and passes
   `AEORDB_TOKEN` to all child processes (fixes 429 rate limiting).
5. Browser verification: `~/Programs/bot-ocr <img...>` for OCR (global quirk, in
   `~/.bot-common/quirks.md`). Brave DevTools on `http://127.0.0.1:9222` via puppeteer-core
   (connect, `setCacheEnabled(false)`).
6. Gates: `npm test`; `npm run test:ui:stagehand`; `npm run test:ui:puppeteer`;
   `npm run test:ui:playwright`. Stagehand occasionally flakes with
   `ConnectionTimeoutError` (Chrome launch contention, 21 parallel browsers / 16 CPUs) —
   environmental, not a code failure.

## What shipped this session (chronological, all pushed)
1. **Ollama provider plugin** (`kikx-plugin-ollama`, private) + async provider descriptors
   in kikx core (`AgentInterface.resolveConfigFields()` async; registry/manager/service
   async; per-provider failure tolerance). Native Ollama `/api/chat`, dynamic model
   discovery, tool loop, compaction-safe `ask()`.
2. **Core bug fix**: shared `ask()` loop dropped provider `Done{usage}`; now sums usage
   across draft + completion-review passes.
3. **Codex plugin** (`kikx-plugin-codex`): completion-review handling + request timeout;
   same compaction fix. Private repo.
4. **Composer Up/Down history** (Task 1 from the old self-killed session).
5. **Session work area (Task 2)**: workspace **grid of session cards** (HTML, NOT canvas —
   owner ruling after measured 120Hz canvas failure), `kikx-chat-view` (full/mini modes),
   `kikx-session-card`, `kikx-session-grid`, `chat-view-model.mjs`. Mini cards = real chat
   scaled via CSS `transform`.
6. **Recursive navigation stack**: `src/client/state/navigation-stack.mjs`
   (`{sessionID, collapsed}` entries). Enter session = push; Close = pop; breadcrumb
   navigates; sub-session frames (`content.references`) render as live mini cards that open
   the session. Sidebar kept as empty "Workspace" shell.
7. **Bulk preview endpoint**: `POST /api/v1/sessions/previews` (bounded tail per session,
   no FrameEngine hydration) + `AeorDBFrameStore.listSessionPreviews`.
8. **Server stamps `content.references`** on tool results (`ToolExecutionService`,
   `PluginInterface.referencesFor()`, `SessionCreateTool`).
9. **URL sync**: navigation stack serialized to `?session=…&collapsed=1`; reload restores;
   back/forward via popstate. (Root cause of an earlier bug: `setNavigationStack` was
   imported nowhere.)
10. **Add-session**: server `POST /api/v1/sessions` now accepts `parentSessionID`; Add card
    creates a child of the current grid's parent.
11. **Editable window title** (rename): click the BIG window header title → input → Enter/blur
    PATCH. Breadcrumb is navigation-only (owner clarified: breadcrumb is the feature).
12. **Empty state**: "No messages yet." + hint `Type /invite 'name of party' to invite an
    agent, or other party`.
13. **Master (coordinator) agents / crown**: `crownedAt` (HLC micros) + `crownedClock`
    (monotonic HLC string) on agents; `setAgentCrowned`, `listMasterAgents`,
    `resolveDefaultAgent({excludeAgentIDs})` (backup chain #1→#2→#3). Routes
    `POST /api/v1/agents/:id/crown|uncrown`, `GET /api/v1/agents/masters?resolve=1&exclude=`.
    UI crown toggle per row, rank colors gold/silver/copper with decreasing opacity.
    Master consumption (default agent for empty session etc.) is DEFERRED.

## Current in-progress task (three latest screenshots + one more)
From `/home/wyatt/wyatt-desktop/screenshots/Session-session-2026-09-30-03-17-02.742.png`,
`...03-19-53.394.png`, `...03-21-04.640.png`, `...03-27-26.604.png`:

1. **DONE** — Title input collapse on focus: removed `max-width: 420px` from
   `.kikx-window__title-input` (it couldn't flex; actions jumped left). Verified actions stay
   at x=1501. (CSS only, not yet committed with the rest.)
2. **IN PROGRESS / ~done** — Edit Agent Delete → `aeor-confirm-button` (the component is
   named `aeor-confirm-button`, NOT `aeor-progress-button`; hold-to-confirm, duration 1000ms).
   Added import in `src/client/lib/aeor-ui.mjs`, CSS link in `src/client/index.html`,
   `_buildAgentDeleteButton()` in `kikx-app.mjs` with `class="confirm-button-danger"`.
   LIVE-VERIFIED: exists, label Delete, duration 1000, red fill `rgb(162,5,0)`, red text
   `rgb(255,84,75)`. NEEDS: commit + Stagehand coverage.
3. **PENDING** — Agents modal **filter pills**: plugin providers (Codex, DeepSeek, Gemini,
   Claude, Grok) plus "Masters" and "Hidden" categories.
4. **PENDING** — Crown icons must be **right-aligned** next to the gear icon (currently the
   crown is in the middle and shifts with name length → looks bad).
5. **PENDING** — Crown click must NOT close/reopen the Agents modal. Currently
   `_toggleAgentCrown` calls `this._render()` which rebuilds the whole modal (flicker).
   Fix: update the affected rows in place (like `_syncSessionShell`) instead of full render.

## Key design constraints / owner rulings
- **No canvas/WebGL** for the work area (HTML chosen; measured canvas failed at 120Hz).
- Sidebar is a wanted empty shell for later repurposing.
- Breadcrumb = navigation feature (do NOT make it editable). Window title = rename target.
- Sub-sessions are a normal message type with a "click to enter" action.
- All chat messages should eventually be clickable with type-specific actions.
- Master agents: #1 primary, #2 first backup, etc., ordered by `ORDER BY crowned_at DESC`.
- Naming by scope: top = "Project", child = "Session", grandchild+ = "Sub-Session".

## Open / owed work
- Master-agent **consumption**: use `resolveDefaultAgent` when a user talks in an empty
  session, and re-resolve excluding errored agents for the backup chain.
- **Lazy-load older frames** on scroll-up (owner explicitly wants real lazy loading; not
  done).
- Agents modal filter pills; crown alignment; crown no-modal-flicker (current).
- Optional: serialize the UI test suite to remove the Chrome-launch flake.

## Notes / process
- `bot-ocr` works and is recorded as a global quirk; use it for every owner screenshot.
- Avoid self-`ssh wyatt-desktop` when already on wyatt-desktop.
- Don't over-invest in blind debugging; check the simple thing first (e.g. a missing import).
- AeorDB auth: exchange once, reuse JWT until expiry, then refresh — never per test process.
