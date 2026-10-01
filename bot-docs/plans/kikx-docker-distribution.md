# Plan: Kikx Docker distribution (single container)

## Status: PROPOSED — awaiting authorization to implement P3

Supersedes the two-service topology described in `kikx-prod-deploy.md`. That plan
delivered the working stack (P0–P2); this plan changes its *shape*: one
self-contained container that runs Kikx, AeorDB, and Chrome together, intended to
be started on any host like an AppImage.

## Goal

Make Kikx trivially startable on any host as a single Docker container that
carries the entire application — Kikx server, the AeorDB engine, and a real
Chrome — with the project source **frozen inside the image**. The operator's home
directory is bind-mounted so bots (and the operator) work on real projects in
place on the host, across *every* project, not just Kikx.

## Non-goals

- Live-running edited source inside the container. The running app is the pinned,
  frozen image; going live from an edit is `deploy.sh <ref>` (rebuild).
- An in-container throwaway AeorDB for Kikx's own unit tests. Those stay on the
  host.
- Multi-arch/published registry images (a later concern; nothing here blocks it).
- Encryption at rest.

## Success criteria

1. `docker compose up -d` brings up **one** container serving Kikx on
   `127.0.0.1:3099` with AeorDB inside it and a real Chrome available to Kikx's
   `web-search`/`web-fetch`.
2. The durable database lives **outside** the container at
   `${KIKX_HOME}/.local/share/kikx/kikx.aeordb` and survives rebuild/restart.
3. The operator's home is mounted read-write at the same path so bots edit real
   projects; credential subpaths (`.ssh`) are read-only overlays.
4. Kikx can drive the **host** Brave at `127.0.0.1:9222` (host network mode).
5. The root key is captured on first start, is never present in the Kikx server
   process environment, and cannot be inherited by bot `exec` children.
6. Rehosting to another operator/host is `KIKX_HOME=/their/home ./bootstrap.sh`
   with no code edits.
7. Kikx's own unit/spec suite is unaffected: host `npm test` stays 440/440.

## Owner decisions (verbatim, this session)

- "I'd prefer one container"
- "No, we are superceding the existing `kikx-prod-aeordb` service by putting
  `aeordb` inside a single shared container... this entire container is the
  'dogfooding service'"
- "I WANT `aeordb` to be inside docker... the database itself can and will grow
  large however, so it should default to a `~/.local/share/kikx/` location
  outside of docker."
- "we will work from the docker container (where the project files should be
  installed, pinned, and safe from edits), and we work ON
  /home/wyatt/Projects/kikx-workspace/"
- "No editing INSIDE the container... NO! Bots can and must have _write access_
  to our bind mounts _outside the container_ (i.e. in our case, /home/wyatt/)"
- "Leave the existing DB where it is. We will spin up a new one for Kikx
  dogfooding."
- "When I say 'test', I mean _driving with Puppeteer_... Driving with Puppeteer is
  as simple as allowing access to the Brave Browser host port 9222. Running
  Kikx-specific unit tests, we will use throw-away aeordb instances on the host
  (because the host is where we are keeping development)."
- "This is a _user defined location_, and I would like it to be _/home/wyatt/_"
- "When I say 'dogfood', I mean I am going to use Kikx for every active project on
  my system."
- "Yes, let's have Host network mode. We are putting this whole thing in a
  container to act more like a .appimage than anything else. I just want it easy
  to get a start using Kikx, ON ANY HOST."
- Web tools keep the container's own Chrome: "Yes, because we are dogfooding, and
  this is PART of Kikx"
- "`.ssh` read-only overlay — Fantastic idea! Go for it!"
- Naming (this session): rename `kikx-prod/` → `kikx-docker/` (matching the
  repo), compose project / container / image → `kikx`; move the Chrome profile
  under `${KIKX_HOME}/.local/share/kikx/`.

## Observed facts (evidence, verified this session)

- **aeordb needs glibc 2.38.** `strings images/aeordb/aeordb` shows `GLIBC_2.38`
  as the highest requirement; host glibc is 2.39. Current kikx base
  `node:24-bookworm-slim` is glibc 2.36 → cannot run it.
- **`node:24-trixie-slim` works.** Debian 13, glibc 2.41. Ran the binary in it:
  `aeordb 0.9.5`, exit 0. `libssl.so.3`/`libcrypto.so.3` present; the existing apt
  dependency list installs cleanly (EXIT=0).
- **Fresh-start root-key banner**: aeordb prints
  `ROOT API KEY (shown once, save it now!):` then `aeor_k_<hex>_<hex>` once on a
  fresh database; regex `aeor_k_[A-Za-z0-9_]+` captures it. Not printed again.
- **Host Brave is loopback-only**: `ss` shows `127.0.0.1:9222` owned by `brave`.
  A bridge container cannot reach it → host network mode is required for the
  Puppeteer-drive requirement.
- **The kikx image already bakes Chrome** (`@puppeteer/browsers install
  chrome@stable`, symlink `/usr/local/bin/kikx-chrome`) and starts it via
  `docker/start-headed-chrome.sh` (Xvfb + ANGLE/SwiftShader + CDP 9224).
