# Wake spec audit — mutation analysis

Target: `spec/core/questions/question-wake-spec.mjs` (12 tests) vs `src/core/questions/question-wake.mjs`.
Method: one mutation at a time, real exit code, restore, diff-confirm `IDENTICAL_TO_ORIGINAL`. Baseline `12 pass 0 fail`, exit 0.

> **Correction (self-caught on re-measurement).** The first version of this table mapped several mutations to the wrong tests, and the audit harness's own `failing_tests` column read `0` for every mutation. Both were measurement bugs, not result bugs. The harness grepped TAP's `^not ok` prefix, but `node --test`'s default reporter prints `✖`; and the index mapping below was written from memory rather than from the logs. Corrected from the `✖` lines and `ℹ fail` counts in `/tmp/mut-*.log`. Test **names**, not indices, are cited from here on.

Mutation → tests killed (one mutation at a time, restore + `IDENTICAL_TO_ORIGINAL` after each):
- `null targetAgentID` → 2 fail · exactly-one-targeted-UserMessage · routes-to-asking-agent-only
- `siblings: []` → 1 fail · whole-batch-coherence (D-9)
- swallow answer errors → 1 fail · duplicate-answer-is-409
- delete participant guard → 3 fail · never-dropped · non-participant-asker · undeliverable-instead-of-throw
- delete 404 guard → **2** fail · origin-session-missing · deleted-origin-session-undeliverable
- delete `isAgentUnavailable` guard → 1 fail · disabled/deleted-agent-undeliverable
- delete `markUndeliverable` → 2 fail · deleted-origin-session · undeliverable-instead-of-throw
- drop `A:` answer line → **3** fail · drop answer age → 1 fail · drop continue hint → 1 fail (all three: `buildAnswerPromptText stands on its own`)

Every mutation above exits 1. The exception is the flush barrier, below.

**Finding 1 — the flush barrier is untested and cannot fail.** Deleting the whole post-append barrier (`question-wake.mjs:213-216` — `if (typeof this.frameRuntime.flush === 'function') await this.frameRuntime.flush(); else await this.frameRuntime.frameStore?.flush?.();` — both arms; the rationale comment is `:205-212`) leaves **12/12 pass, exit 0**. The spec names `flush` once, as a no-op stub (`question-wake-spec.mjs`, fake runtime), and nothing asserts it. The code calls this barrier load-bearing — "stored *and* dispatched", "exactly the gap this service exists to close" — so the guarantee the service exists for has no regression test.

**Finding 2 — test 11 is pure duplicate coverage, and the "only guard on the positive direction" defence is false.** Test 11 (`question-wake-spec.mjs:353-360`) asserts `isAutonomousContinuation`: false for `user-answer` and `null`, true for `exec-wake-on-completion` and `send`. All four assertions are already covered elsewhere:
- negative direction — `autonomous-chain-continuation-kinds-spec.mjs:52` asserts `isAutonomousContinuation({kind: 'user-answer'}) === false`, and `:44` pins `includes(...) === false`.
- positive direction — **`autonomous-chain-spec.mjs:12,13,16` already assert `true`** for `exec-wake-on-completion`, `send` and the legacy `agent-respond-and-continue`. That spec predates this campaign.

So the mutant "predicate hardwired to `return false`" fails `autonomous-chain-spec.mjs` whether or not test 11 exists. `isAutonomousContinuation` is `Boolean(c) && AUTONOMOUS_CONTINUATION_KINDS.includes(c.kind)` (`autonomous-chain.mjs:23-25`), and a `return false` mutant kills three assertions in a spec nobody was defending. **Test 11 is not load-bearing.** Recommendation: keep it — redundant coverage is cheap and it sits next to the code it guards — but do not cite it as the sole guard on the predicate's positive direction.

Verified after this correction: `question-wake-flush-spec.mjs` **4/4 pass, FLUSH_EXIT=0**; `question-wake-spec.mjs` **12/12 pass, WAKE_EXIT=0**; `find src spec -newer` both logs → empty.
