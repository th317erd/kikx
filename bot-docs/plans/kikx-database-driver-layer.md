# Kikx: Pluggable Database Connectivity Layer

Status: **PROPOSED.** Planning only; implementation not authorized.

## 1. Purpose and intent (owner rulings)

**Owner (2026-10-05):** "We need to make a unified database connectivity layer.
This way we can START with this layer supporting an 'aeordb driver'. After all
our tests pass that way, then we can make a PostgreSQL driver, and maybe even a
SQLite driver. This way WE OURSELVES can switch to any backend database, and
easily go back to aeordb once it is stable."

**Owner (2026-10-05, follow-up rulings):**
- "We can just have a `DatabaseConnectionBase` that is a plugin of its own, and
  then have it implement methods in child classes that plugins provide (i.e.
  'AeorDB', 'PostgreSQL', 'SQLite', etc...)." → The base is a plugin; drivers are
  **child classes** the plugin system provides.
- **D3:** "PostgreSQL first (the wildcard, trigram, phonetic, and fuzzy searching
  is important to me)." → First non-AeorDB driver is **PostgreSQL**, and the
  Kikx search tools must keep working there (trigram + phonetic + fuzzy).
- **D5:** "As my quirks always state clearly: pluralize the entire system. Let's
  DO support multiple different database drivers in the application... but for
  now, we will functionally limit it to one (via config...). As for trust,
  installed plugins are trusted." → Multi-driver capable; config selects one
  active driver today; plugin-folder trust for now (signed plugins later).
- **D1:** per-driver auth; credentials live in `.env`; and a **property-path**
  scheme: "something like `/org/style/URI/type/paths/for/properties` (maybe we
  should move to `.json` env files... underscore_these_org_type_paths... by
  replacing all forward slashes with underscore in `process.env` access)."
- **D6:** "I don't really care on the ordering. We need to build the entire
  system."

Motivating incident (2026-10-05): AeorDB (prod) latched a persistent read-only
durability-failure state after a write-heavy session; `GET /system/health`
returned `unhealthy`; the container supervisor (accepts only `healthy`/
`degraded`) refused to start Kikx. Reads still served; data intact. Owner authors
AeorDB and is mid-refactor to fix its instability; it is **not yet stable**. This
plan lets Kikx run on PostgreSQL now and return to AeorDB later without a rewrite.

## 2. Evidence — surface (verified)

### 2.1 Persistence (what a driver must provide)
Stores today take `new XStore({ aeordb })` and call a small method set directly;
no `db` abstraction exists. Consumed methods: `getFile`, `putFile`, `patchFile`
(merge-patch), `deleteFile`, `listDirectory({depth,glob,limit,offset})`,
`searchFiles`, `queryFiles`, `fetchFiles`, `fetchFileRanges`, `eventsURL`,
`withToken`, plus auth (`requestMagicLink`/`verifyMagicLink`/`exchangeAPIKey`/
`refreshToken`/`listOwnAPIKeys`/`getSystemUser`/`updateSystemUser`).
Stores: Account, Agent/Team (AeorDB stores), AgentTodo, AgentCwd, Feedback,
TokenUsage, ToolOutput, ProcessStore, FrameRuntime→AeorDBFrameStore.
AeorDB-specific coupling: `.aeordb-config/indexes.json` writes (31 refs),
structured search/query, JWT/magic-link/API-key auth, `/system/events` SSE.

### 2.2 Frame store is NOT a plain document store (critical)

`FrameRuntime` → `AeorDBFrameStore` depends on commit/frame/ref semantics beyond
plain key/value documents:
- `saveCommit(sessionID, commit, frames, frameEngine)` persists each frame, then
  the commit, then refs (`aeordb-frame-store-commit.mjs:115-146`).
- `listFrames` **joins frames against commits** (`orderFramesByCommits`); the
  `refs/` layer is written via `frameEngine.listRefs()` (`saveRefs`).
