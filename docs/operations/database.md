> **Current v3 documentation.** This page describes the unreleased third development revision. Source behavior wins if this page and the implementation differ.
>
> **Last verified:** 2026-10-27

# Database operations

Kikx is driver-based. PostgreSQL is the configured operational primary for current development and deployment, while AeorDB remains a legacy driver and a future target when it is sufficiently stable. Application documentation therefore says **the database** except when a backend-specific procedure requires a name.

## Select and verify a driver

Set `org.aeor.kikx.database.driver` to a registered driver ID and configure that driver's connection property. Current deployments should select `postgresql` and provide `org.aeor.kikx.database.url` through the deployment's secret/configuration mechanism.

There is an important transitional discrepancy: the low-level source fallback is still `aeordb` when no driver is configured. Do not rely on that fallback. Make the driver explicit in every operated environment and verify the startup logs and `/health` result.

Changing the driver setting does **not** copy data. It selects a different backend on the next composition.

## Safety rules

- Keep credentials out of documentation, shell history, source control, bug reports, and copied logs.
- Use a dedicated role and database for Kikx.
- Use separate databases for development, UI automation, migration rehearsal, and deployed environments.
- Treat integration and UI test database URLs as disposable. The test helpers can create, truncate, or otherwise mutate documents and tables.
- Back up and restore using the selected backend's supported operational tooling. This repository does not implement a universal backup format.
- Confirm the target URL and environment before running a migration or full test lane.

## AeorDB to PostgreSQL migration utility

`scripts/migrate-database.mjs` is a one-way, backend-specific transition utility. It is not a general driver migration framework. It reads user documents from AeorDB and writes them to PostgreSQL, excluding AeorDB internal paths. Its operational features include:

- dry-run and verification modes;
- a manifest, stored in the operating-system temporary directory by default;
- content hashes and sizes used to verify copied documents;
- resumable state and bounded concurrency;
- retry controls and an optional document limit for testing; and
- progress/error reporting without intentionally printing credential values.

Review `node scripts/migrate-database.mjs --help` immediately before use. Rehearse against isolated copies, retain the manifest with the migration record, verify the destination, and do not switch the application until acceptance checks pass. The utility consumes live connection settings, so running it is an operational change requiring explicit authorization.

The following are legacy AeorDB-only helpers and must not be used as generic PostgreSQL verification:

- `scripts/verify-scheduled-frames.mjs`
- `scripts/with-aeordb-token.mjs`
- the `start:aeordb*` package scripts
- AeorDB branches in `scripts/start-dev.mjs` and `scripts/start-kikx-dev.mjs`

## Data ownership and recovery

The database contains durable frames, authentication records, teams, durable process state, tags, and derived indexes. Files below `data/` provide application-managed assets such as the native mailer log and plugin data, not a complete database backup. See the storage reference before designing retention or recovery procedures.

Because some views and indexes are derived from durable frames, an operator must preserve source frames and use backend-appropriate consistency tooling. Never delete an apparently redundant path without checking the store implementation for the selected driver.

## Post-change checks

1. Start Kikx and wait for `/health` to report `ready: true`.
2. Authenticate through the normal Kikx flow.
3. List and open a known session.
4. Create a disposable session and verify a message survives a controlled restart.
5. Exercise any installed plugin whose provider or store uses the database.
6. Inspect logs for recovery, scheduled-frame, question-repair, and connection errors.

## Sources of truth

- `src/core/database/database-driver-selection.mjs`
- `src/core/plugins/plugin-registry.mjs`
- `src/core/plugins/core-classes.mjs`
- `src/core/database/postgresql-connection.mjs`
- `src/core/aeordb/aeordb-connection.mjs`
- `src/server/create-server.mjs`
- `scripts/migrate-database.mjs`
- `scripts/verify-scheduled-frames.mjs`
- `spec/core/database/postgresql-connection-spec.mjs`

## Related

- [Database driver reference](../reference/database-drivers.md)
- [Storage reference](../reference/storage.md)
- [Configuration reference](../reference/configuration.md)
- [Testing guide](../guides/testing.md)
- [Runtime lifecycle](runtime-lifecycle.md)
- [Deployment boundary](deployment.md)
