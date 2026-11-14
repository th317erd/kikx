# Deploying to `kikx3.taraani.org` — topology, target and procedure

**Status: current** — the live kikx3 runbook (measured 2026-11-14).

Written 2026-11-14 while deploying `origin/main` to kikx3. Every host/port claim
below was measured this session, not inferred from memory; the commands that
produced each are named so they can be re-run.

## Why this document exists

Three Kikx hostnames are live behind Cloudflare and they are **not** the same
instance, are **not** on the same machine, and do **not** share a build. Deploying
to "the kikx container" without naming the hostname, host and port risks shipping
to the wrong one — and two of them are not even reachable from the local shell
without going through a tunnel.

## Measured topology

```
kikx3.taraani.org  -> Cloudflare edge -> atlas nginx :443
                       /mnt/web/sites/kikx3.taraani.org.conf  proxy_pass 127.0.0.1:3098
                     -> atlas kikx-tunnel.service: ssh -L 127.0.0.1:3098:127.0.0.1:3098 wyatt@192.168.1.98
                     -> wyatt-laptop 127.0.0.1:3098  (container "kikx", KIKX_PORT=3098)
```

### Source evidence

- `atlas:/etc/nginx/nginx.conf:61` — `include /mnt/web/sites/*.conf;`
- `atlas:/mnt/web/sites/kikx3.taraani.org.conf` — comment: "the legacy/parallel
  Kikx instance that lives on wyatt-laptop (host port 3098), reached through
  kikx-tunnel.service"; `proxy_pass http://127.0.0.1:3098;`
- `atlas` pid 989813 —
  `ssh -N ... -L 127.0.0.1:3098:127.0.0.1:3098 -L 127.0.0.1:3003:127.0.0.1:3003 wyatt@192.168.1.98`
- `wyatt-laptop`: `docker inspect kikx` → compose project dir
  `/home/wyatt/Projects/kikx-workspace/kikx-docker`, `KIKX_PORT=3098`,
  `ORG_AEOR_KIKX_DATABASE_DRIVER=postgresql`

### The hostname-to-instance map

| hostname | nginx upstream on atlas | actual host | port |
| --- | --- | --- | --- |
| `kikx3.taraani.org` | `127.0.0.1:3098` | wyatt-laptop | 3098 |
| `kikx.taraani.org` | `127.0.0.1:3099` | atlas itself | 3099 |
| `kikx2.taraani.org` | `127.0.0.1:3003` | wyatt-laptop (dev instance) | 3003 |

## The trap that cost the most time

`atlas` and `wyatt-desktop` **both** run a container called `kikx` on host port
`3099`, and they are different builds:

```
wyatt-desktop :3099 /health -> {"ready":true,"services":{"aeordb":true}}
atlas         :3099 /health -> {"ready":true,"version":"unknown","services":{"database":true}}
```

Only the **asset hash** settles it. `index.html` cache-busts its stylesheets with
a content hash, so `app.css?v=<hash>` identifies the build exactly:

```
wyatt-laptop :3098           app.css?v=3008926bb611   <-- matches public kikx3
public kikx3.taraani.org     app.css?v=3008926bb611
atlas :3099                  app.css?v=e8878042530d   <-- different build
```

Host-header test, run **on atlas**, which proves the vhost-to-backend binding
without depending on DNS or Cloudflare:

```sh
ssh atlas 'for h in kikx.taraani.org kikx3.taraani.org; do
  curl -sk -H "Host: $h" https://127.0.0.1/ | grep -o "app.css?v=[a-f0-9]*" | head -1
done'
# kikx.taraani.org   app.css?v=e8878042530d     (atlas :3099)
# kikx3.taraani.org  app.css?v=3008926bb611     (laptop :3098, via tunnel)
```

## Procedure used

Build on `wyatt-desktop` (16 cores, every repo and the `aeordb` binary present),
then ship the image to `wyatt-laptop`, which owns port 3098. This is the
`KIKX_DEPLOY_BUILD_ONLY=1` path that `deploy.sh` documents for exactly this
cross-host case.

```sh
cd /home/wyatt/Projects/kikx-workspace/kikx-docker
KIKX_REPO=/home/wyatt/Projects/kikx-workspace/kikx2 \
REF_AEOR_COMPONENTS=origin/main \
KIKX_DEPLOY_BUILD_ONLY=1 \
  ./deploy.sh origin/main
```

- `KIKX_REPO` is overridden to `kikx2` (this lane). The default is `../kikx`,
  which is a different bot's working checkout.
- Passing `origin/main` rather than a bare `main` removes the ambiguity
  `resolve_commit` warns about: it stages the published commit, not whatever the
  local checkout happens to point at.
