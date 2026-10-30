# Frames, Runtime, and Routing

> **Current v3 architecture.** Last verified against source: 2026-10-27.
> Status: implemented unless a section says otherwise.

Frames are Kikx's canonical conversation and runtime records. User messages,
agent output, thinking deltas, tool calls and results, compaction boundaries,
scheduled continuations, progress, questions, drafts, and system notices all use
the same durable envelope.

## The five boundaries

1. **FrameEngine** is the in-memory merge and commit engine for one loaded
   session. It assigns ordering and hybrid logical timestamps, maintains current
   heads and bounded history, applies phantom/group merges, records commits, and
   emits frame/commit events.
2. **FrameStore** persists session manifests, frames, commits, indexes, previews,
   windows, and scheduled-frame lookups through the active database driver.
3. **FrameRouter** matches committed frames against selectors and runs plugin
   chains. The store calls the persist-then-route entry point only after a commit
   is durable.
4. **FrameRuntime** owns sessions and their engines, loads and evicts session
   runtimes, connects engines to storage/routing, emits transport-neutral runtime
   events, and owns scheduled-frame processing.
5. **FrameManager** is a shared projection for consumers. It sorts visible
   frames, hides deleted/hidden/phantom records, collapses tool call/result pairs,
   and projects streaming phantoms onto their final response frame.

Do not call FrameManager the durable store, or FrameEngine the global runtime.
Those distinctions explain why the browser can rebuild a thread from persisted
frames and then apply live deltas without owning runtime state.

## Frame identity and ordering

Frames have stable IDs, a session ID, type, author identity, timestamps and
logical clocks, content, visibility flags, and optional routing or scheduling
fields. `parentID` expresses a frame relationship; `interactionID` groups work;
`order` and `commitOrder` establish deterministic display and commit ordering.

An update is another merged version of the same frame ID. The engine retains a
bounded in-memory version history; the database remains the durable authority.
Phantom frames can update a group or response without becoming a separate
visible message. Tool calls and results remain separate durable frames even when
the projection renders them as one item.

## Commit and route flow

```text
producer creates/updates frames
        → FrameEngine.merge()
        → FrameStore commit and flush
        → FrameRouter.enqueueCommit()
        → selector plugin chain
        → further durable frames/events
```

The router orders queued commits by frame priority and preserves ordering when
queued commits touch the same frame IDs. Agent work does not occupy the global
commit queue: it runs on a per-session serial chain, so one slow model does not
block unrelated sessions. Within one session, coordinator and recipient agent
turns remain ordered.

Frames scheduled for the future are stored but withheld from ordinary routing.
The scheduled-frame worker later marks the frame firing, routes it with a
scheduled-dispatch commit, and records fired or cancelled status.

## Sessions and live runtime state

A session manifest stores participants, coordinator and compactor designations,
parent/generation metadata, preferences, message count, and lifecycle stamps.
Loaded session entries also contain process-local state: the FrameEngine,
active-agent runs, steering/cancellation sets, suspension state, and store
disconnect callbacks.

Long work pins its session entry so LRU eviction cannot detach the engine before
later commits reach storage. Session deletion is soft: it stamps `deletedAt` and
does not erase frames or tool output.

## Consumer and transport behavior

The server exposes JSON routes for snapshots and an SSE stream for runtime
events. The process-wide event gateway coalesces high-volume updates before
fan-out. SSE has no replay buffer; after reconnect, the browser reloads session,
frame, and question state. Another UI can implement the same snapshot-plus-live
event contract without importing browser components.

## Source of truth

- [`src/core/frames/frame-engine.mjs`](../../src/core/frames/frame-engine.mjs)
- [`src/core/aeordb/frame-store.mjs`](../../src/core/aeordb/frame-store.mjs) —
  legacy directory name; it operates through the active database driver
- [`src/core/routing/frame-router.mjs`](../../src/core/routing/frame-router.mjs)
- [`src/core/runtime/frame-runtime.mjs`](../../src/core/runtime/frame-runtime.mjs)
- [`src/shared/frame-manager/frame-manager.mjs`](../../src/shared/frame-manager/frame-manager.mjs)
- [`src/server/runtime-event-gateway.mjs`](../../src/server/runtime-event-gateway.mjs)

## Related

- [Architecture overview](./README.md)
- [Actors and routing](./actors-and-routing.md)
- [Tools and scheduling](./tools-processes-scheduling.md)
- [Context compaction](./context-compaction.md)

