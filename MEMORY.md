# Kikx Session Memory — handoff

Last updated: **2026-10-17** (session handed off). Branch: `main`. Working tree clean.
The previous contents of this file were replaced; the old version is in git history.
Prod is **behind HEAD** (see "Deploy state") — do not deploy unless the owner asks.

---

## 0. Rules for the next bot

- Follow `~/.codex/startup.md` / `~/.bot-common/startup.md` (mandatory), plus
  `~/.bot-common/quirks.md` and `rules.md`.
- **Images/screenshots/PDFs:** use `~/Programs/bot-ocr` (see quirks.md:14). Never
  guess, never use native vision. Invoke with Node 24 (see below). Examples:
  - `NODE=~/.config/nvm/versions/node/v24.21.0/bin/node; "$NODE" ~/Programs/bot-ocr shot.png`
  - `"$NODE" ~/Programs/bot-ocr --json shot.png | jq -r .ocr_text`
- **Deploys are owner-controlled.** Do NOT deploy unless explicitly asked. Commits
  and pushes only when asked.
- Ambient shell `node` is stale (**v21.7.3**). Use
  `/home/wyatt/.config/nvm/versions/node/v24.21.0/bin/node` for scripts/tools
  (v21 can't run the extensionless ESM `bot-ocr`).

---

## 1. Environment / paths

- **My checkout (this repo):** `/home/wyatt/Projects/kikx-workspace/kikx` — owner
  lane = stability/UI/architecture.
- **Production bot's clone:** `/home/wyatt/Projects/kikx-workspace/kikx2` (shares
  git origin). Old renamed app: `.../kikx2.oldapp` (not git).
- **Distribution container repo:** `.../kikx-docker` (`compose.yml`, `deploy.sh`,
  `.env`). Prod container name `kikx`, image tag from `KIKX_IMAGE_TAG`.
