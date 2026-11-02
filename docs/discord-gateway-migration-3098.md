---
title: Moving the Discord gateway from 3003 to 3098
doc_type: report
status: completed
audience: [developers, operators]
applies_to: development-v3
last_verified: 2026-11-02
keywords: [discord, gateway, cutover, 3098, 3003, migration]
---
# Moving the Discord gateway from 3003 to 3098 — measured plan

Date: 2026-11-02. Author: Miri. Status: **EXECUTED — 3098 now holds the only live gateway socket (see "Executed" below).**

## Question this answers

"Move the Discord plugin (gateway/webhooks) over to 3098 (kikx.taraani.org) when we are at a
stable place to do so."

## What is actually true right now (measured, not assumed)

| Fact | Value | How measured |
|---|---|---|
| 3098 image | `kikx/kikx:270e0143`, `Up (healthy)` | `docker ps` |
| 3098 plugin code | discord present at `/opt/plugins/kikx-plugin-discord`, ref `17b05bd` | `docker exec ls`, `.last-deploy` |
| 3098 gateway | **not running**: `[discord] gateway not started: no bot token configured` | `docker logs kikx` |
| 3098 plugin route live | `POST /api/plugins/discord/interactions` → **401** (exists, unauthenticated) | curl |
| 3098 plugin client module | `/api/plugins/discord/client/discord-send-card.mjs` → **200** | curl |
| 3098 discord tables | `discord_capability=0`, `discord_channel_session=0`, `discord_message_frame=0` | psql in container |
| 3098 database | `postgres://kikx@127.0.0.1:5433/kikx` — **separate** from 3003 | child process environ |
| 3098 agents | 1 (`Miri`, `780c4dad…`) | `GET /api/v1/agents` |
| 3098 sessions | 3: `Miri` (aaa31337…), `Discord inbound E2E (throwaway)`, `discord-e2e-target` | `GET /api/v1/sessions` |
| 3003 gateway | **live**, 24 `gateway ready`, one reconnect cycle in flight after last restart | `/tmp/miri-3003.log` |
| 3003 database | `postgres://miri-kikx-dev@127.0.0.1:5434/miri-kikx-dev` — separate | `/proc/2299863/environ` |
| Discord app | `Miri`, id `1471348366305923102` | `GET /api/v10/applications/@me` |
| **Discord interaction endpoint** | **`null`** — Discord POSTs interactions nowhere | same call |

## The consequences that shape the move

1. **Inbound is gateway-only.** `interactions_endpoint_url` is null, so slash commands and
   buttons reach nothing today; channel messages arrive over the gateway WebSocket. Moving the
   gateway therefore needs **no change on Discord's side**. Registering an interaction endpoint
   later is a separate, optional piece of work.

2. **The token must MOVE, never be copied.** The plugin's own comment at `index.mjs:778`
   records what happened last time two processes shared one token: Discord closed the
   duplicates with code 4000 and one message was framed twice. So the ordering is strict:
   **strip the token from 3003 and restart 3003, THEN start the gateway on 3098.** Never both.

3. **Schema is already there; data is not.** Core applied the plugin's migrations on 3098 at
   load (`discord_capability`, `discord_channel_session`, `discord_message_frame` all exist).
   All three are empty, so the cutover must carry the grants and the channel binding:
   - `discord_capability`: `discord:255524600249581568` / `discord.inbound` and `discord.send`,
     both scoped `{"channel":"1471361561955143773"}`.
   - `discord_channel_session`: `1471361561955143773` → a **3098** session id.

4. **The session id must be re-pointed, not copied.** 3003's binding points at
   `54e1c081-b4fc-46bf-ae9a-c82e19784a19`, which exists only in 3003's database. On 3098 the
   equivalent is `aaa31337-7f4a-4684-aa85-e13eb03b6de0` (`Miri`).

5. **A pre-existing inconsistency worth fixing on the way past.** 3003's
   `KIKX_DISCORD_INBOUND_SESSION` is `3d573682-5955-474e-877b-1944555a6dfb`
   ("Discord #miri inbound") while the channel-binding table points at `54e1c081…`
   ("Miri — Discord dogfood"). Two different sessions for one channel. The cutover should use
   **one** target; the plan below uses the single Miri session on 3098.

## Cutover plan (ordered, reversible)

Phase 0 — prepare, no downtime
  a. Insert the two capability grants into 3098's `discord_capability` (idempotent).
  b. Insert the channel binding `1471361561955143773` → `aaa31337-…` into 3098.
  c. Register the 3098 session as reachable: confirm `aaa31337-…` has a coordinator/participant
     (it is the live Miri session, so this is already true — verify, do not assume).
  d. Verify 3098's inbound gate with the negative control: grant present → allowed;
     absent/wrong channel → denied. This is the strict-security requirement.

