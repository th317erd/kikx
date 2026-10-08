# Kikx database drivers

Kikx stores every durable document (sessions, frames, agents, accounts, token
usage, tool output, …) through one pluggable database driver. This document
covers how to select a driver, how to configure each built-in, and what differs
between them. It is the operator-facing companion to the design plan at
[`plans/kikx-database-driver-layer.md`](plans/kikx-database-driver-layer.md).

## Purpose

The driver layer lets Kikx run on AeorDB (the default), PostgreSQL, or SQLite
without touching store code. It exists because AeorDB latched a read-only
durability-failure state in production; the layer allows running on PostgreSQL
now and returning to AeorDB later with a config change rather than a rewrite.
The layer is multi-driver capable but functionally single-active: exactly one
driver is instantiated and connected per server process.

## The driver contract

`DatabaseConnectionBase` is itself a plugin; each concrete driver is a child
class (`AeorDBConnection`, `PostgreSQLConnection`, `SQLiteConnection`) registered
in `PluginRegistry` under a `driverID`. Drivers implement the modern document
methods (`put`/`get`/`merge`/`delete`/`list`/`entries` streaming/`getMany`/atomic
`batch`) and declare static metadata — `driverID`, `displayName`, `description`,
`capabilities`, `configFields`, `configKeys`, and `batchAtomicity`. Optional
surfaces (indexed `search`, structured `query`, `getRanges`, `eventsURL`, `auth`)
are capability-gated: a driver is never asked to perform an operation it does not
advertise. The base class supplies the historical file-verb adapters
(`getFile`/`putFile`/`patchFile`/`listDirectory`/…) that the existing stores call,
so no store changes are required to add a backend.

## Selecting a driver

The built-ins are registered in core at `registerCoreClasses`, so a default
boot always has a driver available. Selection reads, in order:

1. `/org/aeor/kikx/database/driver` → `ORG_AEOR_KIKX_DATABASE_DRIVER` (canonical).
2. `/kikx/database/driver` → `KIKX_DATABASE_DRIVER` (transition alias).
3. Default: `aeordb`.

The value may be a bare driver ID (`aeordb`, `sqlite`, `postgresql`) or a plugin
property-path value such as `/org/aeor/kikx/plugins/database/postgresql@0.4.5`;
the latter resolves to the driver ID registered by that plugin. An unknown value
**fails closed** at boot with `database_driver_unknown` — there is no silent
fallback. The resolved driver is recorded in the server context as
`databaseDriverID` and exposed by the read-only `GET /api/v1/database-drivers`
route:

```json
{
  "data": {
    "drivers": [ { "driverID": "aeordb", "capabilities": {}, "configFields": [], "configKeys": [] } ],
    "active": "aeordb"
  }
}
```

`drivers` lists every installed driver's static descriptor (no connection
required); `active` is the driver this server resolved.

Location is chosen separately from the driver, so one can switch driver without
renaming keys:

| Property path                        | Environment variable              | Used by      |
| ------------------------------------ | --------------------------------- | ------------ |
| `/org/aeor/kikx/database/driver`     | `ORG_AEOR_KIKX_DATABASE_DRIVER`    | all drivers  |
| `/kikx/database/driver` (alias)      | `KIKX_DATABASE_DRIVER`            | all drivers  |
| `/org/aeor/kikx/database/path`       | `ORG_AEOR_KIKX_DATABASE_PATH`     | sqlite       |
| `/kikx/database/path` (alias)        | `KIKX_DATABASE_PATH`              | sqlite       |
| `/org/aeor/kikx/database/url`        | `ORG_AEOR_KIKX_DATABASE_URL`      | postgresql   |
| `/kikx/database/url` (alias)         | `KIKX_DATABASE_URL`               | postgresql   |
| `/aeordb/url`                        | `AEORDB_URL`                      | aeordb       |
| `/aeordb/token`                      | `AEORDB_TOKEN`                    | aeordb       |

The property-path → environment-variable rule is: strip the leading/trailing
`/`, replace every `/` (and other non-alphanumeric run) with `_`, and uppercase.
`.env.example` documents the same mapping. Secrets live only in gitignored
`.env*`; never in tracked files.

## Per-driver configuration

### AeorDB (default)

Wraps the existing `AeorDBClient` verbatim; no behavior change from the
pre-driver Kikx. Keys are the historical ones, unchanged:

```sh
ORG_AEOR_KIKX_DATABASE_DRIVER=aeordb
AEORDB_URL=http://127.0.0.1:6830
AEORDB_TOKEN=
```

`connect()` only flips connection state — it does not ping — so a default boot
adds no HTTP request and fails closed only when a store actually talks to
AeorDB.

### SQLite

Backed by Node's bundled `node:sqlite` (`DatabaseSync`), imported lazily so an
AeorDB/PostgreSQL boot never loads the experimental module. The filename
defaults to `:memory:` (ephemeral).

```sh
ORG_AEOR_KIKX_DATABASE_DRIVER=sqlite
ORG_AEOR_KIKX_DATABASE_PATH=./.kikx/kikx.sqlite
```

### PostgreSQL