- Display order is `commitOrder` then `order` (`compareFrameOrder`); the
  scheduled-frame window anchors on **path order** (zero-padded frame filenames),
  which is what the P9/tail-window fixes depend on.

Consequences for the contract: the driver needs either a **transaction/batch
primitive** or the frame store must be a **composed layer** (a `FrameStore`
built on the driver) that owns commit/ref/ordering semantics. A 1:1 mapping of
`saveCommit` onto `put/get/list` loses atomicity (frames without commits on a
crash) and ref persistence. This is the largest gap in the earlier draft.

### 2.3 Search contract (must survive on PostgreSQL)
`DatabaseSearchTool` (`src/core/tools/database-tools.mjs`) builds a locator search
request `{path, limit, offset, include_matches, max_matches_per_result,
snippet_chars, match_context_lines, query?, where?}` and formats the response as
per-result `{path, score, matched_by, content_hash, updated_at, matches:[{id,
matched_text, source, range:{line,byte}, fetch:{line_range,byte_range,preferred}}]}`
plus `has_more`/`total_count`/`next_cursor`/`prev_cursor`. `SessionSearchTool`
scopes it to a session path. `database-fetch` consumes the locators (mode
`lines|chars|bytes|json_pointer`). **This byte/line-locator behavior is the hard
part to reproduce on a relational backend.**

### 2.4 SSE/events is vestigial (verified)

`GET /api/v1/aeordb/events-url` is served (`infra-routes.mjs:30`) and fetched
into `state.aeordbEventsURL` (`kikx-state.mjs:39`), but **that field has no
consumer** — grep finds only the assignment. Live updates use Kikx's own
`/api/v1/events` SSE (`kikx-runtime-events.mjs`). Therefore `events` is **not a
required driver capability**; keep `eventsURL?` optional (and consider deleting
the dead route/field as cleanup, separate from this plan).

### 2.5 Auth is woven into AccountStore document I/O (verify)

`AccountStore` mixes identity resolution (`isRoot`/`isFallback`) with *both*
bespoke system calls (`withToken().listOwnAPIKeys`, `getSystemUser`,
`updateSystemUser`) *and* ordinary `putFile`/`getFile` profile documents. Auth is
therefore not cleanly orthogonal to the driver interface; the driver contract
must expose a documented auth boundary (or the account store must be treated as
an auth-aware composed layer). Resolve alongside P3.

### 2.6 Environment / credentials
`.env`, `.env.*` are gitignored (`!.env.example`); `.env.dev` exists with
`AEORDB_*`. Loaders: `scripts/start-kikx-dev.mjs` and `scripts/start-dev.mjs`
(hand-rolled `loadEnvFile`, only setting keys absent from `process.env`).
Owner's dev-only Postgres (uncommitted; never write to tracked files):
user `kikx-dev`, host `127.0.0.1:5432`, db `postgres`; extensions present:
`pg_trgm 1.6`, `fuzzystrmatch 1.2`, `unaccent 1.1`, `btree_gin 1.3`,
`btree_gist 1.7`.

### 2.7 Baselines
Core **749/749**, codex 37/37, ollama 18/18 (HEAD `0e69280`+). Sibling session's
uncommitted UI files present in the tree (unrelated; must be preserved).

## 3. Frame

### Target
1. A `DatabaseConnectionBase` **plugin base** + `DatabaseConnection` contract
   (document-store semantics, capability model). Concrete drivers are child
   classes the plugin system provides: `AeorDBConnection`, `PostgreSQLConnection`,
   `SQLiteConnection`.
2. A driver registry on `PluginRegistry` supporting **multiple** registered
   drivers; config selects the active one (functionally one today).
3. A **property/env URI-path loader**: `/org/style/uri/type/paths`-style property
   keys, optionally backed by `.json` env files, flattened into `process.env` by
   replacing `/` with `_`.
