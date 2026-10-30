# Development setup

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against `package.json`, launch scripts, configuration loaders, and server bootstrap.

Kikx v3 is an unreleased Node.js application with a plain HTTP server and native browser client. Current development uses PostgreSQL as the configured database backend while retaining a pluggable driver architecture.

## Requirements

- Node.js 22 or newer; the current development host uses a newer compatible release.
- npm and the locked dependencies in `package-lock.json`.
- A reachable database selected through configuration. PostgreSQL is the current primary.
- The AEOR web-components checkout or an explicitly configured equivalent path.
- Chrome/Chromium for real-browser test lanes.
- An external model credential only for Stagehand tests that actually use a model.

Never commit credentials, connection secrets, root keys, generated login links, or local environment files.

## Install

For a reproducible clean install:

```bash
npm ci
```

Use `npm install` only when intentionally updating dependencies or the lockfile.

## Configure the database

Current development explicitly selects PostgreSQL:

```text
ORG_AEOR_KIKX_DATABASE_DRIVER=postgresql
ORG_AEOR_KIKX_DATABASE_URL=<development database URL>
```

Keep the URL in the local environment, not documentation or source. The source-level driver fallback is still AeorDB, so omitting the selection does not mean “use the current primary.”

## Start the development stack

```bash
npm run dev
```

The launcher loads `.env.dev` additively, resolves the configured driver, starts AeorDB only when the legacy driver is selected, starts Kikx when its port is free, waits for readiness/listening, and supervises child process groups. With PostgreSQL selected, the database must already be available; the launcher does not start PostgreSQL.

Start only Kikx:

```bash
npm run start:kikx
```

Start with the development wrapper:

```bash
npm run start:kikx:dev
```

The wrapper performs the legacy backend health/token steps only when the AeorDB driver is active, then supervises the server child and forwards termination signals.

## Watch mode

```bash
npm run dev:watch
```

Watch mode expects the database to be running. It fingerprints `src`, `scripts`, `package.json`, and `.env.dev` by default, ignores runtime/generated/history directories, restarts the Kikx process group after a stable change, and waits for `/health`. It refuses to take over a server already responding on the configured address.

`KIKX_WATCH_PATHS` can replace the default watch entries.

## Development login

With the native mailer in log mode, request a link from the running server:

```bash
npm run login-link -- user@example.com
```

Print a bearer token instead of a browser URL:

```bash
npm run login-link -- user@example.com --token
```

The helper requests a Kikx-native magic link and watches the configured native auth log. It retains an old AeorDB-log fallback for compatibility; that fallback is not the current auth architecture.

## Health check

```bash
curl -fsS http://127.0.0.1:3000/health
```

Check both `ok` and `ready`. HTTP 200 with `ready: false` means the process is alive but startup recovery has not settled.

## Working in the browser client

There is no bundle step. The server serves ES modules directly. Before modifying DOM code, read the AEOR framework skill named in `AGENTS.md`. After changes, restart the development server when necessary and verify an actual page load, not just static imports or unit tests.

## Sources of truth

- `package.json`
- `package-lock.json`
- `scripts/start-dev.mjs`
- `scripts/start-kikx-dev.mjs`
- `scripts/dev-watch.mjs`
- `scripts/request-login-link.mjs`
- `src/server/index.mjs`
- `src/server/create-server.mjs`
- `.env.example`

## Related

- [Configuration reference](../reference/configuration.md)
- [Testing guide](testing.md)
- [Frontend guide](frontend.md)
- [Runtime lifecycle](../operations/runtime-lifecycle.md)

