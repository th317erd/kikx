# Kikx v3 Architecture

> **Current documentation — development revision 3, not a public release.**
> Last verified against source: 2026-10-27.

Kikx is an advanced, modular agent harness. This is the third development
revision of the project; no revision has been publicly released. “v3” describes
the active rewrite lineage, not the package's release version.

The architecture is built around durable frames, explicit process-local
services, plugin-defined behavior, and transport-neutral APIs. The browser is
the only first-party UI today, but it is a consumer of the harness rather than
the harness itself.

## System map

```text
configured plugins and database driver
                 │
                 ▼
            AppContext
                 │
      ┌──────────┼───────────┐
      ▼          ▼           ▼
 FrameRuntime  services   PluginRegistry
      │                      │
      ├─ sessions            ├─ agent providers
      ├─ FrameEngine         ├─ tools and selectors
      ├─ FrameStore          ├─ database drivers
      └─ scheduler           ├─ class overrides
             │               └─ client components
             ▼
        FrameRouter
             │
             ▼
    agent/tool/plugin work
             │
             ▼
        the database
             │
      ┌──────┴──────┐
      ▼             ▼
 JSON HTTP API   runtime SSE
      └──────┬──────┘
             ▼
       browser client today
```

`AppContext` wires services without hiding their dependencies. `FrameRuntime`
owns live session runtimes, durable frame operations, the scheduled-frame queue,
and runtime events. Each loaded session has a `FrameEngine`. `FrameRouter`
dispatches already-persisted commits to selector plugins. Stores use the active
database driver through a generic document contract.

## Capability status

| Capability | Status | Important boundary |
| --- | --- | --- |
| Durable frame model and routing | Implemented | Frame engine, store, router, runtime, projection |
| Multiple agents in one session | Implemented | Coordinator-first routing, then selected recipients |
| Users and agents as actors | Implemented | Users author messages; agents are routable participants |
| Plugin actors | Planned | Resolver seam exists; plugin actors are not wired as routable actors |
| Session hierarchy | Partial | Tree authority is depth-independent; agent delegation may create only one child generation |
| Teams | Implemented | Reusable collections of user and agent identities |
| Cross-session communication | Implemented | Explicit messages, reads, tool targeting, control, and merge |
| Concurrent context compaction | Implemented | Background compaction; turns never wait for it |
| Durable asynchronous tools | Implemented | Managed processes, stored output, scheduling, restart recovery |
| Characters and human profiles | Implemented | Distinct agent-character and account-profile records |
| Plugin and provider system | Implemented | The bundled plugin population is smaller than the supported surface |
| Pluggable persistence | Implemented, legacy naming remains | PostgreSQL is primary in current development; docs say “the database” generically |
| UI-independent harness | Implemented boundary, one UI today | JSON/SSE can serve another adapter; only the browser client ships now |

## Reading paths

- [Frames, runtime, and routing](./frames-runtime-routing.md)
- [Plugins, providers, and persistence](./plugins-providers-persistence.md)
- [Actors, agents, and coordinator routing](./actors-and-routing.md)
- [Session trees, teams, and cross-session work](./sessions-teams-cross-session.md)
- [Agentic script and loop](./agentic-script.md)
- [Concurrent context compaction](./context-compaction.md)
- [Tools, processes, scheduling, and recovery](./tools-processes-scheduling.md)
- [Agent behavior reference](../reference/agent-behavior.md)

## Source of truth

Architecture prose explains contracts; executable source decides behavior. Start
with [`src/server/create-server.mjs`](../../src/server/create-server.mjs),
[`src/core/app/app-context.mjs`](../../src/core/app/app-context.mjs),
[`src/core/runtime/frame-runtime.mjs`](../../src/core/runtime/frame-runtime.mjs),
and [`src/core/plugins/plugin-registry.mjs`](../../src/core/plugins/plugin-registry.mjs).

## Related

- [HTTP API reference](../reference/http-api.md)
- [Source map](../reference/source-map.md)
- [Completed documentation consolidation](../history/plans/completed/documentation-consolidation.md)
