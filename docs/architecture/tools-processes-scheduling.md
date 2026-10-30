# Tools, Processes, Scheduling, and Recovery

> **Current v3 architecture.** Last verified against source: 2026-10-27.
> Status: implemented; recovery intentionally distinguishes safe replay from
> unknown side effects.

Tools are plugin classes executed by a common service. Every normal invocation
is represented by a durable call frame and result frame, while large result
bodies live in a separate output store. Local commands add a durable managed
process layer and completion wake.

## Tool execution lifecycle

1. Resolve the tool from the registry and build its execution context.
2. For a cross-session call, load and pin the explicit target session and use
   its FrameEngine.
3. Persist the tool-call frame with sanitized input.
4. Mark `startedProcessingAt` durably before invoking the tool.
5. Check permissions and execute the tool.
6. Store the full output, returning inline content or an output pointer.
7. Persist a result/error frame and mark the call finished.
8. Release any target-session pin.

Sensitive-looking input keys are redacted from stored frame summaries. The
output store provides bounded byte-range reads and optional search when the
active database driver supports it. Tool frames remain auditable even when a
specialized client component hides or combines their display.

## Managed commands

`exec` is asynchronous by design. It starts a child under `ProcessManager`,
captures stdout/stderr, waits briefly for very short commands, and otherwise
returns a process ID. Status, read, grep, kill, suspend, and resume tools operate
on that record. Shell detachment can put descendants outside manager control and
is therefore not the normal long-running-work mechanism.

Process metadata and completed stdio are persisted in the database. Live OS
handles, streams, promises, and timers remain process-local. Completion output
is stored through the same tool-output service and referenced by ID.

## Wake-on-completion and scheduling

An agent can request a wake when its process completes. Completion creates a
targeted scheduled frame with process status, output reference, continuation
prompt, and incremented autonomous depth. Multiple completions for the same
agent/session coalesce into one pending wake because a single turn can inspect
all completed processes.

`ScheduledFrameQueue` reloads pending frames, orders them by frame priority and
time, marks one firing, routes it through the ordinary router with an explicit
target, and finally records fired or cancelled state. A new human message
cancels pending autonomous wakes and continuations.

## Restart recovery

Startup recovery runs in a deliberate order:

1. recover stale runtime frame lifecycle state;
2. rehydrate durable process records and mark vanished live processes
   interrupted;
3. resume pending tool calls that were persisted but never started;
4. start the scheduled-frame worker and load persisted timers;
5. restore any completion wake that should have been scheduled but was not.

A call with no start stamp is safe to retry. A started call with no result is
**not replayed**, because its external side effect may already have happened; it
is finalized as interrupted/error. If a result exists but the call lacks its
finish stamp, recovery reconciles the stamp. This boundary prevents restart from
duplicating writes, messages, or commands.

Shutdown first blocks new tool starts, waits a bounded time for in-flight work,
terminates managed children, finalizes abandoned calls, flushes routing/storage,
then closes the database.

## Source of truth

- [`src/core/tools/tool-execution-service.mjs`](../../src/core/tools/tool-execution-service.mjs)
- [`src/core/tools/tool-output-store.mjs`](../../src/core/tools/tool-output-store.mjs)
- [`src/core/tools/process-manager.mjs`](../../src/core/tools/process-manager.mjs)
- [`src/core/tools/process-manager-store.mjs`](../../src/core/tools/process-manager-store.mjs)
- [`src/core/tools/process-manager-wake.mjs`](../../src/core/tools/process-manager-wake.mjs)
- [`src/core/tools/pending-tool-recovery.mjs`](../../src/core/tools/pending-tool-recovery.mjs)
- [`src/core/runtime/scheduled-frame-queue.mjs`](../../src/core/runtime/scheduled-frame-queue.mjs)
- [`src/server/create-server.mjs`](../../src/server/create-server.mjs)
- [`src/server/index.mjs`](../../src/server/index.mjs)

## Related

- [Architecture overview](./README.md)
- [Frames, runtime, and routing](./frames-runtime-routing.md)
- [Session trees and cross-session work](./sessions-teams-cross-session.md)
- [Agentic script](./agentic-script.md)
