# Known flake: `OutputReadTool` / `ExecTool` completion race (2026-10-18)

> **Active known issue with dated evidence.** The reproduction and measurements below come from 2026-10-18. Follow the instrumentation plan if it recurs; verify current source before applying old line references.

**Status: DOCUMENTED, NOT FIXED.** Owner decision 2026-10-18: record what we know and move on.
The underlying product ordering is real; the residual failure is load-sensitive, rare, and has no
captured assertion text. Do not spend more time chasing it without new evidence.

Baseline: kikx2 @ `d685ebd`, post-fix working tree. Runner:
`timeout 120 node --test --test-timeout=30000 'spec/**/*-spec.mjs'` (no `--test-concurrency`;
139 spec files run concurrently across 16 cores).

## 1. What is definitively true (verified by reading source)

`ProcessManager.complete()` **sets `record.status` before it awaits the completion store**:

- `src/core/tools/process-manager.mjs:340` `async complete(record, …)`
- `:347-362` assigns `record.exitCode`, `record.status = 'completed' | 'failed' | 'timed-out' | 'killed'`
- `:365` `await this.storeCompletionOutput(record)` — the await that writes `completionToolOutputID`

So there is a real window in which `status().status === 'completed'` but
`completionToolOutputID` is still null. Any test that waits on the status and *then* reads the
completion artefact is racing this window. Four tests did exactly that; all four were corrected to
wait on `completionToolOutputID` itself:

| Spec test | Harness grace |
| --- | --- |
| `OutputReadTool reads persisted exec completion output by tool output ID` (`:963`) | `graceMs: 5` |
| `ExecTool wake prompt gives range and grep instructions` | `graceMs: 10` |
| `ExecTool automatically schedules an agent wake …` (`scheduledFrames.length === 1`) | `graceMs: 10` |
| `OutputReadTool` (second site) / `ExecTool` completion-status read | default |

The corrected predicate shape (now at `spec/core/web-tools-spec.mjs:780` and `:975`):

```js
await waitFor(async () => {
  let current = processManager.status({ processID, _agentID: 'agent_1' });
  return current.status === 'completed' && Boolean(current.completionToolOutputID);
});
```

**This correction is strictly more correct than what it replaced, and it stands on its own merits.**
It did not, however, eliminate the residual failure.

## 2. The failure that remains

Observed **exactly once**, on the post-fix tree, in a full-suite run:

```
exit=1   1290 pass / 2 fail   → later: 1291 pass / 1 fail
✖ OutputReadTool reads persisted exec completion output by tool output ID
```

**The `AssertionError` text was never captured.** The runner's failing-test list names the test but
not which of its three assertions broke. That absence is the core limitation of this document.

## 3. Reproduction attempts — all clean except the one observation

| Probe | Trials | Result |
| --- | --- | --- |
| Full suite, post-fix | ~33 runs | **1 failure total** |
| `spec/core/web-tools-spec.mjs` standalone | 86 | clean |
| Single test `--test-name-pattern`, 16-core CPU saturation | 50 | clean |
| `exitStdioGraceMs` stress (1 / 5 / 50 ms) | 75 | clean; `stdioClosedByManager=0` always |
| Grace-config sweep (default / 0 / 1 ms) | 90 | clean |

Observed rate: **1 in ~33 full-suite runs**. Earlier figures quoted during triage ("~3.5%",
"~1 in 8") were extrapolations from small batches and should not be repeated as measurements.

## 4. Hypotheses ruled out with evidence

| Hypothesis | Why it is dead |
| --- | --- |
| Tool-output ID drift (`OUT1` → `OUT2`) or cross-file interference | `createProcessHarness` (`spec/core/web-tools-spec.mjs` ~2254) builds a **fresh `ToolOutputStore` per call** with a local `outputID = 0` and `idGenerator: () => 'OUT' + (++outputID)`. `response.id === 'OUT1'` is structurally guaranteed. |
| Stdout truncation via `forceCloseCaptureStreams` | 75/75 clean at `exitStdioGraceMs` 1/5/50 ms, and `stdioClosedByManager=0` in every trial — the force-close path never fired. A `sleep 0.05; printf` command closes streams naturally before the timer can truncate. |
| CPU contention alone | 25/25 clean with 16 CPU burners saturating the box. |
| Ambient dev-env leakage into the spec | Real, but a **separate** bug — see §6. Fixed and proven; not this failure. |

