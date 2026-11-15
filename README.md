# Kikx

Kikx is AEOR Development's frame-based, plugin-driven agent harness for durable
work by humans and multiple AI agents. It supports multi-bot conversation
channels, coordinator routing, background context compaction, asynchronous
tools, cross-session work, bot/session hierarchies, characters, teams, and a
broad runtime plugin system.

> **Development status:** this is Kikx's third internal development revision.
> Kikx has never been publicly released; "revision 3" is project lineage, not a
> public major version or the package's semantic version. The first two
> revisions were scrapped and replaced after major structural problems.

The browser is the only first-party UI currently shipped, but the harness core
is UI-independent: persisted frames, shared projection, JSON APIs, runtime SSE,
and plugin descriptors sit below the browser client.

This README is written so a **bot or a human can stand the project up from a
fresh clone by executing the steps in order and running the verify command
after each one.** Every command is copy-pasteable; every claim is testable.

## Repository map (what to clone, what NOT to touch)

| Repository | Role |
|---|---|
| `kikx` (this repo) | The application: runtime, server, browser client, bundled plugins, tests, docs. |
| `aeor-web-components` | **Required at runtime** — the shared AEOR framework the client loads from `/vendor/...`. Clone it and point `AEOR_WEB_COMPONENTS_DIR` at it (its default is a hardcoded path on one machine). Remote: `git@github.com:th317erd/aeor-web-components.git`. |
| `kikx-docker` | Container/distribution implementation. Deployment lives here, not in this repo. Remote: `git@github.com:th317erd/kikx-docker.git`. |
| `kikx-plugin-claude`, `-codex`, `-google`, `-miri`, `-ollama`, `-puppeteer` (and `-discord` on the laptop host) | Separate plugin repos, each cloneable on its own. Installed/developed as plugins against this app. |
| `kikx2`, `kikx3` | **Other deployments of Kikx.** `kikx2` is a different agent's workspace and `kikx3` is the `kikx3.taraani.org` deploy target. If you are setting up your OWN instance, do not modify them; read [`docs/deploy-kikx3-taraani-20261114.md`](./docs/deploy-kikx3-taraani-20261114.md) before any deploy work. |

Start with the canonical documentation index: [`docs/README.md`](./docs/README.md).
It routes bots and developers by task, role, subsystem, status, and authority
level. Useful first reads: [`docs/overview.md`](./docs/overview.md) (mission and
feature map), [`docs/architecture/README.md`](./docs/architecture/README.md)
(current architecture), [`docs/reference/source-map.md`](./docs/reference/source-map.md)
(where each subsystem lives), [`docs/history/revisions/README.md`](./docs/history/revisions/README.md)
(the three-revision lineage and archive rules).

## Requirements

- **Node.js 22 or newer** (this project develops on Node 24; `package.json`
  enforces `>=22`).
- **A database driver choice**: PostgreSQL 16+ for a real instance, or the
  built-in `sqlite` driver (self-contained file, `:memory:` supported) for a
  quick look. AeorDB is **retired** — never configure it.
- **The `aeor-web-components` checkout** (repo map above) for the browser UI.
- Optional: **Google Chrome** for the browser test lanes; **Ollama** for the
  AI-driven Stagehand lane (it runs keyless against a local/default relay).
- Never commit credentials: local configuration lives in `.env.dev`
  (git-ignored; `.env.example` is the committed template).

## Stand-up (fresh clone → running server)

### 1. Clone both required repos

```bash
git clone git@github.com:th317erd/kikx.git
git clone git@github.com:th317erd/aeor-web-components.git
```

Verify: both directories exist and `kikx/node_modules` does **not** exist yet
(it is created next; some checkouts carry a local symlink — if `npm install`
complains, delete `node_modules` first and rerun).

### 2. Create your local configuration

```bash
cd kikx
cp .env.example .env.dev
```

Then edit `.env.dev` — these are the keys a fresh setup must set:

| Key | Set it to |
|---|---|
| `ORG_AEOR_KIKX_DATABASE_DRIVER` | `postgresql` (uncomment; must match the URL below) or `sqlite` for a file/memory store |
| `ORG_AEOR_KIKX_DATABASE_URL` | e.g. `postgres://user@127.0.0.1:5432/kikx` (uncomment) |
| `KIKX_ADMIN_EMAIL` | the first administrator's email (uncomment; without it the server boots but nobody can sign in) |
| `AEOR_WEB_COMPONENTS_DIR` | absolute path to your `aeor-web-components` clone |
| `KIKX_PLUGIN_SIGNING_PUBLIC_KEYS` | generated in step 4 (plugin signatures are **required** by default) |

Verify: `grep -E '^(ORG_AEOR_KIKX_DATABASE_DRIVER|KIKX_ADMIN_EMAIL|AEOR_WEB_COMPONENTS_DIR)=' .env.dev`
prints your three lines.

### 3. Install dependencies

```bash
npm install
```

Verify: `node -e "console.log(require('playwright/package.json').version)" && test -d node_modules && echo deps-ok`
— prints the pinned Playwright version and `deps-ok`.

