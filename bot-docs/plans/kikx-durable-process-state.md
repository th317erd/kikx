# Kikx: Durable Process & Consumption State Across Restarts

Status: **PROPOSED.** Depends on the scheduled-frame lookup fix (plan
`kikx-tool-rename-and-loop-termination.md`, P9) being landed.

## 1. Purpose and intent (owner ruling)

**Owner (2026-10-05):** "We WANT the entire and full state of every session to
survive server restarts — this is the entire reason we put the timers into the
DB to begin with." And: do **not** discard persisted timers on boot; "IF we
someday discover truly stale timers that never fired when they should, we would
fix the bug causing stale timers, not just wipe them all on every boot."

Kikx already made the **scheduled wake/continuation frames** durable in AeorDB
so a restart replays pending work. This plan completes the durability so the
timers are *usable* after a restart, and it **replaces the removed boot
sweep**. No age-based purging: timers always reload and fire when due.

## 2. The gap (verified)

| State | Durable? | Where |
|---|---|---|
| Frames (messages, tool frames) | ✅ | AeorDB (immutable) |
| Scheduled wake/continuation frames | ✅ | AeorDB; reloaded by `ScheduledFrameQueue.load()` |
| Completion output | ✅ | AeorDB via `ToolOutputStore` (referenced by `completionToolOutputID`) |
| **Process records** (`ProcessManager.processes`) | ❌ | **in-memory `Map`, empty at boot (`process-manager.mjs:78`)** |
| **Wake-consumed marker** (`wakeCompletionOutputID`) | ❌ | in-memory only |
| Process stdout/stderr files | ⚠️ | `/tmp/kikx-processes` (`DEFAULT_TEMP_ROOT`), not AeorDB |

Consequences after a restart with a reloaded wake:
- `manager.requireProcess(processID)` throws `Unknown process` → `exec-status`/
  `exec-read`/`exec-grep`/`exec-kill` cannot resolve the process.
- With no durable "already handled" marker, a re-fired wake for an
  already-consumed completion is indistinguishable from a fresh one → redundant
  re-entry (the `a07faa16` runaway shape).

The removed boot sweep cancelled every pending autonomous frame older than 1h to
paper over exactly these two gaps. It was a workaround, not a fix, and it
destroyed durable state the design wanted to replay.

## 3. Target contract

1. **Process records are durable.** Persist each `ProcessManager` record to
   AeorDB under the session's space, mirroring `ToolOutputStore`:
   `id, processID, agentID, sessionID, frameID, command, cwd, status, exitCode,
   signal, timedOut, timeoutMs, startedAt, completedAt, durationMs,
   completionToolOutputID, wakeFrameID, wakeCompletionOutputID`.
2. **Process stdio is durable.** stdout/stderr bodies stored in AeorDB (the
   existing `ToolOutputStore` mechanism, or a sibling), not `/tmp`.
3. **Rehydration at boot.** `ProcessManager` loads persisted records on startup;
   `requireProcess` resolves them. A record whose process was `running` at
   shutdown is marked `interrupted` (its child is gone), with any captured
   output preserved.
4. **Wake idempotency across restart.** The wake-consumed marker is durable, so a
   reloaded wake fires **once**: already-consumed → no-op; unconsumed → fires.
5. **Timers always reload.** `ScheduledFrameQueue.load()` (already present, with
   P9 fixed) restores every pending timer; no age-based discarding anywhere.

## 4. Phases

- **D1 — Persist process records.** Write/update a process record document on
  start, on significant transitions (running → completed/failed/killed), and on
  wake scheduling. Reuse `frameStore`'s AeorDB client; store under
  `/kikx/sessions/<sid>/processes/<processID>.json` (indexed for listing).
- **D2 — Persist stdio.** Move `stdout.txt`/`stderr.txt` off `/tmp` into the
  session's durable space (or store completed output via `ToolOutputStore` and
  keep only the live stream on disk, deleted once stored).
- **D3 — Rehydrate at boot.** `ProcessManager` loads persisted records; mark
  shutdown-time `running` records `interrupted`; wire into the existing startup
  promise chain so `ready` (see below) only flips after rehydration.
- **D4 — Durable consumption marker.** Persist `wakeCompletionOutputID`
  (single-shot already keys on it) so reloaded wakes are idempotent. A re-fired
  wake for a consumed output posts nothing.
- **D5 — Boot semantics for reloaded wakes.** A reloaded `exec-wake-on-completion`
  for an interrupted process wakes the agent with a status-resolution message
  ("process X was interrupted by a restart; its captured output is …; continue"),
  never a silent drop.
- **D6 — Remove any residual purge logic and document the invariant.** Grep-gate:
  no age-based cancellation of autonomous frames anywhere.

## 5. Verification spine

- **Durability round-trip spec:** start a process, persist, tear the runtime
  down, build a fresh one over the same AeorDB, assert the record resolves and
  status is correct (`completed` or `interrupted`).
- **Wake idempotency spec:** a consumed output's reloaded wake fires zero turns;
  an unconsumed one fires exactly one.
- **Reload spec (landed):** `FrameRuntime reloads persisted scheduled frames
  across a restart instead of discarding them` (proves timers survive, not swept).
- **End-to-end:** kill/restart the dev server mid-process; confirm the agent is
  woken with correct process resolution and no duplicate turns.
- **Grep-gate:** `sweepStaleAutonomousWakes` and any staleness horizon absent.

## 6. Notes / risks

- **Orphaned OS children:** on restart the child may still run (detached) or be
  reaped by the OS. We cannot reparent it; the durable record + captured output
  is the source of truth, and D5 gives the agent an honest "interrupted" status.
- **`/tmp` durability:** `DEFAULT_TEMP_ROOT` is not durable across host reboot;
  D2 addresses it.
- **`ready` semantics:** `/health.ready` already means "startup recovery +
  scheduled-frame worker settled"; D3 extends it to include process rehydration.
- **No data migration:** records are additive; missing persisted records simply
  mean "no known process" (the pre-existing behavior), with a clear error rather
  than a crash.
