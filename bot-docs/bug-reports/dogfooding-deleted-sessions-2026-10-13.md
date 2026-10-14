# Dogfooding session — soft-deleted sessions feature build

Date: 2026-10-13
Operator: assistant, driving the **prod Kikx UI** (session "Kikx", bot "Zav") in
a headless Chromium (Playwright, `/usr/bin/chromium`) to dogfood the
"view & recover soft-deleted sessions" feature.

Context: the operator sent the feature brief through the Kikx web UI, answered
the bot's one design fork (A: search centered, editable name relocated), and
monitored the bot's implementation through the UI.

## Issues observed while using Kikx

1. **SSE `/api/v1/events` shows repeated `net::ERR_INCOMPLETE_CHUNKED_ENCODING`
   in the browser.** Traced to the client's **1 MiB SSE buffer resync (stability
   S2)** — it intentionally drops and reconnects past the cap. Server-side the
   stream is healthy: `curl -N` held the connection open 35 s+ and delivered
   ~60 MB of live events (heartbeat + `frame.phantom`). **Not a server bug.**
   Separately: the phantom-frame volume during a turn is heavy (~1.7 MB/s,
   ~60 MB/35 s of `AgentThinking` deltas) — worth a performance look later.

2. **A resource 404 console error on page load** ("Failed to load resource: 404")
   appeared in early probe runs but **did not reproduce** once per-response
   logging was enabled — likely a favicon or minor asset. Needs the exact URL to
   confirm; low priority.

3. **Auth is in-memory.** Every fresh page load requires a new single-use magic
   link; there is no persisted browser session. Operator automation must mint a
   code per login (read from the Kikx stdout `[kikx-auth]` line, since prod has no
   `KIKX_AUTH_MAILER_LOG_PATH`). Consider a persistent session or a mailer-log
   path for prod.

4. **The bot edits files via `/tmp/patch-*.mjs` + `node` shell scripts** rather
   than a first-class file-edit tool. It works, but suggests the agent toolset
   could use a direct read-modify-write editor.

## Feature build outcome

- Server: `session-routes.mjs` gained `includeDeleted` on the list and a
  `POST /api/v1/sessions/:id/restore` route; `route-matchers.mjs` gained
  `matchSessionRestoreRoute`.
- Client: new `src/client/state/session-visibility.mjs`; changes across
  `kikx-session-grid/-card/-shell-builders`, `kikx-state.mjs`,
  `session-state-utils.mjs`, `app.css` (centered search + floating eye + reddish
  deleted tint + recycle action).
- Tests: new `session-visibility-spec`, `session-deleted-bucket-spec`,
  `session-restore-route-spec`, `deleted-sessions-stagehand`; existing specs
  updated.

## Outcome (verified)

Committed and pushed as `0fba2f9` "Add view & recover soft-deleted sessions",
plus follow-ups `ef3cb2c` (restore the `getSessions` import — a regression the
feature work introduced, caught and fixed), `0517367` and `23fa412` (browser-spec
stabilization). Full suite: **1321 tests / 1292 pass / 0 fail / 29 skipped**.

Independently verified by driving the **dev** UI (`:3001`, real Chromium):
- Search input + eye toggle present in the header.
- Default view 6 cards, 0 deleted (hidden).
- Eye ON → 12 cards, 6 deleted, rendered reddish
  (`bg rgb(30,20,22)` / `border rgb(122,59,59)` vs live `rgb(23,28,33)`).
- Search filters by title (2 results for "Ring Probe").
- Recycle on a deleted card → deleted 6 → 5; the session returned live
  (`deletedAt=null`, live 6 → 7). Soft-delete semantics preserved.

Note: prod (`:3099`) still runs `kikx/kikx:28bcfd9` without this feature; dev has
it. Not deployed (deploy not requested).
