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
- At the time of this report the bot was still iterating tests and a
  real-browser proof; **not yet committed**.
