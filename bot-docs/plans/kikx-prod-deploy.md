# Plan: Kikx durable "production" (stable dev) instance

## Status: SUPERSEDED (P0–P2 delivered; topology replaced by `kikx-docker-distribution.md`)

> The two-service stack this plan describes (separate `aeordb` + `kikx`
> containers) was delivered and verified, then reshaped into a single
> self-contained container. See `kikx-docker-distribution.md` for the current
> design. Retained for history.

## Goal

Stand up a durable, separately-run Kikx instance on this host for dogfooding
Kikx's own development. It must survive logout/reboot, must not share a working
tree or live source with the dev checkout, and must be refreshable by a
one-command "deploy" from a committed git ref. The container is built in
**publishable shape** so others can later pull it and mount their own home.

Working name: **kikx-prod** (a stable development instance).

## Non-goals

- Not a public/real production deployment, no SLA, no version tracking.
- No nginx/TLS exposure yet (localhost now; later addition).
- No clustering/multi-host AeorDB.
- No automated CI; deploy is manual.
- Runtime AeorDB token refresh inside the running Kikx process is deferred
  (see Rotation).

## Success criteria

1. `kikx-workspace/kikx-prod/` exists outside the dev checkout with its own
   durable AeorDB data file and its own compose stack.
2. Running Kikx code, plugins, and AEOR components all come from **pinned
   committed refs copied into images** — never the dev tree.
3. Breaking the dev checkout cannot stop the prod instance.
4. `deploy.sh <ref>` builds and runs a new instance from that ref; the AeorDB
   data file is never touched by a deploy.
5. `rollback.sh` restores the previously-deployed image.
6. Reboot restores both services automatically (`restart: unless-stopped`).
7. End-to-end: magic-link login, create a session, load its newest-page window.
8. The same compose/images work, generically, for another operator by changing
   env only (publishable shape).

## Owner decisions (verbatim)

- Fresh DB: "Let's start with a fresh DB... just make sure you capture that root
  key when you first startup aeordb!" and "It is okay if you miss the root key
  on first startup. AeorDB has a mechanism to reset the root key."
- Location: "let's actually put it in the 'kikx-workspace' at `../kikx-prod/`".
- Pin: "Pin them for deploy. I want this 'production' instance full separated
  from development".
- Exposure: "localhost is fine for now... I'll eventually want it to be proxied
  via nginx, but localhost is fine for now".
- Deploy style: "we are still in early stages... stick with branches and refs
  for now".
- Secrets: "it is really just a stable development instance... so these secrets
  aren't super critical".
- Mounts: "I think that I DO want the entire ~/Projects/ folder bind-mounted for
  the bots to work directly on the project... because we also need access to
  ~/Projects/aeor-web-components and ~/Projects/agis".
- Mirror pattern: "Yes please! I'd love the mirror pattern".
- Publishable shape: "Yes, may as well! If it works for us, then it should work
  for others too".
- Plugins: "All existing plugins. Soon we will be updating codex, claude, etc...
  so we should have all of them".
- Ollama: "we will also have to make sure the Ollama API key route works...
  I'd like the API Ollama route to work anyhow".
- Footgun: "Whatever security we can implement around this would indeed be
  desirable" — conditional on solving rotation.

## Observed facts (evidence)

- Docker 29.8.1 + Compose v5.5.1; wyatt in `docker` group; **no passwordless
  sudo**, `/opt` root-owned → user-level Docker workflow under `/home`.
- `aeordb` 0.9.5 runs on `debian:bookworm-slim` / `ubuntu:24.04` /
  `node:24-bookworm-slim` (verified).
- First fresh-DB start prints, once: `ROOT API KEY (shown once...):
  aeor_k_<hex>_<hex>`; `aeordb emergency-reset -D <db> --force` regenerates it.
- `POST /auth/token {api_key}` → `{ token, expires_in }`. With
  `include_refresh: true` it ALSO returns `refresh_token` (`aeor_r_…`, 30-day
  TTL). `POST /auth/refresh {refresh_token}` mints a new JWT + a new rotating
  refresh token (with reuse detection).
- **`--jwt-expiry` is a no-op in AeorDB 0.9.5.** Verified directly: the issued
  JWT is always 604800 s. Source: `aeordb-cli/src/commands/start.rs`
  destructures `jwt_expiry: _jwt_expiry` (unused); the exchange handler in
  `aeordb-lib/src/server/routes.rs` hardcodes
  `min(DEFAULT_EXPIRY_SECONDS, key_remaining)`, `DEFAULT_EXPIRY_SECONDS = 7 d`.
  So JWTs are capped at 7 days with no config to extend them.