- Build-only deliberately skips `compose up`, probes and `.env`/`.last-deploy`
  bookkeeping. Those belong to the host that runs the tag, so the desktop's own
  `kikx` container and `.env` are untouched.
- The build also runs `scripts/check-vendor-coverage.mjs`, which refuses to build
  a client whose staged vendor tree is missing an imported file.

Then on the target host:

```sh
ssh wyatt-laptop   # in ~/Projects/kikx-workspace/kikx-docker
sed -i 's/^KIKX_IMAGE_TAG=.*/KIKX_IMAGE_TAG=<new_sha>/' .env
KIKX_IMAGE_TAG=<new_sha> docker compose up -d --no-deps kikx
```

## Three failures that are silent, and how to catch them first

Both were caught on 2026-11-14 *before* restarting kikx3. Neither shows up as a
build error, and neither is visible in a health check afterwards.

### 1. A plugin can vanish from the image — and presence is not parity

`deploy.sh` stages each plugin from a repo path and only logs a `skipping` line
when a repo is absent — the build still succeeds. The Dockerfile then bakes
whatever landed in `images/kikx/staging/plugins/`, so a plugin that failed to
stage is **deleted** from the image, and the container starts healthy with
Discord (or any other transport) simply gone. kikx3 carries
`kikx-plugin-discord` with a live gateway, so this is a real regression path.

Verify the built image, not the log:

```sh
docker run --rm --entrypoint sh kikx/kikx:<sha> -c 'ls -1 /opt/plugins'
# expect all seven: claude, codex, discord, google, miri, ollama, puppeteer
```

Also pass the repo explicitly when the plugin is not on this host's default path:

```sh
KIKX_PLUGIN_DISCORD_REPO=/home/public/wyatt-laptop/Projects/kikx-workspace/kikx-plugin-discord \
KIKX_PLUGIN_DISCORD_REF=master
```

Note the staging step prints `local master is <x> but origin/master is <y>;
staging the published commit` — it stages `origin/master`, not the local branch.

**A plugin being present is not enough.** On 2026-11-14 the first real deploy
`9310da89` shipped an image whose `/opt/plugins` listed all seven plugins — so the
`ls -1` check above passed — and the container still crash-looped. What was wrong
was the *contents* of two plugin directories. Compare migration files, not
directory names, against the last-good image:

```sh
ssh wyatt-laptop 'docker exec kikx sh -c "for d in /opt/plugins/*/; do
  n=$(find \"$d\" -name \"*.sql\" | wc -l)
  echo \"$(basename $d) sql=$n $(find \"$d\" -name \"*.sql\" -printf \"%f \")\"
done" | sort'
# 2026-11-14 baseline, measured from the working image aad7743c:
#   miri    sql=3  001-actor-character.sql 002-capabilities.sql 003-notes.sql
#   discord sql=5  001-channel-session.sql 002-message-frame.sql 003-edit-audit.sql
#                  004-inbound-capability.sql 005-channel-bot-key.sql
#   every other plugin sql=0
```


### 2. The plugin signature gate can refuse everything

`src/core/plugins/plugin-loader.mjs` is **fail-closed**: if neither the config
service nor `KIKX_PLUGIN_SIGNATURE_MODE` supplies a mode, it uses `'required'`,
and `/opt/plugins` ships no `manifest.json`/`.kikx-sig`, so every plugin is
refused. The mode is read from the persisted config key
`/kikx/plugin/signature/mode` first, and only falls back to the environment.

kikx3's `.env` does **not** set `KIKX_PLUGIN_SIGNATURE_MODE`, yet its plugins
load: the effective mode comes from the config store under
`/home/wyatt/.local/share/kikx/`, which lives outside the container and therefore
survives a restart. Confirm rather than assume:

```sh
ssh wyatt-laptop 'docker logs kikx 2>&1 | grep -i signature | tail -2'
# [kikx] plugin signature verification DISABLED (KIKX_PLUGIN_SIGNATURE_MODE=unsafe) ...
```

