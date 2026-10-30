# Storage model and document paths

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against the stores, frame runtime, and database interfaces.

The database is a durable document store, not the message renderer. Kikx uses stable slash-delimited logical paths across drivers, allowing the active backend to change without changing domain stores or persisted document identities.

## Frame storage and projection

Conversation state follows this path:

1. Raw frames are read from the configured database driver.
2. `FrameRuntime` hydrates a process-local `FrameEngine` for the session.
3. The shared `FrameManager` projects raw frames into coherent messages.
4. The server, browser client, counts, and agent context builders consume that projection.

Raw frames remain authoritative for durable history, debugging, search, recovery, and replay. Tool calls and results, user and agent messages, command results, lifecycle records, and compaction records are persisted. Phantom streaming frames are transient runtime/SSE data and are not durable history.

The normal root is `/kikx`. Major document families include sessions and their frames, agents, teams, tags, accounts and auth records, token usage, tool outputs, feedback, questions and derived indexes, process records, per-agent working directories, and other runtime metadata.

## Documents versus derived indexes

Primary entity documents are truth. Several stores maintain derived index documents for efficient reads. A missing or stale derived index must not be described as loss of the underlying documents. The question store, for example, can rebuild its open-question and per-agent indexes from individual question documents, and startup performs a best-effort repair before readiness becomes true.

## Raw and structured values

Drivers support structured JSON documents and, where requested, raw text. The database layer normalizes paths and provides consistent result envelopes. PostgreSQL stores bodies as text so raw and structured documents share one table; non-raw bodies are serialized and parsed by the driver.

## Compatibility names

The canonical service name in `AppContext` is `db`. The server currently mirrors the same instance under `aeordb` because older stores, tests, and hosts still refer to that name. This alias does not mean AeorDB is active. New code and documentation should prefer `db` or “the database.”

The `src/core/aeordb/` directory also contains the historical frame-store implementation and compatibility names. Backend-neutral behavior is selected and injected through the active driver even where an internal field retains an older name.

## Filesystem paths are not database paths

Document paths such as `/kikx/sessions/...` are logical database keys. They are not host filesystem paths. Only the SQLite driver maps the database itself to a configured file. PostgreSQL uses a connection URL, and the AeorDB compatibility driver uses its own server URL.

Never edit backend storage files directly. Use the driver contract, a store, or an explicitly documented migration/repair tool.

## Sources of truth

- `src/core/database/document-utils.mjs`
- `src/core/aeordb/frame-store.mjs`
- `src/core/runtime/frame-runtime.mjs`
- `src/shared/frame-manager/frame-manager.mjs`
- `src/server/create-server.mjs`
- `src/core/questions/questions-store.mjs`

## Related

- [Database driver reference](database-drivers.md)
- [Database operations](../operations/database.md)
- [Architecture](../architecture/README.md)
- [Context compaction](../architecture/context-compaction.md)