- Kikx server has **no** runtime npm deps (`dependencies: {}`); runtime = Node
  builtins + AeorDB HTTP. `src/server/node_modules/` is untracked stray.
- Env inputs: `AEORDB_URL`, `AEORDB_ROOT_KEY` (exchanged), `KIKX_HOST/PORT`,
  `AEOR_WEB_COMPONENTS_DIR` (`src/server/create-server.mjs:45,52`),
  `KIKX_PLUGIN_PATHS` (`src/core/plugins/plugin-loader.mjs`).
- Client HTML uses root-absolute paths (`/client/…`, `/vendor/…`); serving at a
  container root on a port works with no prefix work.
- Plugin inventory and refs:
  - codex `7d30764` deps {} · claude `d5d7a92` `@anthropic-ai/sdk` ·
    ollama `6284151` deps {} · google `3b47c77` `@google/genai` ·
    puppeteer `ac22e47` `puppeteer`+`puppeteer-extra`+stealth (needs Chromium)
  - aeor-web-components `b608faa` (has uncommitted local edits)
  - kikx `52cad23`
- Host Ollama runs on `127.0.0.1:11434` serving `deepseek-v4.1-flash:cloud`;
  the ollama plugin has **no apiKey field** and calls `${baseUrl}/api/chat`
  without an Authorization header.
- Host identity: uid/gid `1000:1000`, `HOME=/home/wyatt`.
- Agent-development paths needed: `~/Projects` (rw, incl. agis +
  aeor-web-components + plugins), `~/.claude`, `~/.codex`, `~/.bot-common`,
  `~/.agents`, `~/.gitconfig`, `~/.ssh`, `/tmp/codex`, `/tmp/claude`,
  `~/.cache/codex`.
- Dev ports in use: Kikx 3001, AeorDB 6830. Free: 3099, 6833.

## Architecture

### Layout (`/home/wyatt/Projects/kikx-workspace/kikx-prod/`)

```
kikx-prod/
  compose.yml            # generic/publishable, env-interpolated
  .env                   # ports, refs, KIKX_HOME, PUID/PGID, AEORDB_ROOT_KEY
  secrets/aeordb_root_key   # root key file (entrypoint-only read)
  data/                  # durable bind-mounted AeorDB (empty at first)
  images/
    aeordb/Dockerfile
    kikx/Dockerfile      # publishable shape
  docker/entrypoint.mjs  # wait-for-db, exchange root key -> JWT, unset key, exec
  .build/                # git-archive staging per deploy (gitignored)
  logs/
  deploy.sh  rollback.sh  bootstrap.sh  README.md
```

### Publishable image shape

- Internal non-root user; `HOME` and `PUID`/`PGID` env-configurable; entrypoint
  aligns uid/gid so mounted home files stay operator-owned (default 1000:1000).
- App baked at `/app`, immutable; runtime never writes into `/app`.
- `/data` is the DB volume. All user content and data are mounted.
- Config entirely via env. Bundled defaults (all plugins + aeor components)
  baked at `/app/plugins` and `/app/vendor/aeor-web-components`, overridable by
  `KIKX_PLUGIN_PATHS` / `AEOR_WEB_COMPONENTS_DIR`.
- `extra_hosts: ["host.docker.internal:host-gateway"]` for host Ollama.

### Mirror mounts (canonical, generic)

Host paths mounted at identical container paths; `HOME` set to the mounted home:
`-v "${KIKX_HOME}:${KIKX_HOME}" -e HOME="${KIKX_HOME}"`. For this host,
`KIKX_HOME=/home/wyatt`. Our instance mounts:

- `${KIKX_HOME}/Projects` rw — source work areas (kikx, plugins, aeor
  components, agis, aeordb source).
- `${KIKX_HOME}/Projects/kikx-workspace/kikx-prod` **ro** — overlay so a bot
  cannot edit its own deploy config (more-specific bind wins).
- `${KIKX_HOME}/.claude`, `.codex`, `.bot-common`, `.agents` ro — agent context,
  skills, project `CLAUDE.md`/`conversation.md`.
- `${KIKX_HOME}/.gitconfig`, `.ssh` ro — git identity + SSH remotes.
- `/tmp/codex`, `/tmp/claude`, `${KIKX_HOME}/.cache/codex` rw — scratch.
- `${KIKX_HOME}/kikx-prod-data`-style external data dir → `/data` (kept out of
  the work-area mount for clarity; exact path TBD in P0).

A published/other operator just sets `KIKX_HOME` to their own home.

### Services (compose, project `kikx-prod`)

