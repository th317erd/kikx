# Adversarial review — P2 (`9a6567d`) and P3 (`f642569`), plus P4 working tree

> **Historical code review.** Findings and suggested fixes describe the cited commits and working tree; later reports record follow-up changes. Verify current source before acting.

Reviewer: Kikx-Reviewer (read-only). Nothing in the tree was modified by this review.

## Verdict

**One BLOCKER.** The per-question mutex does *not* cover the shared open-index
read-modify-write. Concurrent answers to two *different* questions can drop an
entry from the open index permanently. Reproduced with a real run, not inferred
(script: `/tmp/proof-index-race.mjs`, output quoted below).

---

## Q1 — Does the mutex cover the read-modify-write window?

**No. The mutex is keyed on the wrong thing.**

- `withLock(key, fn)` — `src/core/questions/questions-store.mjs:391`
- Every caller passes the **question id**: `:138` (answer), `:168`
  (markUndeliverable), `:198` (dismiss), `:225` (attachQuestionFrame), `:239`
  (markRead).
- But `answerQuestion`/`markUndeliverable`/`dismissQuestion` each call
  `writeIndexes(...)` **inside** that lock: `:154`, `:189`, `:211`.
- `writeIndexes` does a read-modify-write of one **globally shared** document:
  reads the index at `:450` (`readOpenIndex()`, path `/kikx/questions/index/open.json`,
  `:510`), merges, then writes the whole file at `:466`.

Two answers to two different question ids therefore hold two *different* locks
while mutating the *same* file. Classic lost update, and AeorDB has no
conditional write or etag to catch it.

### Proof (executed)

```
open index before : q1,q2
open index after  : q1
listOpen() returns: q1
docs statuses     : answered answered
LOST UPDATE: index still lists answered question(s): q1
```

Both docs are correctly `answered`; the index still advertises `q1` as open.
Consequence, and why this is a BLOCKER rather than cosmetic:

- `listOpen()` (`:255`) reads the index only — by design (plan §"Inbox lists from
  the open index only"). So `GET /api/v1/questions`
  (`src/server/routes/question-routes.mjs:21-49`) will keep serving an answered
  question.
- The Inbox renders a live answer box for it, and submitting returns **409**
  ("Question already answered"). A phantom row the user cannot clear.
- **Nothing repairs it.** `reindex()` (`:326`) exists but `grep -rn reindex src/ spec/`
  (`--include=*.mjs`, node_modules excluded) finds callers **only in specs**
  (`spec/core/questions/question-store-spec.mjs:289,306`) and **none in `src/`**. The self-healing
  path the module documentation promises (`:322` "Indexes are caches, never
  truth") is never invoked.

### Second, independent hole in the same window

`createQuestions` calls `writeIndexes` at `:96` with **no lock at all** — outside
any `withLock`. Two concurrent `ask-user` calls race on the same index with the
same effect. Same fix covers both.

### Suggested fix (one revert unit, small) — CORRECTED

My first instinct was to wrap both `writeIndexes` and `createQuestions` in
`withLock(index:open, ...)`. **I tested that and it deadlocks.** `createQuestions`
calls `writeIndexes` internally (`:96`), which re-enters the same key, and
`withLock` is not re-entrant (`:391` chains on `previous`, so the inner call waits
on the outer holder forever):

```
naive-both-locks   HUNG (deadlock)
lock-writeIndexes   index_ids=5/5  lost=0
```

The fix that works is to lock **only `writeIndexes`** — `createQuestions` then
inherits protection, because its only index mutation goes through it. Verified
by subclassing `QuestionsStore` and overriding nothing but `writeIndexes`
(no product file touched): 5 concurrent asks → `5/5` in the index, `lost=0`,
versus `1/5`, `lost=4` unfixed (script: `/tmp/proof-index-race3.mjs`).

Keep the per-question lock as-is: it correctly serialises the *doc*
read-modify-write and the terminal/409 check, which a spec does cover
(`spec/core/questions/question-store-spec.mjs:160`).

Add a regression test that fails today: N concurrent `createQuestions` calls must
yield N index entries, and N concurrent answers to N *distinct* questions must
leave a consistent index.

### Why the tests missed it

The only concurrency test is "concurrent answers to the **same** question"
(`:160`) — same key, so the mutex genuinely works there. There is no test that
answers two *different* questions concurrently. `grep Promise.all|concurrent`
across `spec/core/questions/*.mjs` and `spec/server/question-routes-spec.mjs`
returns exactly that one test.

---

## Q2 — Can an answer be durably stored but permanently undelivered?

**Yes, on two paths. Neither has any retry.**

`submitAnswer` order is deliberate and documented (`src/core/questions/question-wake.mjs:62-69`):
persist via `answerQuestion` (`:67`), then `deliverAnswer` (`:71`).

1. **Crash / reject between `:67` and `:71`.** The doc is `status:'answered'` with
   `answerFrameID: null`. Nothing scans for that state on boot, and a re-answer
   is refused (409 — `assertOpen`), so the answer is stranded.
2. **Delivery fails at `:74-89`.** `markUndeliverable` (`:74`) moves the doc to
   `status:'undeliverable'`, a **terminal** status. The answer is preserved (good,
   by design) but there is no route or service that can deliver it later.

Evidence that no retry exists: `grep -rn "retry\|redeliver\|resume\|pendingDelivery"
src/core/questions/` → **no matches**. `grep -n "setTimeout\|scheduledAt"
src/core/questions/question-wake.mjs` → **no matches**. The wake is a fire-and-forget
`appendUserMessage` + `flush()` (`:213-216`); if the agent is unavailable at that
instant, that is final.

`question-routes.mjs:57-58,90` is explicit that `delivered:false` still returns
**200** because the answer is durable. That is a defensible product choice, but
it means the only record of non-delivery is a doc field no UI or endpoint
re-reads (the open index has already dropped it).

**Not a blocking defect, but it is an unfinished contract.** The plan's own
§5.4 fallback ladder implies eventual delivery. Minimum acceptable fix: a
deliver-pending sweep on boot for `status==='answered' && answerFrameID==null`,
and expose `undeliverable` questions so a human can see them.

---

## MINOR

- `src/core/questions/questions-store.mjs` is **755 lines** (soft 500, hard 800).
  At P1 it was 726; P2 added 29. Not blocking, but this is the file absorbing
  every question-store change and it is ~45 lines from the hard limit. Split
  before P5, not after.
- `spec/client/activities-stats-spec.mjs` **625 lines**, `spec/client/questions-state-spec.mjs`
  **678 lines** — specs over the 500 soft limit. Lower risk, noted for honesty.
- `src/core/questions/question-wake.mjs:148-152` swallows a group-lookup failure
  with a `warn` and continues with `group = null`. Defensible (the wake still
  carries the question) and logged, so not a silent swallow — but it means a
  wake can silently lose D-9's whole-batch context.
- `attachQuestionFrame` (`:225`) and `markRead` (`:239`) are locked but never
  call `writeIndexes`. Correct as written (neither changes `status`), recorded so
  a future reader does not "fix" them into the index path.

## What I could not fault

- `assertOpen` / `assertCanMarkUndeliverable` terminal-state enforcement is
  genuine: second answer is 409 and writes nothing, verified by test and by the
  race script above.
- The `flush()` barrier preference (`:213-216`) is correct — it prefers the full
  runtime barrier and falls back to store-only, and the comment states the exact
  gap it closes.
- P2's `frame-runtime-normalize.mjs` `buildUserMessageContent` returns byte-identical
  `{text}` when there is no extra content, so ordinary messages are unaffected.
