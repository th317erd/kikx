# Concurrent Context Compaction

> **Current v3 architecture.** Last verified against source: 2026-10-27.
> Status: implemented. Turns do not wait for compaction, including at the hard
> limit.

Kikx compacts conversation memory in the background while the session remains
usable. Source frames are never deleted by compaction. A compaction frame marks
the durable boundary and summary that future model context projects from.

## Trigger and selection

The trigger uses the smallest effective context window among participating
agents. Each window resolves from explicit agent config, provider discovery,
the provider model catalog, or a finite fallback. This prevents a small-context
participant from being stranded by a decision based on a larger model.

The compactor is selected separately for capability, in this order:

1. session-assigned compaction agent;
2. highest applicable compaction score or designated compaction bot;
3. session coordinator; then
4. participating agent with the largest effective window.

The compactor's input budget reserves room for its instructions and output.
When the serialized input does not fit, Kikx compacts oldest-first chunks and
recursively reduces their summaries. A single oversized frame is explicitly
truncated rather than silently dropped.

## No-wait behavior

When the trigger is crossed, `prepareAgentContext` creates a running compaction
frame and starts one background promise per session/boundary. The current agent
turn continues with its available context.

If a turn reaches its hard limit while compaction is still running, Kikx still
does **not** wait. It trims the oldest projected frames for that request only,
preserving the active trigger and latest useful boundary where possible. The
brief warns that memory is temporarily incomplete. When background compaction
finishes, later turns project from its completed summary.

This is the defining concurrent-compaction property: provider work and memory
compression can overlap, while a bounded temporary view prevents oversized
requests.

## Compaction frame contract

`CompactionFrame` content records status, summary, boundary frame/order, covered
frame IDs, compactor identity, warnings/errors, and token metadata. Automatic
and manual compactions create a visible runtime record; the client renders its
running, complete, trimmed, or failed state as a specialized card. The frame is
part of model memory only when its status represents a usable boundary.

A completed frame projects its summary followed by later visible frames. A
trimmed/failed boundary can also advance the projection start so the same
oversized history is not resent indefinitely; the old frames remain durable and
can be retried. Running frames do not advance the boundary.

## Failure and retry

Compactor errors are absorbed into a durable trimmed boundary with warnings and
errors. The active turn proceeds with bounded context rather than failing solely
because summarization failed. Retry reconstructs the exact covered window from
the frame's stored metadata, recomputes the current compactor/window, and updates
the same frame ID.

Manual `/compact` uses the same machinery and immediately exposes the running
frame. An empty manual window completes with “Nothing to compact.”

## Source of truth

- [`src/core/compaction/compaction-service.mjs`](../../src/core/compaction/compaction-service.mjs)
- [`src/core/compaction/frame-context-builder.mjs`](../../src/core/compaction/frame-context-builder.mjs)
- [`src/core/compaction/chunked-compaction.mjs`](../../src/core/compaction/chunked-compaction.mjs)
- [`src/core/compaction/effective-windows.mjs`](../../src/core/compaction/effective-windows.mjs)
- [`src/core/compaction/select-compactor.mjs`](../../src/core/compaction/select-compactor.mjs)
- [`src/core/agents/agent-route-frame-plugin.mjs`](../../src/core/agents/agent-route-frame-plugin.mjs)

## Related

- [Architecture overview](./README.md)
- [Agentic script](./agentic-script.md)
- [Frames, runtime, and routing](./frames-runtime-routing.md)
- [Tools and scheduling](./tools-processes-scheduling.md)