`compose.yml` must forward the variable for the env fallback to work at all;
that was added in `10bba61` ("compose: declare KIKX_PLUGIN_SIGNATURE_MODE so
.env can reach the container"). Keep the target's `compose.yml` in sync with the
repo before restarting.

### 3. Plugin migrations can abort every route, `/health` included

This is the failure that took kikx3 down on 2026-11-14, and it is the most
insidious of the three because the container **starts**, the healthcheck command
runs, and the log is dominated by unrelated Chrome/dbus noise.

`src/core/plugins/plugin-migrations.mjs` refuses to finish startup when the
ledger records a migration as applied but the file is no longer in the image:

```
[plugin-migrations] startup aborted: plugin "miri" has migration 2 recorded as
applied (002-capabilities.sql) but the file is missing. Restore it or write a
new migration.
[plugin-load] continuing with whatever loaded: plugin "miri" has migration 2 ...
```

The abort is global rather than per-plugin: `/health` stopped answering while the
container sat `health=unhealthy`, so the deploy looked like a bad kikx build
rather than a bad plugin stage.

What produced it: `deploy.sh:127` defaults each plugin source to
`${WORKSPACE}/kikx-plugin-<name>`. On this desktop `kikx-plugin-miri` is a
**divergent fork** — no `origin` remote, `6ea3a85` versus the laptop's `4c226af`,
4498 B versus 9238 B `index.mjs` — and there is no local `kikx-plugin-discord` at
all. Building without pins therefore baked the fork's single-migration `miri`
tree into an image whose PostgreSQL ledger already had `002` applied.

The fix that works: pin every plugin repo **and** ref, and stage from the
target's own checkouts through the sshfs mount
`/home/public/wyatt-laptop/Projects/kikx-workspace/kikx-plugin-*`. Verified
2026-11-14 — all seven pinned refs resolve to migration sets identical to the
`aad7743c` baseline above (`miri` 3, `discord` 5, the rest 0):

```sh
M=/home/public/wyatt-laptop/Projects/kikx-workspace
for spec in codex:6a2247d claude:d5d7a92 ollama:dca2f5c google:3b47c77 \
            puppeteer:52103c9 miri:4c226af discord:5984a87; do
  n=${spec%%:*}; r=${spec##*:}
  printf '%-10s ' "$n"
  git -C "$M/kikx-plugin-$n" ls-tree -r --name-only "$r" \
    | grep -i '\.sql$' | xargs -r -n1 basename | tr '\n' ' '
  echo
done
```

`check-vendor-coverage.mjs` does not catch this. It validates that every vendor
import resolves and has no knowledge of the plugin migration ledger, so a build
can pass that gate and still be undeployable. Gate on the sql manifest instead.

### Do not reuse an app commit sha as an image tag

`KIKX_IMAGE_TAG` here is the *app* short sha (`9310da89`), so rebuilding after a
failed deploy silently **overwrites** the previous tag and destroys the evidence.
The broken image was preserved by hand as `kikx/kikx:9310da89-badplugins`. When a
deploy fails: retag the bad image before rebuilding, and keep the last-good tag
(`aad7743c`) resident as the rollback anchor.

## Architecture

Build and target are both `x86_64`/`amd64`. Check it, because a mismatch fails at
*start*, not at `docker load`:

```sh
docker image inspect --format '{{.Architecture}}/{{.Os}}' kikx/kikx:<sha>   # amd64/linux
```

## Transferring the image

The desktop and laptop are separate Docker daemons, so the image must move. A
streamed compress-over-ssh pipeline avoids a temp file on either end:

```sh
docker save kikx/kikx:<sha> | zstd -T0 -3 -q -c \
  | ssh -o Compression=no wyatt@192.168.1.98 'zstd -d -q -c | docker load'
```

Expect several minutes for a ~2.4 GB image. Do not trust `latest` on the target:
on 2026-11-14 the laptop's `latest` pointed at `b62c0bd1` while `aad7743c` was
the running tag. Pin `KIKX_IMAGE_TAG` explicitly in `.env` and re-run with
`KIKX_IMAGE_TAG=<sha> docker compose up -d --no-deps kikx`.

## Verification that counts

A passing health check does not prove the deploy landed. Assert the build:

1. Rollback point recorded (`~/Projects/kikx-workspace/kikx-docker/.last-deploy`).
2. `wyatt-laptop:3098/` serves the expected `app.css?v=<hash>` for the new tree.
3. Public `https://kikx3.taraani.org/` serves the **same** hash, which proves the
   tunnel and nginx vhost still point at the new container.
4. Boot smoke in the container, because grepping the image cannot see a broken
   module graph.
5. Negative control wherever a behavioural claim is made: the check must fail
   against the previous image.

## Rollback

`kikx-docker/rollback.sh` on `wyatt-laptop`. The previous image tag is in
`.last-deploy`; data lives outside the container in
`/home/wyatt/.local/share/kikx/` and is not touched by a deploy.

`rollback.sh` probes `KIKX_HOST_PORT` with a default of `3099`, but the laptop
uses `3098`. Pass it explicitly or the probe checks the wrong port.