Phase 1 — take the gateway away from 3003 (downtime starts)
  e. Remove `KIKX_DISCORD_BOT_TOKEN` from 3003's env file
     (`/home/wyatt/miri-3003-env.bin`, replayed by `kikx-3003-run.sh`), keeping a backup copy.
  f. Restart 3003 via `/home/wyatt/kikx-3003-up.sh` (the only supported path; `setsid nohup`
     from ssh dies). Confirm `[discord] gateway not started: no bot token configured` in
     `/tmp/miri-3003.log` — this is the proof the old gateway is gone, not just quiet.

Phase 2 — start the gateway on 3098 (downtime ends)
  g. Add the four Discord keys to kikx-docker `compose.yml` `environment:` — token, public key,
     inbound channel, inbound session — read from `.env` so the secret stays out of git
     (`.env` is gitignored). Restart the container so they take effect.
  h. Confirm `[discord] gateway ready as Miri` exactly **once** in `docker logs kikx`, and that
     no `gateway reconnecting` follows within a minute.

Phase 3 — prove it on the wire, in `#miri` only
  i. Post one message in `#miri` and confirm a `DiscordFrame` lands in 3098's session with the
     text intact.
  j. Confirm a `discord:send` reply arrives as one message (and a >2000-char reply as ordered
     parts — the splitter fix is in `17b05bd`).
  k. Negative control: a send with a channel the grant does not cover must be **denied**.

Phase 4 — record
  l. Append results here with timings and the exact log lines.
  m. Decide the fate of 3003's now-stale discord tables (leave them as history; they are inert
     without a token).

## Rollback

Everything is reversible by moving the token back:
  1. Remove the Discord keys from 3098's compose, restart the container → 3098 gateway stops.
  2. Restore `KIKX_DISCORD_BOT_TOKEN` in `/home/wyatt/miri-3003-env.bin`, restart 3003 → old
     gateway resumes with its existing data intact.
  3. The grants written to 3098 are additive and harmless if the move is abandoned.
No data is deleted at any step. The only irreversible thing would be losing the backup of the
env file, which is why step (e) copies rather than moves it.

## What this plan deliberately does NOT do

- It does not register a Discord interaction endpoint. That endpoint does not exist today, so
  registering one is new functionality, not a migration.
- It does not touch the outbound mirror question (agent replies only reach Discord when the
  model calls `discord:send`). That is a product decision, still open.
- It does not delete 3003's Discord rows.

---

# Executed — 2026-11-02, 21:36–21:51Z

The move was carried out in the order this plan required. Every claim below is a measurement,
with the command or log line that produced it.

## What moved

| Item | Where it went | Proof |
|---|---|---|
| `KIKX_DISCORD_BOT_TOKEN` (+ public key, inbound channel, inbound session) | `kikx-docker/.env` → `compose.yml` `environment:` → container | `docker exec kikx env` shows all four keys; token length 72, identical to 3003's live token (sha `825074dc2763`) |
| Two capability grants (inbound + send, scoped to `#miri`) | 3098 `discord_capability` | `select *` → 2 rows, `discord:255524600249581568`, `{"channel":"1471361561955143773"}`, `granted_by=miri-3098-cutover` at `21:41:22Z` |
| Channel binding `#miri` | 3098 `discord_channel_session` | `1471361561955143773` → `aaa31337-7f4a-4684-aa85-e13eb03b6de0` |
| Gateway socket | 3098 `node /app/src/server/index.mjs` (pid `2744473`) | `ss` ESTAB `162.159.135.234:443` attributed to `pid=2744473`; 3003 has **0** such attributed sockets |

## Ordering that mattered (two mistakes, both caught by measurement)

1. **Deploy-before-env is a no-op.** The four Discord keys were written to `compose.yml`/`.env`
   at 21:41Z, but the container had been created at 21:36Z, so `270e0143` never saw them and
   logged `gateway not started: no bot token configured`. Configuration written after container
   creation requires the container to be **recreated**, not just restarted. Fixed by recreating.
2. **Stripping one env file is not stripping the token.** 3003's token was removed from
   `/home/wyatt/miri-3003-env.bin`, but the process kept a live gateway because the additive
   loader (`.env.dev`) also carried it. 3003 only went quiet once **both** files were stripped
   and it was restarted. Verified: `/proc/2714560/environ` now has **0** `KIKX_DISCORD_` keys.

