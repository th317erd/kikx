# Kikx Session Memory

Last updated: 2026-09-30 (session approaching context limit; compaction failing)

## How to resume
0. **AEOR HTML framework**: before touching ANY client UI, load the skill at
   `~/.claude/skills/aeor-web-components/SKILL.md` (canonical checkout
   `/home/wyatt/Projects/aeor-web-components`; NOT `~/Projects/aeor-components`). Read
   `IMPLEMENTATION-GUIDE.md`, then the companion
   `bot-docs/docs/framework-skill-reference.md`. Key contracts: use the real shared
   modules (elements.js/reactive-state.js/query.js); `ReactiveState` observes top-level
   assignments only (replace objects/arrays, no nested mutation); builder children use
   `cond ? x : null` (boolean false becomes text "false"); events are `.onChange/.onInput/
   .onKeydown` (first letter after "on" lowercased); binding attribute names are NOT
   kebab-normalized (`['aria-label'].bindState(...)`); modals lift `.modal-footer-actions`
   out of their parent (submit buttons there need native `form="id"`); don't rebuild a
   modal/control just to update text (calls `__bindings` cleanup / can replay animations).
   Kikx uses this framework; the client is under `src/client/`.
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

## Recent task batch (4 screenshots) — ALL DONE (commit c63206d + next commit)
From `Session-session-2026-09-30-03-17/03-19/03-21/03-27*.png`:
1. **DONE** — Title input collapse on focus: removed `max-width: 420px` from
   `.kikx-window__title-input`. Actions stay pinned.
2. **DONE** — Edit Agent Delete → `aeor-confirm-button` (real component name; NOT
   `aeor-progress-button`; hold-to-confirm, duration 1000ms, red `confirm-button-danger`).
   Import in `src/client/lib/aeor-ui.mjs`, CSS link in `src/client/index.html`,
   `_buildAgentDeleteButton()` in `kikx-app.mjs`.
3. **DONE** — Agents modal filter pills: `src/client/components/agent-list-model.mjs`
   (pure; `agentFilterPills`/`filterAgents`) + `.kikx-agent-filter` pills UI. Pills are
   DERIVED from providers actually present (All, Masters, one per provider displayName,
   Hidden). Spec `spec/client/agent-list-model-spec.mjs`.
4. **DONE** — Crown icons right-aligned with gear via `.kikx-agent-list__row-actions`.
5. **DONE** — Crown click no longer rebuilds the modal: `_repaintAgentCrowns()` updates
   rank classes/pressed + `_syncAgentStatusText()` in place.
   NOTE: this introduced a bug (stale agent refs on 2nd click) fixed by re-reading
   `this._state.agentDetailsByID[agent.id]` in `_toggleAgentCrown`.

## Goal-post: filter-pill / crown / masters-cap fixes (DONE, this batch)
1. **Pills no longer close/reopen the modal**: `_buildAgentManagerBody()` +
   `_repaintAgentManagerBody()`; `_setAgentFilter` swaps only the body, not the modal.
2. **Crown clicks reliable**: rapid clicks were racing concurrent requests (5 clicks -> 5
   requests). Added `_pendingCrownAgentIDs` in-flight guard + `_setAgentCrownBusy()` (disables
   the button while pending). 5 rapid clicks now -> 1 request.
3. **Masters = rolling top-3**: `MAX_MASTER_AGENTS = 3` in BOTH
   `src/core/aeordb/aeordb-agent-store.mjs` (crowning a 4th evicts the oldest; `readCrownedAgents()`
   uncapped internal reader; `listMasterAgents()` capped) and
   `src/client/components/agent-list-model.mjs` (`rankMasters()` caps at 3; `filterAgents`
   'masters' uses it). Client `masterRankByAgentID` delegates to `rankMasters`.
   NOTE: existing DBs may still hold >3 crowned rows; they no longer rank, and the next crown
   evicts them. No backfill run.

## Goal-post: crown divergence root cause (DONE)
The "glitchy crown clicks" root cause was **client/server state divergence**, not just
click racing: crowning a 4th master makes the SERVER evict the oldest, but the old crown
response returned only the toggled agent, so the client kept stale crowned entries. After
several crowns the client sent the wrong toggle, producing "Crowned X" with no icon change.
FIX: crown endpoint now returns `data.masters` (authoritative top-3); client
`_reconcileMasters(masters)` marks exactly those and clears all others. Verified: 8
sequential crowns -> client===server===3, icon always matches, 0 mismatches.
Also: `~/Projects/aeor-components` does NOT exist; the real path is
`~/Projects/aeor-web-components` (Kikx vendors it at `/vendor/aeor-web-components/`).
Framework offers `ReactiveState` + element `.bindState()` + a `$` query engine; Kikx uses
kikxState/bindState for simple fields but the Agents modal is imperative (nested
agentDetailsByID map does not fit bindState's top-level keys cleanly).

## Goal-post: source-file refactor wave (DONE, pushed a606fc4)
Ran a 7-branch parallel refactor (one isolated git worktree per file, sub-agent each,
disjoint file sets) to satisfy the new AGENTS.md line limits. All merged --no-ff.
Target files after: kikx-app 2508->426; agent-interface 1518->369; create-server
1216->264; agent-route-frame-plugin 1075->212; aeordb-frame-store 1064->7;
process-manager 939->424; frame-runtime 802->315. 62 new modules, all <=426 lines.
ZERO behavior changes: unit 424/424 on combined revision; Stagehand 22/22; live Brave
smoke clean (app mounts, grid/agents/modals render, 0 console errors).
**No hand-written src file now exceeds the 800 hard limit.** Still over the 500 soft
limit (informational, future work): session-tools 798, markdown-renderer 677,
tool-use-base 635, compaction-service 585, frame-engine 584, aeordb-agent-store 577,
tool-execution-service 522, frame-manager 516.
Notes: `src/server/node_modules/` was already gitignored (no action). kikx-app refactor
used composition (builder fns take `app`); methods preserved as instance delegates.
Flagged not fixed: `_deleteAgent` uses bare `fetch` without `_apiHeaders()`.

## Next up (not started)
- Stagehand coverage for crown alignment/flicker/confirm-button + filter pills + top-3 cap.
- Master-agent **consumption** (resolveDefaultAgent for empty-session default agents).
- True lazy-loading of older frames on scroll-up.

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