- **The entrypoint is a 299-line PID 1 supervisor** (`docker/entrypoint.mjs`)
  that waits for AeorDB, exchanges the root key for a JWT, spawns the Kikx child
  with only `AEORDB_TOKEN`, and re-mints on a timer. It already handles Chrome.
- **AeorDB 0.9.5 `--jwt-expiry` is a no-op**; JWTs are capped at 7 days (from the
  prior plan's verification).
- **Host unit suite** is 440/440. In-container it was 439/440 — the single
  failure (`request-login-link-spec`) is `KIKX_HOST=0.0.0.0` leaking from the
  container env, not a code defect.
- The old DB `kikx-prod/data/kikx.aeordb` (10.5 MB dummy/smoke data) is left in
  place, unused, per the owner ruling.

## Architecture

### Image (single, `images/kikx/Dockerfile`)

- Base changes `node:24-bookworm-slim` → `node:24-trixie-slim`.
- `COPY images/aeordb/aeordb /usr/local/bin/aeordb` (mode 0755). The host-built
  binary remains the pinned input; `bootstrap.sh` stages it as today.
- Keep `/app` (staged Kikx), `/opt/plugins/*`, `/vendor/aeor-web-components`,
  `docker/entrypoint.mjs`, `docker/start-headed-chrome.sh`.
- Keep apt dep list + Chrome-for-Testing install + `/usr/local/bin/kikx-chrome`.
- Remove the now-redundant `images/aeordb/` image build target and its compose
  service.

### Entrypoint (single PID 1 supervisor)

`docker/entrypoint.mjs` grows one responsibility: **supervise AeorDB as a child**
(before Kikx). Split into cohesive modules to stay well under the 500-line soft
limit:

- `docker/lib/aeordb-supervisor.mjs` — spawn
  `aeordb start -D <db> --host 127.0.0.1 --port <port> --auth self --log-format
  pretty`; pipe its stdout through a line scanner; on the first fresh-DB
  `ROOT API KEY` banner, write the key to `<data-dir>/root_key` (0600) if absent;
  resolve when `/system/health` reports `healthy`/`degraded`; restart-or-exit on
  unexpected child exit.
- `docker/lib/token-manager.mjs` — the existing mint/refresh/fallback logic.
- `docker/entrypoint.mjs` — orchestration: dirs → Chrome → AeorDB → token →
  Kikx child → refresh timer → shutdown fan-out.

Order: Chrome starts first (independent), then AeorDB, then the token exchange,
then the Kikx child. `SIGTERM`/`SIGINT` fan out to Chrome + AeorDB + Kikx.

### Data root and mounts

- `KIKX_HOME` defaults to the operator's home (`/home/wyatt` here). Data dir
  `${KIKX_HOME}/.local/share/kikx/` holds `kikx.aeordb`, `root_key`, runtime
  token, and (optionally) the Chrome profile.
- Mounts:
  - `${KIKX_HOME}:${KIKX_HOME}` **rw** — real projects in place (whole home, so
    any project works).
  - `${KIKX_HOME}/.ssh:${KIKX_HOME}/.ssh:ro` — credential overlay (more-specific
    bind wins). Consider `.gnupg` similarly.
  - Chrome keeps its own **container-only** `HOME` (`/data/chrome-home` as today,
    or `${KIKX_HOME}/.local/share/kikx/chrome-home`) so it never touches host
    Chrome state (existing, verified reason).
- `HOME=${KIKX_HOME}` for the Kikx server. The old `./data`, `./secrets`, and the
  curated `.claude`/`.codex`/… mounts are dropped (now covered by the home mount
  + credential overlays).

### Network

- `network_mode: host`. No `ports:` mapping (compose forbids it with host
  networking); processes bind loopback directly. This requires reconciling the
  env: set `KIKX_HOST=127.0.0.1`, `KIKX_PORT=3099` (not 3000), AeorDB
  `--host 127.0.0.1 --port 6833`, internal Chrome `127.0.0.1:9224`, and point
  the kikx healthcheck at `127.0.0.1:3099`.
- This makes the **host** Brave CDP (`127.0.0.1:9222`) reachable from Kikx, and
  also makes host-run throwaway AeorDB instances (dev `6830`) reachable from
  in-container bots — both desirable under host networking.

### Scripts

- `compose.yml`: one `kikx` service; `network_mode: host`; `shm_size: 1gb`;
  image `kikx-prod/kikx:${KIKX_IMAGE_TAG}`; env; volumes above.
- `bootstrap.sh`: stage `images/aeordb/aeordb`, build the single image,
  `docker compose up -d`, wait for Kikx `/health`; no cross-container log
  scraping (the entrypoint captures the key). Keep `--reset-root-key` (runs
  `aeordb emergency-reset` inside the container against the mounted DB).
- `deploy.sh`: unchanged flow (stage pinned refs, build, retag, restart,
  health-check) minus the aeordb image.
- `rollback.sh`: unchanged.

## Contracts

- Host ports: Kikx `127.0.0.1:3099`; AeorDB `127.0.0.1:6833`; internal Chrome
  `127.0.0.1:9224`; host Brave (external) `127.0.0.1:9222`.
- Env: `KIKX_HOME`, `PUID/PGID`, `KIKX_HOST_PORT`, `AEORDB_HOST_PORT`,
  `KIKX_IMAGE_TAG`, `AEORDB_VERSION`, `KIKX_TOKEN_REFRESH_SECONDS`, `OLLAMA_HOST`.
- AeorDB data path: `${KIKX_HOME}/.local/share/kikx/kikx.aeordb`; root key
  `${KIKX_HOME}/.local/share/kikx/root_key` (0600).
- One container name (see Open decisions); image `kikx-prod/kikx:<sha>`.
- Deploy by committed branch/ref (tags deferred).

## Phases

- **P3.0 — Base + bake aeordb.** Switch the kikx image base to
  `node:24-trixie-slim`; `COPY` the aeordb binary; drop the aeordb service and
  `images/aeordb/Dockerfile` build target. Gate: image builds; `aeordb --version`
  runs in-container.
- **P3.1 — Entrypoint supervises AeorDB.** Add `docker/lib/aeordb-supervisor.mjs`
  (spawn, banner capture → `root_key`, health-wait) and refactor the 299-line
  entrypoint into `docker/lib/token-manager.mjs` + orchestration. Gate: a fresh
  DB start captures the key once; restart reuses it; token path unchanged.
- **P3.2 — Data root, mounts, host network, credential overlays.**
  `KIKX_HOME` default → home; DB under `.local/share/kikx`; whole-home rw mount;
  `.ssh` (`.gnupg`) ro overlays; `network_mode: host`. Gate: all success
  criteria 1–5 verified.
- **P3.3 — Scripts + portability + docs.** Rewrite `compose.yml`/`bootstrap.sh`;
  update `README.md`; verify `KIKX_HOME=/tmp/otherhome ./bootstrap.sh` works;
  confirm host `npm test` unchanged. Gate: success criteria 6–7 verified.

## Verification spine

Reproduce each with recorded command output:

- **Unit (host):** `npm test` → 440/440 (unchanged; baseline captured).
- **Build:** `docker compose build` succeeds on trixie; `docker run --rm <img>
  aeordb --version` → `0.9.5`.
- **Bring-up:** `docker compose up -d`; `curl -s 127.0.0.1:3099/health` →
  `{"ok":true,...}`; `curl -s 127.0.0.1:6833/system/health` → healthy/degraded.
- **DB location:** `ls -l ~/.local/share/kikx/kikx.aeordb` exists; the old
  `kikx-prod/data/kikx.aeordb` mtime is unchanged.
- **Durability:** create a session, `docker compose restart`, session still
  listed.
- **Root key hygiene:** `docker exec <c> sh -c 'echo $AEORDB_ROOT_KEY'` empty;
  no `AEORDB_ROOT_KEY_FILE` in the server child env.
- **Host Brave reachable:** `docker exec <c> node -e "fetch('127.0.0.1:9222/json/version').then(r=>console.log(r.status))"`
  → 200.
- **Internal Chrome works:** `web-search` returns `source=duckduckgo-browser`
  (self-contained; does not touch host Brave).
- **Credential overlay:** `docker exec <c> sh -c 'touch ~/.ssh/x'` → permission
  denied; project writes elsewhere land uid 1000.
- **Portability:** `KIKX_HOME=/tmp/alt-home ./bootstrap.sh` on a clean data dir
  yields a working instance.

## Risks / limitations

- **Host network removes network isolation** for this container. Accepted: it
  runs as the operator's uid with the home mounted; the boundary is the image's
  frozen app, not the network.
- **Whole-home mount** exposes everything under `$HOME`. `.ssh`/`.gnupg` are made
  read-only; other secrets (e.g. `.aws`, `.config/gh`) remain readable unless
  added to the ro set. Document and extend the set over time.
- **Trixie base** is newer than bookworm; Node 24 is the same major. Chrome-for-
  Testing libs were verified to install, but the full image build must be
  re-verified end to end.
- **aeordb binary is host-built** and baked in (unchanged from prior plan); the
  binary path is the pinned input.
- **AeorDB child supervision**: an unexpected aeordb crash must not leave Kikx
  serving a dead backend; policy is to fail the container (let Docker restart)
  rather than silently continue.

## Open decisions

None outstanding. Resolved:
1. Naming: rename directory `kikx-prod/` → `kikx-docker/`; compose project and
   container `kikx`; image `kikx/kikx:<sha>`.
2. Chrome profile: move under `${KIKX_HOME}/.local/share/kikx/chrome-home`.

## Definition of done

- One container starts Kikx + AeorDB + Chrome on `127.0.0.1:3099` via
  `docker compose up -d`; `/health` ok.
- DB lives at `${KIKX_HOME}/.local/share/kikx/kikx.aeordb`; old DB untouched;
  survives restart.
- Root key captured once, never in the server env; bots cannot inherit it.
- Kikx reaches host Brave `9222` and uses its own Chrome for web tools.
- `.ssh` is read-only; project writes are uid 1000; `KIKX_HOME` rehost works.
- Host unit suite unchanged.
- All success criteria demonstrated with recorded command output.