4. `AeorDBConnection` reproduces today's behavior byte-for-byte with **zero**
   behavior change; all suites green.
5. `PostgreSQLConnection` reproduces the store + **search** contracts, with
   trigram (`pg_trgm`), phonetic (`fuzzystrmatch`), and fuzzy indexes.
6. Easy reversal to AeorDB (config change).

### Non-goals
- Fixing AeorDB (owner's separate refactor).
- Changing Kikx's frame/document data model or persisted paths.
- A general ORM or SQL passthrough.
- Deleting the AeorDB path.
- Signed-plugin trust / a plugin repository (owner has this designed elsewhere;
  installed-plugin-folder trust is accepted for now).
- Switching prod to a non-AeorDB backend without explicit authorization.

### Binding constraints
- **Parity first:** AeorDB driver = no behavior change; every diff is a
  regression unless ruled.
- Multi-driver capable, single active (config). Fail-closed if the selected
  driver is missing or cannot connect — never silently fall back.
- Secrets stay in gitignored `.env*`; never in tracked files or logs.
- File limits 500 soft / 800 hard; `'use strict'`, 2-space, single quotes.
- Frames are immutable history; no data migration; persisted paths unchanged.
- Preserve the sibling session's uncommitted files.

## 4. Contracts

### 4.1 `DatabaseConnectionBase` and driver child classes

`DatabaseConnectionBase` is a `PluginInterface` subclass (loads via
`loadPlugins`, like agent providers, and is itself a plugin). Drivers extend it:

```
class DatabaseConnectionBase extends PluginInterface {
  static driverID = 'base'            # registry key (like AgentInterface.pluginID)
  static displayName / description
  static capabilities = { read, write, mergePatch, list, getMany, search, query, events, auth, ranges }
  static configFields = [...]         # connection config (url/host/user/db/...) exposed to operator
  static configKeys = [...]           # property-path keys this driver reads (see 4.5)
  constructor({ context, config, secrets })
  async connect()                     # open + verify; idempotent; throws on failure
  async close()
  // document-store methods (contract; semantics fixed, shape is the driver's)
  async put(path, body)
  async get(path)                     # object | null (404 -> null)
  async merge(path, patch)            # RFC-7386 merge-patch; capability mergePatch
  async delete(path)
  async list(prefix, { recursive, glob, limit, offset })   # { items:[{path}], total }
  entries(prefix, options)            # REQUIRED streaming -> AsyncIterable<{path}>
  async getMany(paths)                # { [path]: { content } }
  async batch(ops)                    # REQUIRED atomic multi-write (order + all-or-nothing)
  async search(query)                 # capability search (indexed)
  async query(where)                  # capability query (indexed)
  eventsURL?(params)                  # OPTIONAL capability (see 2.4 — no consumer)
  auth?()                             # capability auth -> AuthProvider (4.4)
}
```

**`list` semantics are a contract, not a convenience (verified).** Every call
site uses `{depth:-1, glob:'**/*.json'}` (recursive glob) with `limit`/`offset`
pagination and a `total`, returned **basename-sorted** (zero-padded frame
filenames ⇒ chronological). Frame-commit pagination and the tail-window anchor
depend on that stable order. A driver must reproduce recursive-glob + stable
ordering + total-count exactly, or the frame window regresses. `list` gets its
own spec section and is asserted in the shared harness.

**Streaming entries + scan-fallback (D2).** The generic fallback primitive is
`entries(prefix, options)` yielding `{path}` one at a time (never an array of a
whole table). `search()`/`query()` are the indexed fast paths; when a driver
lacks them, the shared search layer consumes `entries()` and applies matching +
locator/snippet construction incrementally. Note `entries()` is path-level, not
a filter predicate — the earlier `scan(predicate)` shape was wrong, because the
frame store's "scan" is really "list commit/frame paths in order," and AeorDB
has no generic predicate scan (only `listDirectory` + indexed `search`).

**Atomic batch (critical, from 2.2).** `batch(ops)` performs an ordered,
all-or-nothing multi-write so `saveCommit` (frames + commit + refs) is atomic on
every driver. **Verified:** AeorDB has no key/value multi-put or transaction
endpoint (`/files/copy` and permission writes are atomic, but not a generic
multi-document write). So `AeorDBConnection.batch` is **best-effort** (sequential
writes + flush, documented non-transactional); the frame-store composition layer
must tolerate that gap (it already has crash-recovery for orphan frames).
PostgreSQL/SQLite implement `batch` as a real transaction. This mismatch is
explicitly accepted and tested (a batch that fails midway must leave the frame
store recoverable, matching today's behavior).

Concrete drivers: `AeorDBConnection` (wraps `AeorDBClient` verbatim),
`PostgreSQLConnection`, `SQLiteConnection`. The base may provide shared helpers
(property-path resolution, `DatabaseError`, capability guards).

`DatabaseError { status, code, notFound }` replaces `AeorDBError` at the
boundary so callers keep 404-vs-failure without importing AeorDB. **It must
preserve `status` exactly:** several call sites key on `error.status === 404`
(scheduled-frame fallback, session listing, agent/team lookups); dropping it
silently changes those fallbacks to hard failures.

### 4.2 Registry + selection (plural-capable, single-active)

`PluginRegistry` gains, mirroring agent providers:
`registerDatabaseDriver(driverID, DriverClass)`, `getDatabaseDriver(driverID)`,
`getDatabaseDrivers()`, `listDatabaseDriverDescriptors()`.
Base class registered in core (`registerCoreClasses`) so it always exists.

- **Selection (single canonical source):** the property
  `/org/aeor/kikx/database/driver` → env `ORG_AEOR_KIKX_DATABASE_DRIVER` via
  `ConfigStore` (D7). A plain `KIKX_DATABASE_DRIVER` alias may be accepted during
  transition for convenience, but the property path is canonical; do **not** ship
  two independent mechanisms. Default when unset: the built-in `aeordb` driver.
- **Resolution order:** load plugins → resolve selected driver → `connect()` →
  set `db` context service (alias `aeordb` during transition) → build stores.
  `createServer()` becomes async to await config + `connect()`. The built-in
  AeorDB driver ships in core so a default boot never depends on user plugins.
- **Multi-driver:** the registry holds many; only the selected one is
  instantiated as the active `db` today. The design must not preclude multiple
  live connections later (e.g. per-session routing) — but that is out of scope.

### 4.3 Search + PostgreSQL parity

The search **contract** (2.2) is fixed. PostgreSQL must reproduce locator output.
Design (detailed pass in P3):

- **Storage:** a `documents` table `(path text primary key, content text, content_json
  jsonb, content_hash text, updated_at bigint, meta jsonb)`. Paths unchanged
  (Kikx paths are strings). `content` is the serialized document; `content_json`
  the parsed form for `where`.
- **Trigram:** `pg_trgm` GIN index on `content` (and/or a generated normalized
  column); `%` / `similarity()` for fuzzy.
- **Phonetic:** `fuzzystrmatch` (`dmetaphone`/`soundex`) over `unaccent`ed tokens;
  a generated `content_phonetic` column + functional GIN.
- **Locators:** `matched_text` + line/byte ranges computed from `strpos`/
  `position` over `content`, snippets via `substring`; line numbers by counting
  newlines before the offset. This reconstructs AeorDB's locator/fetch-hint shape.
- **Structured `where`:** map AeorDB's `{and|or|not:[{field,op,value}]}` to SQL
  predicates over `content_json`/`meta` (capability-gated; documented subset).
- **Fidelity risk:** exact byte offsets and `score` semantics will differ from
  AeorDB. The contract defines required *shape* + fetchability, not identical
  numerics. This divergence is stated and accepted (owner prioritizes working
  search over byte-identical scores).
- **Schema bootstrap (idempotent, privilege-safe):** on `connect()` the driver
  runs idempotent DDL: `CREATE TABLE IF NOT EXISTS documents (...)` +
  `CREATE EXTENSION IF NOT EXISTS pg_trgm|fuzzystrmatch|unaccent|btree_gin` +
  `CREATE INDEX IF NOT EXISTS`. Verified the non-superuser `kikx-dev` role owns
  the db and can install all four extensions. No migration framework in v1
  (fresh `kikx-dev`); a migration hook is roadmap item 4.
- **Frame-file ↔ row mapping:** each frame/commit/ref JSON document is one row
  keyed by its Kikx path (paths unchanged). The frame-store composition layer
  (2.2) sits above `documents` and keeps commit/ref/ordering semantics.

### 4.4 Auth (per-driver) + credentials

Auth is a **capability**, not a Kikx core concern (D1). The AeorDB driver's
`auth()` returns the AeorDB-backed provider (current behavior). SQL drivers
return null until a driver-specific provider exists.

Credentials/config are read from environment via the property-path loader (4.5),
never hardcoded. The AeorDB driver's `AeorDBClient` remains the auth source for
`aeordb`, so the "security-critical code is not registry-overridable" rule is
respected: auth for a driver is the driver's implementation, not an overridable
core class.

### 4.5 `ConfigStore` — async property accessor (D7 + D9, ratified)

**Owner (2026-10-05):** "Let's be SMART please and have all ENV var access go
through an `async` accessor method. This way, in the future, if we change WHERE
the environment variables come from, it won't be hard at all."

All environment/property access goes through a `ConfigStore` whose reads are
**async** (and internally memoizable), so the source can change later (`.env` →
`.json` → a remote config service → a DB row) without touching call sites:

```
class ConfigStore {
  constructor({ sources = [] })            # ordered providers, e.g. [processEnv, jsonEnvFile, defaults]
  async get(propertyPath)                  # -> value | undefined   (path like '/org/aeor/kikx/...')
  async getWithDefault(propertyPath, dflt)
  async require(propertyPath)              # throws a typed error when absent
  async getDriver(key)                     # convenience: driver property resolution
  async list(prefix)                       # enumerate keys under a path (for descriptors)
  static envKeyFor(propertyPath)           # '/org/.../x' -> 'ORG_..._X' (pure, sync, for tests)
}
```

- **Async by contract.** Reads are `await`ed even for the in-process provider so
  call sites never assume a synchronous source. The process-env provider may
  resolve on a microtask; future providers can do real I/O.
- **No direct `process.env`.** `src/` uses `ConfigStore`; a spec/grep-gate
  forbids raw `process.env` outside the config module. (Currently ~22 sites in
  `src/` — small, migrated in P0b.)
- **Bootstrap ripple (larger than it looks).** Async config reaches beyond
  `index.mjs` and `plugin-loader`: `create-server.mjs` reads **9** env vars and
  builds ~12 stores synchronously today, and `puppeteer-browser-service.mjs` reads
  **5**. Making config async means `createServer()` becomes `async` (or store
  construction is explicitly deferred and awaited at startup). This is the real
  structural change; the earlier "only real structural change" claim was wrong.
  Plan for `async createServer()` and an awaited startup phase.

### 4.6 Property / environment URI-path scheme (D7, ratified)

Per owner, key names are **derived from the property paths** — a `.json` env
document maps property paths to values, and the flattened `process.env` key is
the path with every `/` replaced by `_` (uppercase). Verbatim example:

```json
{
  "/org/aeor/kikx/database/driver": "/org/aeor/kikx/plugins/database/postgresql@0.4.5",
  "/org/aeor/kikx/database/config/hostname": "localhost:5432"
}
```

→ the plugin reads `process.env['ORG_AEOR_KIKX_DATABASE_CONFIG_HOSTNAME']`.

- **Canonical rule:** strip the leading/trailing `/`, then
  `key = propertyPath.replaceAll('/', '_').toUpperCase()` — i.e.
  `/org/aeor/kikx/...` -> `ORG_AEOR_KIKX_...` (the worked examples above show
  the stripped form; the raw `replaceAll` alone would yield a leading `_`).
  Non-alphanumeric beyond `/` is normalized to `_` (documented); `@version` is
  preserved in the *value* (the driver id), never in a key.
- **Driver id is itself a property path value:** `/org/aeor/kikx/database/driver`
  → a driver id like `/org/aeor/kikx/plugins/database/postgresql@0.4.5`. Selection
  reads this property (env `ORG_AEOR_KIKX_DATABASE_DRIVER`), not a bespoke
  `KIKX_DATABASE_DRIVER`, when the JSON env is the source; a plain env var may
  also set it directly.
- **Loader:** a config module reads `.env` (existing) and `.json` env documents
  (nested objects flattened to property-path keys), exposing
  `resolveProperty(path)` → value and `process.env[...]` population.
- **Precedence:** real `process.env` > json env file > default.
- **Scope:** shared config module with its own spec; used by drivers and dev
  launchers. `.json` env files are gitignored alongside `.env*`.

Confirmed: owner ruled **yes** to this scheme (not the earlier
`KIKX_DATABASE_<DRIVER>_<KEY>` proposal, which is superseded).

### 4.7 Compatibility
`AeorDBConnection` wraps `AeorDBClient` verbatim; client stays importable for
tests/tooling. No persisted format changes. `.env*` gitignored; `.env.example`
documents keys only.

## 5. Decisions

Recorded verbatim where given:

- **D1** (owner): per-driver auth; credentials from `.env`; introduce the
  property-path (`/org/.../`→`_`) scheme, possibly `.json` env files.
- **D3** (owner): PostgreSQL first; trigram + phonetic + fuzzy search required.
- **D5** (owner): pluralize the system (multi-driver capable, config-limited to
  one for now); installed plugins are trusted (signed plugins later).
- **D6** (owner): "I don't really care on the ordering. We need to build the
  entire system." → no phasing preference imposed by the owner.

Ratified by owner (2026-10-05):

- **D2** (owner): "for any database that doesn't support proper indexes, we will
  have to have scan-fallback (please implement in a _nice_ streaming fashion...
  no loading entire tables into memory please)." → Search is required where the
  backend supports indexes; **drivers without index support implement a
  streaming scan-fallback** (cursor/iterator; never materialize a whole table).
  The contract must expose scan as a streaming interface, not a big array.
- **D7** (owner): key names are derived from property paths (see 4.5). The
  `KIKX_DATABASE_<DRIVER>_<KEY>` proposal is **superseded**.
- **D8** (owner): "I understand that supporting this will be a challenge, and may
  not be identical across drivers. That is okay, as long as it is properly usable
  by bots." → Search parity bar = **shape + bot-usability**, not byte-identical
  offsets/scores.
- **D9** (owner): all env var access goes through an **async accessor method**
  (`ConfigStore.get()`), so the variable *source* can change later without
  touching call sites. See 4.5.
- **Dev database**: owner authorized wiping the old, test-data-only `kikx-dev`
  Postgres database and starting fresh. (It is currently empty; confirmed.)

Self-answered: drivers keyed by `driverID` like `AgentInterface.pluginID`; base
is itself a plugin; no data migration; paths unchanged; secrets in `.env*` only.

Feasibility confirmed (read-only probe + authorized dev DDL): the non-superuser
`kikx-dev` role owns the `kikx-dev` database and can install `pg_trgm`,
`fuzzystrmatch`, `unaccent`, `btree_gin` (all installed successfully). So the
trigram/phonetic/fuzzy search stack needs no elevated privileges.

## 6. Phases and ownership

One owner (coordinator); hotspots (`create-server.mjs`, `plugin-registry.mjs`,
`aeordb-frame-store-*`) serialized. Each phase independently green, one-unit
revertible.

- **P0 — Base + registry + contract specs (foundational).** `DatabaseConnectionBase`,
  `DatabaseError` (preserving `status`), capability model (`search`/`query`/
  `auth`/`ranges`; `events` optional), and the **required streaming `entries()`**
  plus **atomic `batch()`** contracts. Pin `list` semantics (recursive glob,
  stable basename order, total) and the frame-store atomicity/ordering spec (2.2)
  **before** P2. Registry methods + descriptors + spec. Register base in core.
  No store changes.
- **P0b — `ConfigStore` + property scheme (D7, D9).** Async property accessor
  (`get`/`require`/`list`) with ordered sources; property-path scheme
  (`/org/.../path` → `ORG_..._PATH`, `/`→`_` uppercase); `.env` + optional `.json`
  env documents; precedence `process.env > json > default`; `envKeyFor()` pure
  helper + spec. Migrate all ~22 `src/` `process.env` sites and the dev launchers
  to `ConfigStore`; make `index.mjs` an async `main()`; pass plugin paths into
  the loader. Add `.json` env files to `.gitignore`; document keys in
  `.env.example`. **Grep-gate:** no raw `process.env` in `src/` outside the
  config module.
- **P1 — AeorDB driver + wiring.** `AeorDBConnection` wrapping `AeorDBClient`
  (incl. best-effort `batch`, streaming `entries` over `listDirectory`); make
  `createServer()` async; resolve the driver after plugin load; selection via the
  canonical property path (default `aeordb`); set `db` + alias. **Gate:** dev
  boots via the plugin-resolved driver; `/health` ready.
- **P2 — Repoint stores to `db`.** Swap `aeordb`→`db` across stores and
  `create-server`; align method names; introduce the frame-store composition layer
  (2.2) if not already in P1. **Gate: full core + provider suites green (749+),
  zero behavior change.**
- **P3 — Isolate AeorDB coupling.** Index configs into the driver; `AuthProvider`
  boundary; capability-gate `search`/`query`/`events`; parity ledger.
- **P4 — PostgreSQL driver.** Connection + document store + search (trigram,
  phonetic, fuzzy) per 4.3; dedicated search design pass; shared driver harness.
  Gate: store + search contracts pass against Postgres.
- **P5 — SQLite driver (optional).** Scan-fallback search; same harness.
- **P6 — First-class selection + docs.** Config surface listing drivers; switching
  docs; `.env.example` keys.

## 7. Verification spine

- **Parity (P2, critical):** full suite green against `AeorDBConnection` — a
  refactor, so any diff is a regression unless ruled. Pairwise family oracle:
  same store method ⇒ same driver call.
- **Shared driver harness (P4+):** one parametrized suite per driver asserting
  the contract (put/get/merge/delete/list/getMany; capability behavior; malformed
  input; 404-vs-failure; concurrency/ordering).
- **Search parity:** run `DatabaseSearchTool`/`SessionSearchTool` fixtures against
  each search-capable driver; assert locator **shape** + that `database-fetch`
  round-trips each locator; allow numeric score/offset differences (D8).
- **Streaming scan bound (D2):** prove the scan-fallback never materializes a
  whole table — assert bounded peak memory / bounded in-flight buffer over a
  large synthetic table (e.g. 100k rows), and that results stream incrementally.
- **ConfigStore:** table of property-path→env-key→resolved-value; source
  precedence; `require()` throws typed error when absent; `list(prefix)`;
  malformed JSON env; **async contract** honored (awaited even for the
  process-env source). `envKeyFor()` pure-function table tests.
- **Grep-gate:** raw `process.env` absent from `src/` except the config module.
- **Real end-to-end:** boot dev on AeorDB driver; later boot on Postgres; create
  a session, post a message, confirm frames persist and reload; run a search.
- **Grep-gates:** no `new AeorDBClient` outside the AeorDB driver + auth adapter;
  no store imports `AeorDBError`; `aeordb` key only as alias during P2; secrets
  never in tracked files.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Behavior drift during the "no-op" refactor | Parity gate first; thin wrapper; ledger |
| Bootstrap order (stores need DB; drivers are plugins) | P1 reorders resolution; AeorDB driver built into core |
| Postgres cannot match byte/line locators cheaply | Storage `content` text + `strpos` locators; accept score/offset divergence (D8) |
| `where` clause not portable | Capability-gated documented subset |
| Multiple drivers complicate boot | Registry plural; only selected instantiated; fail-closed |
| Property-path scheme churns | Lock naming (D7) before drivers depend on it |
| Async config breaks synchronous module-init reads | `index.mjs` → async `main()`; plugin-loader takes paths as input; only a few sites |
| Raw `process.env` re-introduced later | grep-gate forbids it outside the config module |
| Driver plugin sees all data/creds | Document as trusted install (owner ruling D5); signed plugins later |
| Frame store loses atomicity/ordering | Atomic `batch()` (best-effort on AeorDB) + frame-store composition layer; spec'd before P2 |
| `list` glob/order/total not reproduced | Spec `list` semantics; assert recursive glob + basename order + total in harness |
| Auth coupling in AccountStore | Documented auth boundary / auth-aware account layer (2.5) |
| Dead SSE capability over-constrains drivers | `events` optional; drop if 2.4 confirms no consumer |
| Sibling session's uncommitted files | Touch only plan/driver files; re-check tree before each commit |
| Prod down (AeorDB latched) | Separate track; owner decides recovery/repair |
| Secrets exposure | `.env*` gitignored; never log/write creds to tracked files |

## 9. Roadmap (dependency-ordered, out of current scope)

1. AeorDB stability refactor (owner) — the reason to return.
2. Signed-plugin trust + plugin repository + install/remove (owner has designs).
3. Multiple live connections / per-session backend routing (when needed).
4. Driver-level schema versioning/migrations if backends diverge.

## 10. Open items

- **D2, D7, D8, D9 are ratified** (see §5). Earlier "rulings needed" text here
  was stale; corrected.
- **Verify before P3/P4:** the SSE consumer (2.4) and the AccountStore auth
  boundary (2.5). If SSE is unused, drop `events` from the required contract.
- **Pin before P2:** frame-store atomicity/ordering specs (2.2) and `list`
  semantics. P2's parity gate is only meaningful once these are spec'd.
- Postgres search design detail (4.3) expands into its own section/spec in P4.
- Prod recovery is a **separate** decision; Kikx prod is currently down because
  AeorDB is read-only-latched — see incident notes, not this plan.

## 11. Adversarial review notes (2026-10-05)

Gaps found by re-reading against the code and folded in above:
1. Frame store ≠ document store; needs atomic `batch` + a frame-store composition
   layer (2.2, 4.1). **Was absent.**
2. `list` recursive-glob/ordering/total is a real contract (4.1). **Was a
   one-liner.**
3. `scan(predicate)` was the wrong primitive → `entries()` streaming (4.1). **Was
   mis-specified.**
4. SSE/events possibly vestigial → capability-gate pending verification (2.4).
5. Auth is woven into AccountStore document I/O → documented boundary (2.5).
6. Async config ripple is broader than claimed (createServer async) (4.5). **Was
   understated / a false "only real change" claim.**
7. Two selection mechanisms → one canonical property path (4.2).
8. No schema/bootstrap story → idempotent, privilege-safe DDL (4.3).
9. `DatabaseError` must preserve `status`/404 behavior for existing fallbacks
   (4.7).