- `aeordb`: image `kikx/aedordb:<ver>` (debian slim + host binary);
  `start -D /data/kikx.aeordb --host 0.0.0.0 --port 6830 --auth self
  --jwt-expiry 31536000`; volume `./data:/data`; `user: "1000:1000"`;
  publish `127.0.0.1:6833:6830`; bash `/dev/tcp` healthcheck;
  `restart: unless-stopped`.
- `kikx`: image `kikx/kikx:<sha>`; `AEORDB_URL=http://aeordb:6830`,
  `AEORDB_ROOT_KEY_FILE=/run/secrets/aeordb_root_key`,
  `KIKX_HOST=0.0.0.0`, `KIKX_PORT=3000`,
  `AEOR_WEB_COMPONENTS_DIR=/vendor/aeor-web-components`,
  `KIKX_PLUGIN_PATHS=/opt/plugins/kikx-plugin-codex:/opt/plugins/kikx-plugin-claude:/opt/plugins/kikx-plugin-ollama:/opt/plugins/kikx-plugin-google:/opt/plugins/kikx-plugin-puppeteer`;
  entrypoint at `/app/docker/entrypoint.mjs`; publish `127.0.0.1:3099:3000`;
  `depends_on` aeordb healthy; `/health` healthcheck; `restart: unless-stopped`;
  mirror mounts per above.
- One private network; only the two loopback publishes are host-visible.

### Token rotation (entrypoint supervisor; approved)

JWTs are capped at 7 days and no client change is made, so the entrypoint
(PID 1) supervises renewal:

1. `entrypoint.mjs` reads the root key from `/run/secrets/aeordb_root_key`,
   exchanges it with `include_refresh: true` → `{ token, refresh_token,
   expires_in }`, **unsets `AEORDB_ROOT_KEY*` from its own environment**, and
   persists the refresh token + expiry to `/data/runtime/aeordb-refresh.json`.
2. Spawns `node src/server/index.mjs` as a child with only `AEORDB_TOKEN` set;
   bots' `exec` children never inherit the root key.
3. On start and on a timer (refresh at ~6 days, before the 7-day cap), it
   re-mints a JWT — via the stored refresh token (`/auth/refresh`, rotating),
   falling back to a root-key re-exchange if the refresh token is invalid — and
   restarts the Kikx child with the new `AEORDB_TOKEN`. The restart is short
   (~1-2 s) and does not touch data.
4. Container restart (deploy/reboot/crash) re-mints on start.
5. Prod aeordb drops the (no-op) `--jwt-expiry` flag; default JWT lifetime +
   30-day refresh are used.

Footgun note: this prevents accidental inheritance of the root key by child
processes, not deliberate reads of the mounted secret by a bot running as the
same uid. Acceptable per owner ("secrets aren't super critical").

### Plugins and Ollama

- All five plugins baked into the image, each staged at a pinned ref and
  `npm install --omit=dev` where a `package.json` declares deps.
- Ollama: add an `apiKey` config field + `Authorization: Bearer` header to
  `kikx-plugin-ollama` (owner decision 2), and document
  `host.docker.internal:11434` for reaching a host Ollama. This is a small
  plugin change (its own repo, pinned by ref like the others).

### Browser: special "headed" Chrome (owner decision 1)

Use the same headless-but-real Chrome approach as
`/home/wyatt/Projects/miri/scripts/start-headed-chrome.sh` (copy + adapt,
Linux-only): Xvfb off-screen display, ANGLE + SwiftShader for a real WebGL
context, `--password-store=basic` to avoid keyring stalls, real user agent, and
a persistent CDP endpoint on a configurable port with a persistent profile dir.

- Image additions: Chrome-for-Testing (installed via the bundled `puppeteer`
  browser install) + Xvfb + the usual Chrome shared libs.
- Adapted script `docker/start-headed-chrome.sh` in the kikx image: Linux path
  only (drop macOS/`open`/`lsbackground`), env-configurable
  `KIKX_CHROME_DEBUG_PORT` (default 9224), `KIKX_CHROME_PROFILE_DIRECTORY`,
  `KIKX_CHROME_DISPLAY` (default `:99`), `KIKX_CHROME_BIN`; starts Xvfb then
  Chrome, waits for `/json/version`, smoke-tests navigation.
- Lifecycle: run as a supervised background process in the `kikx` container
  (before the server). Reuse the profile dir via a volume if persistence across
  restarts is wanted; otherwise ephemeral is fine for prod.
- **Plugin change required:** `kikx-plugin-puppeteer` currently
  `puppeteer.launch()`es its own headless Chrome. To use the special endpoint it
  must `puppeteer.connect({ browserURL })` when a CDP endpoint env var is set
  (e.g. `KIKX_BROWSER_URL=http://127.0.0.1:9224`), falling back to its current
  launch behavior otherwise. Small, backwards-compatible change in the plugin
  repo, pinned by ref. Tracked as a P1 deliverable.