## Proof on the wire

| Assertion | Result |
|---|---|
| 3098 gateway came up | `[discord] gateway ready as Miri`, `ready=1`, `reconnecting=0`, `not-started=0` |
| 3003 gateway is gone | `[discord] gateway not started: no bot token configured` on the post-strip restart |
| Inbound is framed in 3098's own DB | `discord_message_frame` row `1566932373428506725`, text `[discord:th317erd] CUTOVER-3098-214949 probe from 3098 cutover`, `21:49:50.112Z`, `session_id=aaa31337…` |
| Outbound works from 3098 | `discord:send` → `sent:true authorized:true`, message `1566932647853428937`, `chunks:1 delivered:1` |
| Reply linkage | `replyTo` resolved to the exact inbound message `1566932373428506725` — not a stale newest-row guess |
| Deny-by-default still holds | send to uncovered channel `999999999999999999` → `sent:false denied:true`, "grant exists for discord.send but its scope does not match the request" |

## State after the move

- **3098 (`kikx.taraani.org`, container `kikx`, image `kikx/kikx:270e0143`, pid 2744473)** owns the
  bot identity `Miri` (`1471348366305923102`) and the only live gateway socket.
- **3003 (`kikx2.taraani.org`, pid 2714560)** runs without any Discord transport. Its
  `discord_*` tables still hold the old rows; they are inert without a token and were left as
  history, per the plan.
- Backup of 3003's pre-move env: `/home/wyatt/miri-3003-env.bin.pre-discord-move`.

## Not done / still open

- No Discord interaction endpoint was registered. `interactions_endpoint_url` remains `null`;
  inbound is gateway-only. Unchanged by this move.
- Outbound mirroring is still a product decision: an agent reply reaches Discord only when the
  model calls `discord:send`. The cutover did not change that.
- The 3003 rows were not deleted; reclaiming them is a separate decision.

## Post-cutover stability re-check (2026-11-02T21:51–21:54Z, after the Kikx restart)

The agent session hosting this work was restarted mid-verification. The cutover was re-measured
from scratch rather than assumed, because "the script was launched" is not "the script finished".

| Assertion | Result |
|---|---|
| The lost verify run had in fact completed | `/tmp/3098-discord-proof.txt` survived with the full 21:47:14–21:47:32Z run; `/tmp/verify-3098.out` is 0 bytes |
| 3098 container is the post-cutover one | `kikx/kikx:270e0143`, id `e700bc3c…`, recreated 21:47:14Z, healthy |
| Discord env is present in the **running** container | 4 keys; `token_len=72` |
| Gateway is stable, not flapping | since 21:47:00Z: **`gateway ready as Miri` ×1, `gateway reconnecting` ×0, errors ×0** |
| The socket belongs to 3098, not 3003 | single host socket to `162.159.135.234:443` owned by pid `2744473`, the node child of container `kikx` (entrypoint pid `2744240`) |
| 3003 carries no token | pid `2714560`; zero Discord sockets; log `gateway not started: no bot token configured` |
| 3003's only remaining `KIKX_DISCORD_` match is not a credential | `KIKX_ENV_FILE_OWNED_KEYS` — a variable whose *value* is the list of key **names**. The earlier "0 keys" phrasing was wrong; the accurate statement is "0 Discord **values**: token, public key, channel and session are all absent" |
| Outbound confirmed independently at the API, not just in our own frames | `GET /channels/1471361561955143773/messages` → `1566932647853428937` at `21:50:55.449Z`, `author Miri` (`1471348366305923102`, `bot:true`), i.e. posted after the 21:47 cutover |
| Deny-by-default holds against a non-Discord actor | `discord:send` called directly as actor `miri` → `sent:false denied:true "no grant for discord.send"`. The only grants are `discord:255524600249581568` on `discord.inbound`/`discord.send`, scoped `{"channel":"1471361561955143773"}`. So this call *should* refuse: the leg is authorised for the Discord user's turns, not for the coordinator at large |

Repos after the re-check: `kikx` `main` = `b915f2c2`, divergence `0 0`;
`kikx-plugin-discord` `master` = `c0eabb3`, divergence `0 0`. Deployed image `270e0143` is one
commit behind `main`, and that commit is docs-only (`docs/discord-gateway-migration-3098.md`),
so no redeploy is warranted for it.

Not verified: the 3003-side `discord_*` rows were never re-read after the move to confirm they
are merely inert rather than actively conflicting, and no image-only message has been posted
through 3098's gateway yet (the media fix `d2fb5a7` is proven on 3003 only).
