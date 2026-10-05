# Kikx: Durable Process & Consumption State Across Restarts

Status: **IMPLEMENTED (D1–D6).** Depends on the scheduled-frame lookup fix (plan
`kikx-tool-rename-and-loop-termination.md`, P9), which is landed.

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

- **D1 — Persist process records.** ✅ `ProcessStore.saveRecord()` writes a
  sanitized record (no live handles/streams/promises) to
  `/kikx/sessions/<sessionID>/processes/<processID>.json` on start, on
  completion, and after wake scheduling.
- **D2 — Persist stdio.** ✅ `ProcessStore.saveStdio()` mirrors stdout/stderr
  bodies next to the record; `readStdio()` prefers the live capture file and
  falls back to the durable copy, so a host reboot does not lose buffered output.
- **D3 — Rehydrate at boot.** ✅ `ProcessManager.rehydrate()` loads persisted
  records, marks shutdown-time `running` records `interrupted`, stores their
  completion output, and installs them into `processes`. Wired into the
  `processRecoveryPromise` before the scheduled-frame worker, so `ready` only
  flips after rehydration.
- **D4 — Durable consumption marker.** ✅ `wakeFrameID`/`wakeCompletionOutputID`
  are persisted. `recoverPendingWakes()` (run after the worker loads persisted
  timers) reschedules only completed wakes that were never persisted and skips
  process IDs already pending in the queue, so a reloaded wake fires exactly once.
- **D5 — Boot semantics for reloaded wakes.** ✅ Interrupted records store a
  completion output and their wake carries `processStatus: 'interrupted'`; the
  wake prompt states the process was interrupted by a restart and output is
  preserved.
- **D6 — Remove any residual purge logic and document the invariant.** ✅ Grep-gate
  clean: `sweepStaleAutonomousWakes` and any staleness horizon are absent from
  `src/`, `spec/`, `scripts/`, `kikx-docker/`.

## 5. Verification spine

- **Durability round-trip spec:** ✅ `ProcessStore round-trips a process record
  and its captured stdio` + `durable stdio survives a reboot that clears the
  volatile capture directory`.
- **Rehydration spec:** ✅ `ProcessManager.rehydrate marks a shutdown-time running
  process interrupted and resolves it` (also proves `exec-read` returns the
  captured output under the interrupted status).
- **Wake idempotency spec:** ✅ `recoverPendingWakes reschedules an unconsumed
  completed wake exactly once and skips a consumed one`, plus `scheduleWake
  persists the wake frame id and consumed output so a reload is idempotent`.
- **Reload spec (landed):** `FrameRuntime reloads persisted scheduled frames
  across a restart instead of discarding them` (proves timers survive, not swept).
- **End-to-end (unit):** ✅ `an interrupted process yields exactly one reloaded,
  dispatched wake` — a crash-time `running` record rehydrates to `interrupted`,
  schedules one wake, fires it once, and a second pass recovers zero.
- **End-to-end (real AeorDB, dev 0.9.5):** ✅ seeded a running record, rebuilt a
  fresh `FrameRuntime`/`ProcessManager` over the same DB, rehydrated
  (`interrupted: 1`, durable stdout preserved, completion output stored),
  recovered one wake, fired it once (`scheduledStatus: fired`,
  `processStatus: interrupted`), second pass recovered 0. Dev server boots
  `ready:true` with no recovery errors.
- **Grep-gate:** `sweepStaleAutonomousWakes` and any staleness horizon absent. ✅

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
- **Unbounded process history (open follow-up):** every finished exec now leaves a
  durable record that `rehydrate()` loads into memory at boot, so unlike the old
  in-memory-only map a restart no longer clears history. This is deliberate
  (owner R8 wants full session state to survive), but it grows without bound.
  Retention/pruning of *completed* process records is a separate policy decision
  and is not addressed here; it is explicitly **not** an age-based purge of
  pending timers.
