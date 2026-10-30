# Kikx

Kikx is AEOR Development's frame-based, plugin-driven agent harness for durable
work by humans and multiple AI agents. It supports multi-bot conversation
channels, coordinator routing, background context compaction, asynchronous
tools, cross-session work, bot/session hierarchies, characters, teams, and a
broad runtime plugin system.

> **Development status:** this is Kikx's third internal development revision.
> Kikx has never been publicly released; “revision 3” is project lineage, not a
> public major version or the package's semantic version. The first two
> revisions were scrapped and replaced after major structural problems.

The browser is the only first-party UI currently shipped, but the harness core
is UI-independent: persisted frames, shared projection, JSON APIs, runtime SSE,
and plugin descriptors sit below the browser client.

## Start with the documentation index

The canonical entry point is [`docs/README.md`](./docs/README.md). It routes bots
and developers by task, role, subsystem, status, and authority level.

Useful first reads:

- [`docs/overview.md`](./docs/overview.md) — mission, differentiators, and the
  implemented/partial/planned feature map.
- [`docs/architecture/README.md`](./docs/architecture/README.md) — current
  development-v3 architecture.
- [`docs/history/revisions/README.md`](./docs/history/revisions/README.md) — the
  three-revision lineage and archive rules.
- [`docs/reference/source-map.md`](./docs/reference/source-map.md) — where each
  subsystem lives in source.

Historical plans, incidents, reviews, and migrations are retained under
`docs/history/`. They preserve evidence from their date; they are not current
runbooks or architecture authority.

## Current architecture in one paragraph

`FrameRuntime` owns sessions and their in-memory `FrameEngine` instances. Frames
are committed through the store before `FrameRouter` dispatches them to commands,
tools, agents, schedulers, or other plugins. The shared `FrameManager` projects
raw frames into the coherent message view used by model context, APIs, and the
client. Domain stores use one configured database driver rather than binding
runtime contracts to a particular database product.

Current development and deployment configurations use PostgreSQL as the
operational primary. SQLite and AeorDB drivers remain built in; AeorDB is a
compatibility and possible future-return path while that database continues to
mature. If no driver is configured, source currently retains an `aeordb`
compatibility fallback, so deployments must select their intended driver
explicitly.

## Requirements

- Node.js 22 or newer.
- A configured, compatible database driver. Current development uses
  PostgreSQL 16 or newer.
- The AEOR web-components checkout for browser-client development.
- Local development configuration such as `.env.dev`; never commit credentials.

## Development

Install dependencies:

```bash
npm install
```

Start the configured development stack:

```bash
npm run dev
```

Start only the Kikx server:

```bash
npm run start:kikx
```

Restart it automatically when source changes:

```bash
npm run dev:watch
```

Generate a development magic-login link from the running server:

```bash
npm run magic-link
```

See [`docs/guides/development.md`](./docs/guides/development.md) for configuration,
startup behavior, database selection, login-link options, and troubleshooting.

## Verification

The primary test commands are:

```bash
npm test
npm run test:ui:playwright
npm run test:ui:stagehand
npm run test:ui:puppeteer
```

Some test paths create and delete documents in their configured test database.
Confirm that the URL points to disposable test infrastructure before running a
broad suite. UI changes require Stagehand coverage under the project rules.

See [`docs/guides/testing.md`](./docs/guides/testing.md) for suite boundaries,
credentials, legacy test-harness coupling, and safe direct commands.

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

Deployment/container implementation lives in the sibling distribution
repository, not this application repository. See
[`docs/operations/deployment.md`](./docs/operations/deployment.md).

## License

GPL-3.0-or-later.