## 5. Surviving hypothesis (UNPROVEN — do not treat as diagnosis)

A `waitFor` deadline stall under full-suite load. `waitFor`
(`spec/core/web-tools-spec.mjs:2296-2315`) allows `options.timeoutMs || 3000`, polling every 20 ms,
then throws `lastError` or `new Error('waitFor timed out')`.

Two reasons to be suspicious, and two reasons not to patch it blind:

1. `waitFor` **swallows predicate exceptions** and keeps retrying until the deadline. A genuine
   product-side error inside the predicate is thereby converted into a timeout, or surfaced as
   `lastError` at the deadline — which would look like a timing problem while actually being a
   logic problem. This is a test-infrastructure weakness worth fixing regardless of the flake.
2. Under 139 concurrent spec processes the 50 ms `sleep` + 250 ms default exit-stdio grace + store
   write can plausibly exceed 3 s of wall clock on a loaded box.

Against patching: raising the deadline would apply a fix to a mechanism that was never observed, and
CPU-saturation probes did not reproduce it.

## 6. Adjacent finding, confirmed and left untouched (product code)

`src/core/tools/process-manager.mjs` defines **`storeCompletionOutput` twice in the same class** —
line `375` and line `419` — with byte-identical bodies (both call `buildCompletionResult` at `377`
and `421`). The second definition silently wins.

Behaviourally dead, but real debt: a duplicated async method in a 482-line file is a plausible hiding
place for a future ordering surprise, and it makes the completion path harder to reason about.
Out of scope for "fix the broken test"; **not modified.**

## 7. What was actually fixed (separate bug, closed)

`spec/scripts/request-login-link-spec.mjs` (+22 lines) — the spec spawned the script with
`{ ...process.env, ...options.env }` and overrode only `AEORDB_LOG_PATH`, so
`scripts/request-login-link.mjs:40` read the ambient `KIKX_AUTH_MAILER_LOG_PATH` and placed that live
dev log **first** in `logTargets`. A magic-link served during the test window was asserted on as if
it were test data.

Two details worth keeping:

- **Unsetting the variable would not have worked.** `.env.dev:21` defines
  `KIKX_AUTH_MAILER_LOG_PATH`, and `loadEnvFile` backfills absent keys — the spec would have fallen
  through to a *second* live log. The fix pins a per-run, provably nonexistent path that
  `fileSize`/`readFileSlice` treat as empty (`ENOENT` → empty).
- Proven by controlled injection: fails with the ambient variable set, passes without, and **5/5
  clean with the hostile value deliberately re-injected.**

## 8. If it recurs — the instrumentation plan

Do not re-run blind loops. Instead:

1. Patch `waitFor` to write to `/tmp/waitfor-trace.log` on expiry: predicate source, elapsed ms,
   iteration count, and `lastError` if any. Also include the deadline in the thrown message so the
   runner's output names the cause.
2. Record which of the three assertions the failing test reports (assertion line number suffices).
3. Run the full suite ~50× with the tracer in place.

That converts a ~3% ghost into named evidence in one pass. Until then, treat a full-suite failure
naming these four tests as **suspected-flake, not regression** — but check whether it appeared in a
run that *also* failed elsewhere, and do not wave it through if a diff touches
`process-manager.mjs` or the tool-output store.

## 9. Consequence for the DoD gate

The historical [`kikx-ask-user-and-activities.md`](../../history/plans/historical/kikx-ask-user-and-activities.md)
§15 requires "full `npm test` exit 0 at each phase landing". With
this flake, that gate is **~97% reliable, not 100%**. On a failing run: confirm the only failures are
these four tests, re-run once, and record it. Do not block a phase landing on a re-run that
reproduces only this signature.
