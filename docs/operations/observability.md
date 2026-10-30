> **Current v3 documentation.** This page describes the unreleased third development revision. Source behavior wins if this page and the implementation differ.
>
> **Last verified:** 2026-10-27

# Observability

Kikx currently exposes lightweight HTTP probes, structured runtime state, server logs, and durable tool/process records. It does not claim a built-in metrics exporter, distributed tracing system, or log aggregation service. Deployment-level collection belongs outside this repository.

## Probe surfaces

| Surface | Purpose | Access note |
| --- | --- | --- |
| `GET /health` | Liveness-shaped response plus startup readiness, database registration, and compact memory state | Unauthenticated; parse `ready` |
| `GET /api/v1/infra/memory` | Current memory sampler snapshot | Unauthenticated |
| `GET /api/v1/infra/memory?samples=1` | Snapshot plus bounded sample ring | Unauthenticated; larger response |
| `GET /api/v1/events` | Coalesced runtime SSE stream, optionally scoped by `sessionID` | Browser/runtime synchronization surface |
| tool-output routes | Paginated/tailable persisted output for asynchronous tools | Treat output as potentially sensitive |

The memory sampler is configuration-controlled. When disabled, the endpoint reports disabled/running state with no samples. When enabled, it captures bounded process memory observations and warning counts. Consult the configuration reference for interval, threshold, and ring limits.

## Logs and durable diagnostics

The server writes lifecycle, recovery, error-policy, question-repair, scheduled-worker, and shutdown messages through its logger (console by default). Capture stdout and stderr at the supervisor boundary with timestamps and rotation appropriate to the environment.

Additional evidence lives in application state:

- asynchronous process records expose lifecycle and recovery state;
- tool calls store status, result/error metadata, and output references;
- command output is persisted and can be tailed through the API;
- runtime SSE event types, heartbeat traffic, and reconnect behavior help diagnose missed browser state;
- the native mailer writes login-link events to its configured local log path in development.

Authentication links, tool output, prompts, provider responses, paths, and plugin data can all contain sensitive material. Limit access and redact before sharing.

## Operator checks

For a suspected startup or recovery issue:

1. confirm the process is running and capture its earliest startup messages;
2. query `/health` and distinguish HTTP liveness from `ready: true`;
3. inspect the memory endpoint if memory monitoring is enabled;
4. look for database connection, process recovery, scheduled-frame, and question-repair messages;
5. inspect the affected session's event stream and durable process/tool records; and
6. reproduce with a disposable session before mutating durable data.

For a browser synchronization issue, record the session ID, observed event types, heartbeat/reconnect timing, and whether reloading the current frame window corrected the view. The current SSE transport does not provide durable replay IDs; durable session history must be fetched from the frame routes. The browser is one client of the runtime, so diagnose the HTTP/SSE contract separately from rendering.

## Alerting guidance

At minimum, an external supervisor should alert on process exit, repeated restart, readiness failing past the startup deadline, and sustained memory warnings. Consider domain-specific alerts for interrupted tool calls, child-process shutdown escalation, repeated recovery failures, and authentication delivery failures. Thresholds are deployment policy, not hard-coded promises in this repository.

## Sources of truth

- `src/server/routes/infra-routes.mjs`
- `src/server/memory-sampler.mjs`
- `src/server/events.mjs`
- `src/server/process-error-policy.mjs`
- `src/server/index.mjs`
- `src/core/tools/tool-output-store.mjs`
- `src/core/tools/process-manager.mjs`
- `src/core/auth/mailer.mjs`

## Related

- [HTTP and SSE reference](../reference/http-api.md)
- [Configuration reference](../reference/configuration.md)
- [Tool reference](../reference/tools.md)
- [Frontend guide](../guides/frontend.md)
- [Runtime lifecycle](runtime-lifecycle.md)
