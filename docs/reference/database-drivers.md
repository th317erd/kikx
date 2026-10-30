# Database driver reference

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against the database interfaces, built-in drivers, plugin registry, and server bootstrap.

Kikx persists durable state through one active database driver. Store and runtime code depend on the document contract rather than a particular product. PostgreSQL is the configured primary for current development and deployment. AeorDB remains available as a legacy compatibility driver because the project may return to it after it stabilizes; SQLite is available for lightweight and test use.

There is an important distinction between operations and source defaults:

- Current environments explicitly select `postgresql`.
- If no driver is configured, the current source fallback is still `aeordb` for compatibility.
- Documentation outside backend-specific reference and operations pages should normally say **the database**, not name a driver.

Exactly one driver is instantiated and connected per server process.

## Driver contract

Every driver extends `DatabaseConnectionBase`, which itself extends `PluginInterface`. A driver declares:

- `driverID`, `displayName`, and `description`;
- capability flags;
- UI-facing `configFields` and property-path `configKeys`;
- `batchAtomicity`, either `atomic` or `best-effort`.

Required document operations are:

- `connect()` and `close()`;
- `put(path, body, options)` and `get(path, options)`;
- `merge(path, patch)` using JSON Merge Patch semantics;
- `delete(path)`;
- `list(prefix, options)` and streaming `entries(prefix, options)`;
- `getMany(paths)`;
- `batch(operations)`.

Optional operations are capability-gated:

- `search(request)`;
- `query(request)`;
- `getRanges(items, options)`;
- `eventsURL(params)`;
- backend-provided `auth()` or `withToken()`.

The base class also exposes historical file-verb adapters such as `getFile`, `putFile`, `patchFile`, `deleteFile`, `listDirectory`, `fetchFiles`, `fetchFileRanges`, `searchFiles`, and `queryFiles`. These preserve older store call sites while implementations use the modern document methods.

`get()` returns `null` for a missing document. The compatibility `getFile()` adapter turns that into a typed not-found error. Unsupported optional operations throw a `DatabaseError` with code `capability_unsupported`.

## Selection and discovery

Driver selection resolves in this order:

1. `/org/aeor/kikx/database/driver` → `ORG_AEOR_KIKX_DATABASE_DRIVER`;
2. `/kikx/database/driver` → `KIKX_DATABASE_DRIVER`, a transition alias;
3. source compatibility fallback → `aeordb`.

A value can be a bare driver ID or a plugin property path whose final segment names a registered driver, for example `/org/aeor/kikx/plugins/database/postgresql@0.4.5`. An unknown driver fails startup with `database_driver_unknown`; Kikx does not silently choose another driver.

Built-in drivers are registered during core bootstrap. Plugins may register more with `registerDatabaseDriver`. `GET /api/v1/database-drivers` returns installed driver descriptors and the active driver ID without opening new connections.

## Capability matrix

| Capability | PostgreSQL | SQLite | AeorDB |
| --- | :---: | :---: | :---: |
| read | yes | yes | yes |
| write | yes | yes | yes |
| merge patch | yes | yes | yes |
| list and streaming entries | yes | yes | yes |
| multi-get | yes | yes | yes |
| search | yes | yes | yes |
| structured query | yes | yes | yes |
| ranged fetch | yes | yes | yes |
| backend events | no | no | yes |
| backend auth | no | no | yes |
| atomic batch | yes | yes | no; best effort |

The `auth` row describes a driver-provided backend capability. It does **not** describe Kikx authentication. Kikx-native users, magic links, sessions, and API keys are document-backed and work independently of that flag.

Kikx has its own runtime event stream at `/api/v1/events`; the AeorDB event URL is a legacy backend-specific seam and is not required by the browser client.

## PostgreSQL

PostgreSQL is the current operational primary. The driver lazily imports `pg`, creates an idempotent `documents` table on connection, and stores:

- a unique text `path`;
- text `body`;
- a `raw` flag;
- millisecond `updated_at` metadata.

Path scans use byte-ordered `C` collation so prefix bounds and streaming order remain deterministic. Search attempts to install or use `pg_trgm` for similarity scoring; failure to enable it is non-fatal because exact search and locator results still work. Batches use real transactions.

Configuration:

```text
ORG_AEOR_KIKX_DATABASE_DRIVER=postgresql
ORG_AEOR_KIKX_DATABASE_URL=<PostgreSQL connection URL>
```

The URL transition alias is `KIKX_DATABASE_URL`. Host, port, database, user, password, and SSL fields are exposed in the driver descriptor; password is marked secret.

## SQLite

SQLite uses Node's bundled `node:sqlite` module and imports it only when selected. It defaults to an in-memory database if no location is configured. Batches are transactional. Search and structured-query behavior use local scans, and ranged fetches are implemented over stored documents; these are contract-compatible capabilities, not a claim that SQLite has PostgreSQL-style indexes.

Configuration:

```text
ORG_AEOR_KIKX_DATABASE_DRIVER=sqlite
ORG_AEOR_KIKX_DATABASE_PATH=<SQLite file path or sqlite: URL>
```

The path transition alias is `KIKX_DATABASE_PATH`.

## AeorDB compatibility driver

AeorDB wraps the historical client and preserves its URL/token configuration. It remains in source for compatibility and a possible future return, but it is not the current operational primary.

Configuration:

```text
ORG_AEOR_KIKX_DATABASE_DRIVER=aeordb
AEORDB_URL=<AeorDB base URL>
AEORDB_TOKEN=<token supplied outside source control>
```

Its batch implementation is sequential and best-effort because the backend has no generic multi-document transaction. A mid-batch failure can leave partial writes. Frame persistence has recovery behavior for orphaned work, but callers must not mistake that for general transactionality.

## Adding a driver

A plugin driver must extend `DatabaseConnectionBase`, implement the required document operations, advertise only operations it actually supports, and register with a unique ID. Run the shared contract harness against it; see [Plugin authoring](../guides/plugin-authoring.md) and [Testing](../guides/testing.md).

## Sources of truth

- `src/core/database/database-connection-base.mjs`
- `src/core/database/database-driver-selection.mjs`
- `src/core/database/postgresql-connection.mjs`
- `src/core/database/sqlite-connection.mjs`
- `src/core/aeordb/aeordb-connection.mjs`
- `src/core/plugins/core-classes.mjs`
- `src/server/create-server.mjs`
- `src/server/routes/database-routes.mjs`

## Related

- [Storage model and paths](storage.md)
- [Configuration reference](configuration.md)
- [Database operations](../operations/database.md)
- [Plugin system reference](plugins.md)
