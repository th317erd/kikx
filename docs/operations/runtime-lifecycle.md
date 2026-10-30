> **Current v3 documentation.** This page describes the unreleased third development revision. Source behavior wins if this page and the implementation differ.
>
> **Last verified:** 2026-10-27

# Runtime lifecycle

This page is the operator's model of a Kikx server process: composition, readiness, signal handling, and draining. The entry point is `src/server/index.mjs`; tests may compose the same server without binding a network port.

## Startup

The executable process installs its error and signal handlers before composing the application. It then:

1. creates the configuration store;
2. reads the listening host and port;
3. calls `createServer({ config })`;
4. waits for the best-effort authentication bootstrap promise; and
5. starts listening.

Server composition registers core services, built-in tools and tags, loads plugins, resolves and opens the configured database driver, constructs authentication and persistence stores, and starts recovery work. Durable process recovery completes before the scheduled-frame worker can fire recovered work. Question repair and other recovery paths are intentionally part of startup rather than deferred until a request.

`startupReady` begins false. It becomes true only after process recovery and scheduled-frame worker startup have settled. A listener accepting connections is therefore not sufficient evidence that Kikx is ready.

## Health and readiness

`GET /health` is unauthenticated and always returns HTTP 200 while the HTTP handler is responsive. Inspect the JSON rather than relying only on the status:

```json
{
  "ok": true,
  "ready": true,
  "services": { "database": true },
  "memory": {}
}
```

Use `ready === true` as the readiness condition. `services.database` means the canonical database service is registered; it is not a query-level backend health check. The memory member is a compact sampler snapshot when monitoring is enabled and otherwise is `null` or disabled state.

Suggested local probe:

```bash
curl --fail --silent http://127.0.0.1:3000/health
```

Supervisors should parse the response and wait for `ready`, use a finite startup deadline, and retain process logs when the deadline expires.

## Process error policy

- `unhandledRejection` is logged and contained; one stray rejected promise does not terminate every connected client.
- `uncaughtException` is fatal. Kikx logs it, attempts the same graceful shutdown path used for signals, and exits non-zero.
- `SIGINT` and `SIGTERM` both initiate graceful shutdown. Repeated shutdown requests are ignored once draining starts.

## Graceful shutdown

The runtime drains in this order:

1. mark tool shutdown state so new work cannot begin;
2. ask managed child processes to terminate with `SIGTERM`;
3. allow in-process tool calls up to 30 seconds to finish;
4. mark remaining tool calls interrupted with an explicit not-completed result;
5. escalate remaining managed children to `SIGKILL` after 30 seconds, with a 35-second process-manager ceiling;
6. flush the frame router and frame store, each behind a one-second bound;
7. disconnect the frame runtime;
8. close the database connection; and
9. close the HTTP server and exit.

Shutdown errors or timeouts result in a non-zero exit. Operators must not treat termination as evidence that every external side effect was reversed: an interrupted asynchronous tool may have performed work before its durable result was recorded.

Development wrappers (`scripts/dev-watch.mjs`, `scripts/start-kikx-dev.mjs`, and `scripts/start-dev.mjs`) have their own child-process supervision. Their historical AeorDB-specific branches are compatibility tooling, not the canonical production lifecycle.

## Sources of truth

- `src/server/index.mjs`
- `src/server/create-server.mjs`
- `src/server/process-error-policy.mjs`
- `src/server/shutdown.mjs`
- `src/server/routes/infra-routes.mjs`
- `scripts/dev-watch.mjs`

## Related

- [Configuration reference](../reference/configuration.md)
- [Database operations](database.md)
- [Observability](observability.md)
- [HTTP and SSE reference](../reference/http-api.md)
- [Development setup](../guides/development.md)