- **Dev servers:**
  - `:3001` — unit `kikx-dev-run.service`, `WorkingDirectory=.../kikx2` (prod bot's clone).
  - `:3002` — unit `kikx-dev2-run.service`, `WorkingDirectory=.../kikx` (my checkout),
    DB `kikx-dev2`. Both currently **active**.
- **Databases:**
  - Dev PG18 on `127.0.0.1:5434`; role `kikx-dev`; DBs `kikx-dev`, `kikx-dev2`.
    Superuser: `sudo -n -u postgres psql -p 5434`.
  - Prod PG17 inside the container on `127.0.0.1:5433`; role/DB `kikx`.
    Password file: `/home/wyatt/.local/share/kikx/postgres/db-password`.
  - **The app is PostgreSQL-primary** (`KIKX_DATABASE_DRIVER=postgresql`,
    `ORG_AEOR_KIKX_DATABASE_DRIVER=postgresql`). Documents (frames, commits, sessions,
    tool outputs, scheduled frames) live in the PG `documents` table
    (`path text, body text, raw boolean`), via `PostgreSQLConnection`. AeorDB is only a
    legacy companion service; **do not describe frames as files/AeorDB**.
- **Prod:** `http://127.0.0.1:3099` (health `:3099/health`).
- **Deploy command** (background + poll):
  ```
  sudo -n -u wyatt env HOME=/home/wyatt \
    PATH=/home/wyatt/.config/nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin \
    bash -c 'cd /home/wyatt/Projects/kikx-workspace/kikx-docker && exec ./deploy.sh <sha>'
  ```
  Log goes to `/tmp/opencode/deploy-<sha>.log`. Success: `[deploy] Deployed <sha>`.
- **Magic login link:** `npm run magic-link` (env overrides: `KIKX_URL`,
  `KIKX_PUBLIC_URL`, `KIKX_AUTH_MAILER_LOG_PATH`). The browser URL is the **app** with
  `?code=...` (e.g. `http://127.0.0.1:3002/?code=...`), NOT `/api/v1/auth/magic-link/verify`
  (that API returns raw JSON by design). Codes are single-use, short-lived.
- **Scratch probes:** `/tmp/opencode/kikx-ui/` (`prod.token`, node_modules symlink),
  `/tmp/opencode/*.log`, `/tmp/opencode/probe-stack.mjs` (Node inspector stack dump).

### Deploy state
- `HEAD` = `3b1c300` (pushed). **Prod container is on `62644c9`** — it does NOT yet
  include the compact-frame UI, the thinking-brain fix, or the latest polish. Owner
  said to wait before deploying.

---

## 2. Architecture facts learned this session

- **The frame stream is canonical.** UI/router are projections of stored frames.
- **Persist-then-route (implemented):** `FrameStore.connect({ onCommitted })` runs the
  callback *inside the write chain* after the commit's frames + commit record are
  durably stored. `FrameRuntime` wires `onCommitted → frameRouter.enqueueCommit(...)`.
  A failed write is never routed. `FrameRuntime.flush()` = store flush then router flush
  (a true "stored and dispatched" barrier).
- **Ordering hygiene:** `FrameEngine.hydrate()` uses `sanitizeStoredOrder()` — stored
  orders ≥ `MAX_SAFE_INTEGER` are ignored (prevents the 2^53 collapse below).
- **Postgres JSONB safety:** `PostgreSQLConnection` has `toJsonbSafe()` — drops the
  `\u0000` escape and stores non-JSON bodies as `raw=true`. Any non-raw body that isn't
  valid JSON breaks **every** `body::jsonb` query in its path range.
- **ScheduledFrameQueue** (`src/core/runtime/scheduled-frame-queue.mjs`) is durable
  (loads `listScheduledFrames`, cross-session) and tick-driven (`setInterval`, 1s) with
  `_nudge()` for immediate items; pending/firing entries reload on boot and re-dispatch.
- **Boot recovery:** `FrameRuntime.recoverStaleRuntimeFrames()` finalizes stale
  streaming responses/tool calls AND re-schedules their `parentID` trigger
  (`scheduledAt=now`, `scheduledStatus=pending`, silent merge) so interrupted turns
  resume. Returns `recoveredTurns` too.
- **Client thinking rack:** `thinking-state.mjs` (per-agent brain; one brain per agent),
  `kikx-thinking-panel.mjs` (🧠 button + cursor-following tooltip portaled to body),
  `kikx-thinking-rack.mjs`, CSS `.kikx-thinking-*`.
- **Compact frames:** `isCompactFrame()` / `compactFrameSummary()` in
  `tool-frame-summary.mjs`; `compact-frame-view.mjs` builds a native `<details>`; 
  `kikx-frame-item.mjs` wraps tool/system frames, keeps the `{Name} {time}` meta header
  visible, and applies `kikx-frame--compact` + `kikx-frame--status-{success,error,running}`.
  Bash highlighting: `syntax-highlight.mjs` (dependency-free, DOM-built) used for the
  exec compact line, card summary, and stdout/stderr.

---

## 3. Work completed this session (chronological, all pushed)

- `8af2382` Replace bouncing thinking bubble with pinned per-agent thinking rack.
- `54a9e3b` Pin the thinking panel's newest line to the bottom.
- `aab818c` Pull agent turns back to the user's assignment (prompt wording).
- `e1c0dcb` Make the compactor fold prior compactions into one summary.
- `92a5d2e` Start brief: transient MANDATORY `./AGENTS.md` else `~/.bot-common/rc.md` read.
- `3f14b24` Tighten start brief from dispositions to MANDATORY requirements.
- `7f52736` Fix frame-order corruption; rename `AeorDBFrameStore*` → `FrameStore*`,
  `aeordb-frame-store-*.mjs` → `frame-store-*.mjs`.
- `8bf11e1` Stop binary tool output breaking Postgres jsonb scans (`raw:true` for
  tool-output content; `jsonbSafeText`).
- `4f02690` Swap bubble sides: participants left, operator right.
- `95ede29` Thinking panel → giggling 🧠 icon + hover tooltip.
- `62644c9` Guarantee non-raw documents are jsonb-safe at the driver (`toJsonbSafe`).
  **Currently deployed in prod.**
- `8d0bacb` Persist commits before routing; never silently drop frames (window path now
  emits `FrameLoadError` instead of skipping).
- `93a7a95` Re-drive interrupted turns on boot through the scheduled-frame queue.
- `894fbca` One thinking brain per agent (was per response → "five brains").
- `b0bf51e` Compact non-communication frames into one-line summaries.
- `e4691a5` Compact frames: left icon, 1.5× size, keep meta header, code-block exec meta.
- `547bdcf` Compact polish: meta padding, click-anywhere toggle, bash highlighting,
  markdown type scale flattened to 13px primary / 15px headers.
- `3b1c300` Highlight the command in the exec card summary too.

Also this session: committed `~/.bot-common/rc.md` (symlink → `startup.md`) + README note
(bot-common `c090f24`); created DB `kikx-dev2` and the `:3002` dev server.

---

## 4. Key diagnostics / gotchas

### A. The "hung/dead bot" / "Reconnecting…" class
Symptom: UI stuck on "Reconnecting…", bot dead, server accepts TCP but never replies.
Two distinct causes found:

1. **Postgres jsonb breakage** (fixed): a non-raw document containing `\u0000` (or any
   invalid JSON, e.g. binary tool output) makes `body::jsonb` scans throw. The
   scheduled-frame queue's load is such a query → it failed → no wakes → agent stopped.
   Note: `IS JSON` **accepts** `\u0000` while `::jsonb` rejects it, so there is no reliable
   read-side guard. Fix at write time (`toJsonbSafe`) + data repair (strip `\u0000`,
   mark non-JSON bodies `raw=true`).
2. **Agent runaway microtask storm:** the agent loop spins in promise continuations
   (`processTicksAndRejections → routeAgent → mergeProviderFrame → merge →
   _normalizeFrame → cloneValue`), starving the event loop. `pid` state `R`, flat document
   count. A container restart recovers; the durable-turn/scheduled-queue work is the
   longer-term fix. Node inspector stack probe:
   `kill -USR1 <pid>` then `/tmp/opencode/probe-stack.mjs` (needs the inspector WS).

### B. Frame order collapse (2^53)
`createCommittedFrameLoadError` used `order: MAX_SAFE_INTEGER`; hydrating it pinned
`_frameOrder`, the next `++` became 2^53 and stuck, collapsing every later frame's order
and making reload show only tool frames (window picked alphabetically-last paths).
Fixed in the engine (`sanitizeStoredOrder`) and errors file. **Existing corrected data
migration is still outstanding** for sessions already persisted at 2^53 (renumber by
`createdClock`; safe because commits reference frame IDs, not orders).

### C. Compact frame UI
- Tool/system frames only: `isToolFrame()` plus `CompactionFrame`, `AgentError`,
  `SystemNotice`, `CommandResult`, `FrameLoadError`, `AgentProgress`.
- Descriptions: `Read file {path} <-`, `Write file {path} ->`, exec `Running {command}`
  (inline `<code>`), plus per-tool verb+subject.
- Icon LEFT, 19px; green success / red failure; `<details>` expansion.
- Known gap: `kikx-team-tool-use` is referenced but never defined; database/output-search
  labels are imperfect. `SessionCreateToolFrame` with `content.references` keeps its
  sub-session card.

### D. UI test harness
Playwright/stagehand UI harness is broken in this environment (fixtures don't render;
pre-existing team-manager spec fails too). Stagehand needs `OPENAI_API_KEY` + AeorDB.
Client unit (`spec/client`) is reliable.

---

## 5. Open items / next steps

1. **Deploy prod** to `3b1c300` when the owner says (prod is on `62644c9`).
2. **Data repair migration** for sessions with frames persisted at order 2^53.
3. **Turns-as-scheduled-items at turn start** — closes the narrow crash window between
   the user-message commit and the response placeholder creation (currently only
   interrupted turns re-drive).
4. **Window path uses the directory tail, not the commit index.** It now surfaces
   unreadable frames instead of dropping them, but full canonical fidelity would read
   commits like `listFrames`.
5. Verify the compact-frame UI + bash highlighting on `:3002` and iterate with the owner.
6. Team tool renderer (`kikx-team-tool-use`) remains undefined.
7. Optionally add a mid-run cancellation for agent turns (only wake cancellation exists).

---

## 6. Useful commands

```bash
# tests
npm test                                   # full suite; ~31 pre-existing env failures
node --test spec/client/*.mjs              # client unit suite (fast, reliable)
node --test spec/core/frame-store-spec.mjs spec/core/frame-runtime-spec.mjs

# dev servers
systemctl --user status kikx-dev-run.service kikx-dev2-run.service
systemctl --user restart kikx-dev2-run.service

# magic link (Node 24)
npm run magic-link
KIKX_URL=http://127.0.0.1:3002 KIKX_PUBLIC_URL=http://127.0.0.1:3002 \
  KIKX_AUTH_MAILER_LOG_PATH=/tmp/codex/kikx/kikx-auth-3002.log npm run magic-link

# prod data (never print the password)
export PGPASSWORD=$(cat /home/wyatt/.local/share/kikx/postgres/db-password)
psql -h 127.0.0.1 -p 5433 -U kikx -d kikx
# find non-raw invalid-JSON docs (jsonb breakers):
#   pg_temp.valid_jsonb(text) helper; SELECT ... WHERE raw=false AND NOT pg_temp.valid_jsonb(body)
# find \u0000 docs: WHERE position('\u0000' in body) > 0
```

---

## 7. Repos / branches

- `kikx` — `main`, remote `th317erd/kikx`; clean and pushed at handoff.
- `kikx2` — prod bot's clone (same origin), dev server on `:3001`.
- `kikx-docker` — private distribution container (`th317erd/kikx-docker`).
- Plugins: `kikx-plugin-ollama`, `kikx-plugin-codex`, `kikx-plugin-claude` (private).
- `~/.bot-common` — shared bot instructions; `rc.md` is now the harness-agnostic startup
  entry point (symlink → `startup.md`).