## Contracts

- Host ports: prod Kikx `127.0.0.1:3099`; prod AeorDB `127.0.0.1:6833`.
- Env (kikx): `AEORDB_URL`, `AEORDB_TOKEN`, `AEORDB_ROOT_KEY_FILE`,
  `KIKX_HOST`, `KIKX_PORT`, `AEOR_WEB_COMPONENTS_DIR`, `KIKX_PLUGIN_PATHS`,
  `KIKX_HOME`, `PUID`, `PGID`.
- Names prefixed `kikx-prod-`; DB is one bind-mounted file; backup = graceful
  stop + copy.
- Deploy by committed branch/ref (tags deferred).
- Generic compose reads `KIKX_HOME`, `PUID/PGID`, `AEORDB_ROOT_KEY`, ports, refs
  from `.env` via `${VAR:-default}` interpolation.

## Verification spine

- Dev checkout: `npm test` green; `npx eslint` clean.
- Image: builds from pinned refs; `docker run --rm kikx/kikx:<sha> ls /app` shows
  only staged source (no dev-tree leakage); image runs as non-root.
- Service: `curl -s http://127.0.0.1:3099/health` → `{"ok":true,...}`.
- E2E: magic-link token against `KIKX_URL=http://127.0.0.1:3099`, list sessions
  (empty), create a session, load its newest-page window.
- Isolation: stop dev stack → prod stays up and login works.
- Durability: create a session, `docker compose restart`, session still listed.
- Footgun: `docker compose exec kikx sh -c 'echo $AEORDB_ROOT_KEY'` is empty;
  a child cannot start a second Kikx against prod.
- Ownership: files a bot writes into `~/Projects` are uid 1000.
- Rollback: deploy A → deploy B → `rollback.sh` → image tag returns to A.

## Risks / limitations

- Image embeds the host-built aeordb binary (no in-container build); binary path
  is the pinned input, documented.
- Full-home / full-Projects mount means a bot can read the operator's secrets
  (SSH keys, `.env`). It is the same trust level as the current host bot and was
  explicitly chosen; document it for published users.
- A bot could start the dev stack inside the container and, without care, point
  it at prod AEORDB. Mitigated by unsetting the root key; still document "do not
  run the dev stack against prod data".
- Chromium-in-container adds ~700 MB-1 GB and apt libs.
- Branch/ref deploys give weaker rollback than tags (accepted).
- `aeor-web-components` has uncommitted local edits; only committed refs deploy.

## Open decisions

None outstanding. All resolved:
1. Include browser support via the special headed-Chrome approach (owner: "copy +
   modify from /home/wyatt/Projects/miri/scripts/start-headed-chrome.sh").
2. Ollama API-key route: add it now (owner: "Yes").

## Phases

- **P0 — Scaffold + aeordb** (kikx-prod/): layout, aeordb image, compose aeordb
  service, `bootstrap.sh` + root-key capture (with `emergency-reset` fallback),
  durable data file. Verify `/system/health` on 6833; restart persists data.
- **P1 — Kikx image + service** (kikx-prod/ + `docker/entrypoint.mjs`): kikx
  Dockerfile (publishable shape), mirror mounts, all plugins, staging in
  `deploy.sh`, kikx service; verify `/health`, empty-session login, non-root.
- **P1a — Browser + plugin changes** (plugin repos + kikx image): add
  `docker/start-headed-chrome.sh` (Linux-adapted from miri) and the Chrome/Xvfb
  image deps; add the `kikx-plugin-puppeteer` CDP-connect env path; add the
  `kikx-plugin-ollama` `apiKey`/Authorization field. Verify CDP `/json/version`
  in-container, `host.docker.internal` Ollama reachability, and a plugin-level
  browser smoke test.
- **P2 — Deploy/rollback + isolation proof**: `deploy.sh`/`rollback.sh`,
  `.last-deploy`, isolation vs dev, durability, footgun, ownership checks.
- **P3 — Dogfooding work area** (separate plan): confirm the mirror mount is
  sufficient for bots to edit the Kikx source and run tests inside the
  container; add any missing tooling.

## Definition of done

- `bootstrap.sh` brings up a fresh, empty, durable prod instance on
  `127.0.0.1:3099` with the root key captured to `secrets/aeordb_root_key`.
- `deploy.sh <ref>` rebuilds/restarts Kikx from a committed ref without touching
  `data/`; `rollback.sh` returns to the prior image.
- Prod survives restart and dev-stack shutdown; a bot cannot see the root key in
  its environment; written files are uid 1000.
- All success criteria demonstrated with recorded command output.