Backed by the optional `pg` package, imported lazily inside `connect()`, so
registering the driver never requires the dependency and an AeorDB boot with
`pg` absent is unaffected. On `connect()` the driver runs idempotent DDL for a
`documents` table and attempts to install `pg_trgm` for a similarity score
(failure is non-fatal: search still works, just without the trigram score).

```sh
ORG_AEOR_KIKX_DATABASE_DRIVER=postgresql
ORG_AEOR_KIKX_DATABASE_URL=postgres://kikx-dev@127.0.0.1:5434/kikx-dev
```

> **Ports on this host (2026-10-08):** the development database `kikx-dev` lives
> on the host's PostgreSQL 16 cluster, which moved to **5434**; the production
> cluster (bundled PG17, data under `${KIKX_HOME}/.local/share/kikx/postgres`) is
> on **5433**; **5432** is now an SSH tunnel for an unrelated database. The port
> above is therefore host-specific — adjust it for your own setup.

## Capability matrix

| Capability   | aeordb | postgresql | sqlite |
| ------------ | :----: | :--------: | :----: |
| read         |   ✅   |     ✅     |   ✅   |
| write        |   ✅   |     ✅     |   ✅   |
| search       |   ✅   |     ✅     |   ❌   |
| query        |   ✅   |     ✅     |   ❌   |
| ranges       |   ✅   |     ✅     |   ❌   |
| events       |   ✅   |     ❌     |   ❌   |
| auth         |   ✅   |     ❌     |   ❌   |
| atomic batch |   ❌¹  |     ✅     |   ✅   |

¹ AeorDB has no generic multi-document transaction endpoint, so `batch()` is
sequential and best-effort (declared `batchAtomicity: 'best-effort'`). The
frame-store layer already tolerates orphan frames on crash and recovers them,
matching pre-driver behavior. PostgreSQL and SQLite implement `batch()` as a
real all-or-nothing transaction.

`events` is currently vestigial (Kikx has its own `/api/v1/events` SSE and the
AeorDB `eventsURL` has no consumer); it is retained as an optional capability.

## PostgreSQL private test cluster

Kikx tests use a throwaway PostgreSQL cluster owned by the developer, listening
on IPv6 loopback `[::1]:55432`. IPv6 is deliberate: `127.0.0.1:55432` may be an
SSH tunnel. Tests read the URL from `KIKX_TEST_PG_URL` and fall back to
`postgres://postgres@[::1]:55432/postgres`. PostgreSQL-specific tests skip when
the cluster is unreachable.

One-time setup (PostgreSQL 16 on Ubuntu; adjust the version path):

```sh
PGBIN=/usr/lib/postgresql/16/bin
DATADIR=/tmp/pi/kikx/pgdata
PGSOCK=/tmp/pi/kikx

# Initialize a trust-auth cluster (local/127.0.0.1/::1 are trusted).
"$PGBIN/initdb" -D "$DATADIR" -A trust -U postgres

# Start it on the IPv6 loopback with a local Unix socket.
"$PGBIN/pg_ctl" -D "$DATADIR" -l "$PGSOCK/pg.log" \
  -o "-p 55432 -k $PGSOCK -c listen_addresses=::1" start

# Create the dev database if needed.
psql -h ::1 -p 55432 -U postgres -c 'CREATE DATABASE "kikx-dev"'

# Point tests at it (optional; defaults already match).
export KIKX_TEST_PG_URL=postgres://postgres@[::1]:55432/postgres
```

Stop it with `"$PGBIN/pg_ctl" -D "$DATADIR" stop`. The cluster is disposable test
infrastructure under `/tmp`; it is not production and needs no backup.

## Known parity limitations

- **PostgreSQL search score and CRLF char offsets.** Score semantics are
  driver-local (`score: 1` for substring matches) and are not byte-identical to
  AeorDB's. Line/column/char offsets are computed in JS with CRLF counted as one
  line break, matching stored-file semantics; exotic code points whose lowercase
  form changes length can skew offsets. Per owner ruling D8, the search contract
  is shape + bot-usability, not identical numerics.
- **SQLite has no `search`, `query`, `ranges`, or `auth`, and no scan-fallback
  search yet.** Capability probes correctly report these as absent. A streaming
  `entries()` scan-fallback search (D2) is deferred; SQLite is usable for
  document storage but not for Kikx search tools.
- **AeorDB `batch()` is best-effort.** Multi-document writes are sequential and
  non-transactional; a mid-batch failure can leave partial writes. The frame
  store's crash-recovery for orphan frames covers this (unchanged from before
  the driver layer).

## Reversing to AeorDB

Set the driver back and restart the server — no data migration and no persisted
path changes are involved:

```sh
ORG_AEOR_KIKX_DATABASE_DRIVER=aeordb
# ...or simply unset it; aeordb is the default.
```

The `aeordb` driver keeps its own `AEORDB_URL`/`AEORDB_TOKEN` keys, so removing
the database section entirely restores the original configuration. Because the
canonical property path resolves before the `/kikx/...` alias, either key may be
used during the transition; prefer the canonical `/org/aeor/kikx/...` form.