### 4. Plugin signing keys (signatures are required by default)

```bash
node scripts/sign-plugin.mjs --generate            # prints the public key
```

Put the printed key into `.env.dev` as `KIKX_PLUGIN_SIGNING_PUBLIC_KEYS`.
Sign any plugin directory you install from source:

```bash
node scripts/sign-plugin.mjs --key <private-key-pem> <pluginDir...>
```

Plugins without a valid `.kikx-sig` are refused **before** their code is ever
imported (`signature:missing` / fail-closed). Development lanes run
`KIKX_PLUGIN_SIGNATURE_MODE=unsafe` from `.env.dev` only when you choose that
mode — never ship it. See [`docs/guides/plugin-authoring.md`](./docs/guides/plugin-authoring.md).

### 5. Run it

```bash
npm run dev          # start-dev: server with dev defaults
```

Verify:

```bash
curl -s http://127.0.0.1:3000/health
# => {"ok":true,"ready":true,...}
```

Port/host come from `KIKX_HOST`/`KIKX_PORT` (defaults `127.0.0.1:3000`). The
core schema creates itself on first boot (`CREATE TABLE IF NOT EXISTS`); no
separate migrate step exists for a fresh database. For auto-restart on source
changes use `npm run dev:watch`. Configuration, database selection, and
troubleshooting: [`docs/guides/development.md`](./docs/guides/development.md).

### 6. Sign in (mailer runs in log mode by default)

With the server running:

```bash
npm run login-link -- you@example.com
# prints: http://127.0.0.1:3000/?code=...
```

Open the printed link (or pass `--token` to exchange it and print a bearer
token instead). The magic link is written to the dev mailer log when you click
through the UI instead; `KIKX_AUTH_MAILER_MODE=log` is the default — switch to
SMTP (`KIKX_AUTH_MAILER_SMTP_URL`) for a real deployment.

### 7. Verify the install with the test suite

```bash
npm test             # default gate: unit + Playwright (hermetic, no services)
npm run test:all     # full estate: + Stagehand (Ollama), Puppeteer, proof:live-boot
```

Notes a bot must not skip:

- The default lanes are **hermetic** — they never read `.env.dev`.
- `npm run test:all` grants `.env.dev` to the non-hermetic lanes (Stagehand,
  Puppeteer, and `proof:live-boot`, which needs the configured database URL and
  skips itself where none exists).
- Chrome must be installed for browser lanes (each skips itself without it).
- Broader suite details, per-lane commands, and safety notes:
  [`docs/guides/testing.md`](./docs/guides/testing.md).

## Plugins

- Bundled plugins live in `plugins/` (an empty directory is fine); external
  plugin sites are additive via `KIKX_PLUGIN_PATHS`.
- Management UI: **Settings → Plugins** — install from an absolute path, browse
  and install npm packages tagged `kikx-plugin`, update, unload, disable,
  two-click uninstall (managed directories only).
- Runtime installation requires `KIKX_PLUGIN_INSTALL_ENABLED=true`.
- Optional registry override: `KIKX_PLUGIN_REGISTRY_URLS` (defaults to public
  npm); npm installs land under `KIKX_PLUGIN_NPM_DIR`.
- Plugin authoring contract: [`docs/guides/plugin-authoring.md`](./docs/guides/plugin-authoring.md);
  platform campaign record: [`docs/plans/plugin-platform-campaign.md`](./docs/plans/plugin-platform-campaign.md).

## Deployment and containers

Container and distribution work lives in the **`kikx-docker`** repository, not
here. See [`docs/operations/deployment.md`](./docs/operations/deployment.md) for
what this repository owns, and the measured kikx3 runbook
[`docs/deploy-kikx3-taraani-20261114.md`](./docs/deploy-kikx3-taraani-20261114.md)
for a real deploy record (hostname, host, port, rollback).

## Current architecture in one paragraph

`FrameRuntime` owns sessions and their in-memory `FrameEngine` instances. Frames
are committed through the store before `FrameRouter` dispatches them to commands,
tools, agents, schedulers, or other plugins. The shared `FrameManager` projects
raw frames into the coherent message view used by model context, APIs, and the
client. Domain stores use one configured database driver rather than binding
runtime contracts to a particular database product. Current deployments use
PostgreSQL as the operational primary with the sqlite driver built in for
self-contained setups; a config-less boot defaults to `sqlite` (AeorDB is
retired), so deployments should always select their intended driver explicitly.

## Repository boundaries

- `src/core/` — UI-independent runtime, agents, plugins, tools, stores, auth,
  compaction, teams, questions, tags, and database abstractions.
- `src/shared/` — browser-safe frame/session projection contracts.
- `src/server/` — Node HTTP/SSE adapters and application composition.
- `src/client/` — the current AEOR-based browser UI.
- `plugins/` — bundled plugins; external plugin sites are additive.
- `spec/` — unit, architecture, server, client, ownership, and browser coverage.
- `docs/` — all current, roadmap, maintainer, operational, and historical
  documentation.
- `old-app/` — archived legacy implementation; reference only.

## License

GPL-3.0-or-later.
