# Kikx: ConfigStore + property-path env scheme (P0b)

Status: **implementing (staged).** Parent plan:
`bot-docs/plans/kikx-database-driver-layer.md` §4.5/§4.6/§6 (P0b).

## Decision (D9)

All environment/property access goes through an **async** `ConfigStore` so the
underlying source can change later (`.env` -> `.json` -> remote/DB) without
touching call sites. The property-path scheme (D7) derives env key names from
paths: `key = path.replaceAll('/', '_').toUpperCase()` after trimming and
sanitizing each segment.

Precedence (highest first): **real `process.env` > `.json` env document >
defaults**. The `.json` provider reads its file directly as a distinct
lower-precedence source; it does not have to mutate `process.env`.

## Staging (each independently green and revertible)

- **P0b-1 — ConfigStore core + property scheme + providers + specs.** DONE
  (`src/core/config/`, 43 specs). Self-contained; no existing code touched.
- **P0b-2 — One env loader + dev launchers.** Collapse the 6 duplicated
  `loadEnvFile` copies into the shared loader built on the config providers;
  migrate `scripts/*`; add `.json` env patterns to `.gitignore`; document keys
  in `.env.example`.
- **P0b-3 — `src/` migration + async bootstrap.** DONE: `createServer()` is
  async; all raw `process.env` in `src/` routed through `ConfigStore` (or the
  config module's `snapshotEnvironment` ambient helper); `src/server/index.mjs`
  is an async `main()`; grep-gate `spec/core/config/no-process-env-spec.mjs`
  forbids raw env reads outside `src/core/config/`; `create-server-config-spec.mjs`
  proves wiring.

## P0b-1 module layout

```
src/core/config/
  property-path.mjs     # pure: normalizePropertyPath, envKeyFor, joinPropertyPath
  config-error.mjs      # ConfigError { code, propertyPath }
  config-providers.mjs  # processEnv / object / defaults providers; flattenJsonEnv; loadJsonEnvFile
  config-store.mjs      # ConfigStore + createConfigStore
  index.mjs             # public exports
spec/core/config/
  property-path-spec.mjs
  config-providers-spec.mjs
  config-store-spec.mjs
```

## P0b-1 API

- `normalizePropertyPath(path)` -> `'/a/b'` (trim, collapse, leading slash).
- `envKeyFor(path)` -> `'A_B'`; `/org/aeor/kikx/database/driver` ->
  `ORG_AEOR_KIKX_DATABASE_DRIVER` (leading slash stripped before joining).
  Non-alphanumeric in a segment -> `_`. Note: sanitizing is lossy, so `/a-b`,
  `/a_b`, `/a.b`, `/a@b` all alias `A_B`; config key lists must avoid
  near-collisions.
- `ConfigStore({ sources })`; `async get(path)`, `async getWithDefault(path, dflt)`,
  `async require(path)` (throws `ConfigError` code `config_missing`),
  `async list(prefix)` (merged provider entries, segment-boundary prefix match,
  first source wins, sorted), `async resolveAll(paths)` -> `{ path, value }[]`.
- Providers: `createProcessEnvProvider(env)`, `createObjectProvider(document)`
  (flattened property-path map, plain object required),
  `createDefaultsProvider(map)`; each exposes `async get(path)` and optional
  `async *entries(prefix)`. The process-env provider cannot reverse-map env
  names reliably, so its `entries` yields nothing; use `get()`/`resolveAll()`
  for known keys (descriptor `configKeys`).
- `flattenJsonEnv(document)` supports absolute keys (`/org/...`) and nested
  objects (absolute keys nested inside a nested object stay absolute);
  `loadJsonEnvFile(path, { fsImpl })` reads + parses + flattens, ENOENT -> `{}`,
  malformed JSON -> `ConfigError` `config_malformed_json`, non-object document
  -> `ConfigError` `config_invalid_document` naming the file.
- `createConfigStore({ env, jsonEnvPath, defaults, additionalSources })` precedence
  (highest first): `process.env` > `.json` env > `additionalSources` >
  `defaults`. An explicit `env: null` disables the process-env source.
- `getDriver()` convenience is **deferred to P1**, where driver selection
  semantics are pinned.

## Decided (P0b-3)

- **`createServer()` is async.** Plan §4.5/§6 called for the async boundary;
  D6 permits pulling it forward from P1. All 53 module `createServer(...)` spec
  call sites now `await`.
- **Legacy env names preserved.** Property paths are chosen so `envKeyFor(path)`
  equals the existing env var (`/kikx/host` -> `KIKX_HOST`), so `.env.dev` and
  deployments did not change. New database config uses the
  `/org/aeor/kikx/database/...` namespace.
- **Ambient vs config.** Kikx settings go through `ConfigStore`; genuinely
  process-level values (spawned-command env, `SHELL`, puppeteer executable/
  channel, and direct-construction client/service defaults) read through the
  config module's `snapshotEnvironment()` helper. Raw `process.env` exists only
  in `src/core/config/`.
- **Atomic composition.** `createServer` resolves every config value before any
  store guard, so the guard/`set` pairs run in one synchronous section for a
  shared `context`.
