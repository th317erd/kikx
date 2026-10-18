# Wake spec audit — mutation analysis

Target: `spec/core/questions/question-wake-spec.mjs` (12 tests) vs `src/core/questions/question-wake.mjs`.
Method: one mutation at a time, real exit code, restore, diff-confirm `IDENTICAL_TO_ORIGINAL`. Baseline `12 pass 0 fail`, exit 0.

Mutation → tests killed: null `targetAgentID` → #1,#2 · `siblings: []` → #3 · guard `answerQuestion` → #4 (409) · delete participant guard → #5,#8 · delete 404 guard → #6 · delete `isAgentUnavailable` guard → #7 · delete `markUndeliverable` → #9,#10 · drop `A:` line / age / continue hint → #12. All exit 1.

**Finding 1 — the flush barrier is untested and cannot fail.** Deleting the whole post-append barrier (`question-wake.mjs:196-205`: the `frameRuntime.flush()` branch **and** the `frameStore?.flush?.()` fallback) leaves **12/12 pass, exit 0**. The spec names `flush` once, as a no-op stub (`question-wake-spec.mjs`, fake runtime), and nothing asserts it. The code calls this barrier load-bearing — "stored *and* dispatched", "exactly the gap this service exists to close" — so the guarantee the service exists for has no regression test.

**Finding 2 — test 11 has no killing mutation in this module, but is not worthless.** It asserts on `autonomous-chain.mjs:14`, not the wake service. Independently proven: injecting `'user-answer'` into `AUTONOMOUS_CONTINUATION_KINDS` gives 3/3 fail, exit 1; restored to 3/3 pass. However it **duplicates** `spec/core/runtime/autonomous-chain-continuation-kinds-spec.mjs`, which already pins the list via `deepEqual` and couples to the producer by scanning for emitted `kind:` literals. Test 11 adds nothing that spec lacks.
