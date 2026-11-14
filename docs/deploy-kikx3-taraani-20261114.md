# Deploying to `kikx3.taraani.org` — topology, target and procedure

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

## Two failures that are silent, and how to catch them first

Both were caught on 2026-11-14 *before* restarting kikx3. Neither shows up as a
build error, and neither is visible in a health check afterwards.

### 1. A plugin can vanish from the image

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
