# Configuration reference

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against the configuration providers, property paths, loaders, and server bootstrap.

Kikx configuration is addressed by normalized property paths and read asynchronously through `ConfigStore`. Environment names are derived from paths by stripping outer slashes, replacing non-alphanumeric runs with underscores, and uppercasing.

For example, `/org/aeor/kikx/database/driver` maps to `ORG_AEOR_KIKX_DATABASE_DRIVER`.

## Precedence

The standard store resolves the first defined value in this order:

1. process environment;
2. optional flattened JSON environment file;
3. caller-provided additional providers, in order;
4. defaults.

The `.env` and JSON loaders used by development scripts are additive: they fill absent keys and never overwrite values already present in the process environment. A missing file is tolerated; malformed JSON is a configuration error.

`ConfigStore.list()` can enumerate only providers that implement `entries()`. Process environment keys cannot be reversed reliably, so known keys must be read with `get()`, `require()`, or `resolveAll()`.

## Server and workspace

| Property path | Environment name | Runtime default |
| --- | --- | --- |
| `/kikx/host` | `KIKX_HOST` | `127.0.0.1` |
| `/kikx/port` | `KIKX_PORT` | `3000` |
| `/kikx/cwd` | `KIKX_CWD` | service user's home directory |
| `/kikx/plugin/paths` | `KIKX_PLUGIN_PATHS` | bundled plugin root only |
| `/aeor/web/components/dir` | `AEOR_WEB_COMPONENTS_DIR` | development checkout path compiled into server bootstrap |

`KIKX_CWD` is the base for agent session directories and local file/command services. It does not default to the directory from which the server was launched.

## Database selection and location

| Property path | Environment name | Use |
| --- | --- | --- |
| `/org/aeor/kikx/database/driver` | `ORG_AEOR_KIKX_DATABASE_DRIVER` | canonical driver selection |
| `/kikx/database/driver` | `KIKX_DATABASE_DRIVER` | transition alias |
| `/org/aeor/kikx/database/url` | `ORG_AEOR_KIKX_DATABASE_URL` | network database URL |
| `/kikx/database/url` | `KIKX_DATABASE_URL` | transition alias |
| `/org/aeor/kikx/database/path` | `ORG_AEOR_KIKX_DATABASE_PATH` | file-backed database location |
| `/kikx/database/path` | `KIKX_DATABASE_PATH` | transition alias |
| `/aeordb/url` | `AEORDB_URL` | legacy driver URL |
| `/aeordb/token` | `AEORDB_TOKEN` | legacy driver token |

Current environments explicitly select PostgreSQL. The source fallback for an unset driver remains AeorDB for compatibility.

## Agent context and compaction

| Property path | Environment name | Runtime default |
| --- | --- | --- |
| `/kikx/context/window/tokens` | `KIKX_CONTEXT_WINDOW_TOKENS` | 128000 |
| `/kikx/compaction/agent/id` | `KIKX_COMPACTION_AGENT_ID` | selected by runtime/tag rules when absent |
| `/kikx/compaction/agent/context/tokens` | `KIKX_COMPACTION_AGENT_CONTEXT_TOKENS` | 128000 |
| `/kikx/context/prompt/reserve/tokens` | `KIKX_CONTEXT_PROMPT_RESERVE_TOKENS` | 8000 |
| `/kikx/compaction/trigger/ratio` | `KIKX_COMPACTION_TRIGGER_RATIO` | 0.7 |
| `/kikx/compaction/hard/ratio` | `KIKX_COMPACTION_HARD_RATIO` | 1.0 |

Positive-integer and ratio values are parsed and normalized during server composition.

## Native authentication and mail

| Property path | Environment name | Runtime default |
| --- | --- | --- |
| `/kikx/admin/email` | `KIKX_ADMIN_EMAIL` | none |
| `/kikx/admin/name` | `KIKX_ADMIN_NAME` | empty |
| `/kikx/auth/public/url` | `KIKX_AUTH_PUBLIC_URL` | empty |
| `/kikx/auth/mailer/mode` | `KIKX_AUTH_MAILER_MODE` | `log` |
| `/kikx/auth/mailer/log/path` | `KIKX_AUTH_MAILER_LOG_PATH` | mailer-defined |
| `/kikx/auth/mailer/smtp/url` | `KIKX_AUTH_MAILER_SMTP_URL` | none |
| `/kikx/auth/mailer/from` | `KIKX_AUTH_MAILER_FROM` | `Kikx <no-reply@localhost>` |
| `/kikx/auth/session/access/ttl/seconds` | `KIKX_AUTH_SESSION_ACCESS_TTL_SECONDS` | 3600 |
| `/kikx/auth/session/refresh/ttl/seconds` | `KIKX_AUTH_SESSION_REFRESH_TTL_SECONDS` | 2592000 |
| `/kikx/auth/magic/link/ttl/seconds` | `KIKX_AUTH_MAGIC_LINK_TTL_SECONDS` | 900 |

Do not commit real connection strings, tokens, root keys, API keys, or SMTP credentials.

## Memory monitoring

Monitoring is off unless explicitly enabled.

| Property path | Environment name | Runtime default |
| --- | --- | --- |
| `/kikx/monitoring/memory/enabled` | `KIKX_MONITORING_MEMORY_ENABLED` | false |
| `/kikx/monitoring/memory/interval/seconds` | `KIKX_MONITORING_MEMORY_INTERVAL_SECONDS` | 30 |
| `/kikx/monitoring/memory/samples` | `KIKX_MONITORING_MEMORY_SAMPLES` | 120 |
| `/kikx/monitoring/memory/growth/threshold/mb` | `KIKX_MONITORING_MEMORY_GROWTH_THRESHOLD_MB` | 64; zero disables warning |
| `/kikx/monitoring/memory/growth/window/samples` | `KIKX_MONITORING_MEMORY_GROWTH_WINDOW_SAMPLES` | 20 |

## Sources of truth

- `src/core/config/config-paths.mjs`
- `src/core/config/config-store.mjs`
- `src/core/config/config-providers.mjs`
- `src/core/config/env-loader.mjs`
- `src/core/config/property-path.mjs`
- `src/server/create-server.mjs`
- `src/server/index.mjs`

## Related

- [Development setup](../guides/development.md)
- [Authentication reference](authentication.md)
- [Database driver reference](database-drivers.md)
- [Runtime lifecycle](../operations/runtime-lifecycle.md)
