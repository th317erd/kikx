# Kikx: Tool Rename + Agent Completion/Loop-Termination Redesign

Status: **P0–P10 implemented.** P0–P7 + P8 landed and pushed (`b9b0a63`).
P8 (age-based boot sweep) was later **removed** (owner ruling 2026-10-05:
durable timers must always reload). P9 (scheduled-frame lookup) and P10 (dev
health gate + repeatable deploy verification) are implemented; see §5 rulings.
Owner rulings R1–R8 recorded.

Implemented commits (kikx):
- `0976ffe` P1 — remove the agent completion self-review.
- `cca9cf0` P2 — bound autonomous chains (single-shot wakes, cancel on user turn, fail-safe).
- `2e47110` P3 — dual-verb rename (`end-turn`/`continue-turn`) + remove silence tool.
- `73708ce` P4 — autonomous-run clue in Brief B.
- `c61682c` P6 — docs updated; exports superseded.
- `f168084` P7 — incident regression spec.
- `9b9feae` P8 — boot-time stale autonomous-wake sweep (later removed; see R8).
- `ac5bef5` P9 — scheduled-frame lookup fix (superseded by corrected P9).
- P10 — dev health gate + repeatable `verify-scheduled-frames.mjs` + deploy `verify_deploy`.
Provider plugins: codex `66ff4e0`, ollama `4b9b93a` (claude/google needed none).
Gates: core 720/720, codex 36/36, ollama 17/17, eslint clean. P9/P10 unpushed/undeployed.

Motivating incident: production session `a07faa16-4eed-44a9-b823-f2e9c0c10df5`
("Kikx") reached **1287 frames / ~1240 messages** in a self-sustaining turn
chain. It only stopped after an ad-hoc `loop-break`, followed by an opaque
`"Agent provider finished without producing a response"` frame. Root causes are
enumerated in §1.3.

---

## 1. Evidence and territory

### 1.1 Baselines

| Item | Value | How measured |
|---|---|---|
| kikx core suite | **708 pass / 0 fail** | `timeout 150npm test` at `e473c8d` |
| eslint | clean | `npx eslint <changed>` |
| kikx HEAD | `e473c8d` (local, ahead 1) | `git rev-parse --short HEAD` |
| upstream main | `e5282b4` | `git rev-parse --short @{u}` |
| plugin refs | codex `d30db29`, ollama `ead02b2`, claude `d5d7a92`, google `3b47c77` | `git -C kikx-plugin-* rev-parse --short HEAD` |
| production session | 1287 frames, 1202→1240 msgs, 33 async-wake frames | prod AeorDB via `GET /api/v1/sessions/:id/frames?limit=2000` |

### 1.2 Control-tool inventory (current names)

Definitions: `src/core/plugins/agent-tool-definitions.mjs`.
Handlers: `src/core/plugins/agent-loop-tools.mjs:85-99`.
Brief A tool map: `src/core/plugins/agent-brief-template.mjs:54-70`.
Precepts/tool notes: `src/core/plugins/agent-precepts.mjs:46-98`.

| current name | handler action string | exposed when |
|---|---|---|
| `agent-respond` | `finalize` | always |
| `agent-finalize` | `finalize` | always |
| `agent-respond-and-continue` | `respond-and-continue` | always |
| `agent-null-response` | `null-response` | 3+ parties |
| `agent-progress` | (registered tool path) | always |
| `loop-break` | `break` | always |
| `route` | `route` | coordinator |
| `help` | — | always |
| `agent-character-set` | (registered tool path) | always |

Reference density (from recon): ~40 core/spec files; both providers
(`kikx-plugin-codex/index.mjs`, `kikx-plugin-ollama/index.mjs`); docs
(`docs/agentic-script.md`, `docs/proper-agent-behavior.md`); exports prompt
dumps. Traps: `agent-respond` is a prefix of `agent-respond-and-continue`
(require `agent-respond(?!-)`); bare `route`/`help` collide with HTTP routing and
per-tool `help:` properties. One **persisted** string:
`continuation.kind = 'agent-respond-and-continue'`
(`src/core/agents/agent-route/agent-route-frame-plugin-base.mjs:424`).

### 1.3 Loop-termination gaps (observed, with evidence)

1. **Completion self-review always runs** — `runCompletionReview`
   (`agent-interface.mjs:145,270-343`) re-`ask`s the model after finalize with
   the "Have you completed all the tasks?" checklist
   (`agent-script-template.mjs:31-60`). It can rewrite the visible answer, cause
   meta-text leakage, and **schedule its own continuation** via
   `handleLoopControl` (`agent-interface.mjs:310-311`). Not config-gated.
2. **No chain-level cap.** `maxLoopSteps=8` (`agent-interface.mjs:53,108`) is
   per-`ask`; the default script is one ask
   (`agent-interface.mjs:200-205`); continuations/wakes create fresh frames with
   no depth counter. No `maxContinuations`/`chainDepth` exists.
3. **Cancellation is dead plumbing.** `scheduledStatus:'cancelled'` is read in 5
   places (`scheduled-frame-queue.mjs:249`, `frame-router.mjs:290`,
   `agent-route/normalize.mjs:104`, `aeordb-frame-store-normalizers.mjs:150`,
   `aeordb-frame-store-scheduled.mjs:31-32`) but **written nowhere**. No cancel
   API exists.
4. **A new user message does not supersede pending wakes.** `shouldRouteUserMessage`
   (`agent-route/targeting.mjs:26-35`) is purely a routing predicate.
5. **Wake dedupe is per-record only** (`process-manager-wake.mjs:41-42`).
6. **Deferral guard is per-turn, not per-chain** — `deferralGuarded` lives in
   per-turn state (`agent-loop-state.mjs:11-27`), so a continuation loop re-arms
   it every turn (`agent-loop-state.mjs:152-179`).
7. **1:1 sessions cannot stay silent** — `agent-null-response` withheld below 3
   parties (`agent-loop-tools.mjs:117`), forcing every async wake to speak.
8. **Exec is unbounded by default** (`process-manager.mjs:88-89`).

### 1.4 Territory map

Entry → orchestration → authority → storage → publication.

- **Entry/dispatch**: `AgentInterface.runAgentLoop` (`agent-interface.mjs:93-180`),
  `executeAskStep` (`:207-268`), provider `ask()` adapters
  (`kikx-plugin-{codex,ollama,claude,google}`) which break their tool loop on a
  `LoopControl` result.
- **Authority (state)**: `handleLoopControl` (`agent-loop-state.mjs:59-103`);
  `createLoopState` (`:11-27`).
- **New-turn scheduling**: `process-manager-wake.mjs` (exec wakes),
  `agent-route-frame-plugin-base.mjs:379-444` (agent continuations),
  `scheduled-frame-queue.mjs` (queue), `frame-router.mjs` (`runSerial`,
  `shouldDeferScheduledFrame`).
- **Storage**: hidden system `UserMessage` frames with `scheduledAt`/
  `scheduledStatus`/`continuation`; persisted `continuation.kind`.
- **Publication/clients**: loop-control tools have **no** client renderer
  (`built-in-tool-uses.mjs`); they fall back to generic tool frames. No client
  edit is expected for renames, but this must be verified.
- **Docs**: `docs/agentic-script.md` (SOT), `docs/proper-agent-behavior.md`,
  `exports/*` prompt dumps (regenerate, do not hand-edit).

Unverified edge: whether any deployment/ops script greps tool names. Assumed
none; P0 grep-gate will confirm.

---

## 2. Frame

### 2.1 Target

1. Rename the control tools to an intuitive, verb-first taxonomy, **clean cut,
   no legacy aliases**, grep-gated to zero.
2. Make the agent's turn-ending decision a **dual-verb choice**
   (`end-turn` / `continue-turn`) governed by a **queue-as-definition-of-done**
   prompt guard that *biases toward working* rather than punishing loops.
3. Remove the redundant re-entry that caused the incident: **delete the
   completion self-review**, make wakes **single-shot**, and **cancel pending
   autonomous wakes when a user turn arrives**. Keep a single, very high,
   non-punitive, resumable fail-safe pause.

### 2.2 Non-goals

- No change to HTTP/route-matcher naming, the frame router, or `route`/`help`
  tool names.
- No data migration of already-persisted frames beyond tolerating legacy names
  on read.
- No deployment (separate authorization).
- No redesign of compaction or routing beyond what the loop fix requires.
- No turn/token budget arithmetic as the primary mechanism (explicitly
  reconsidered and rejected in favor of the queue guard; see §5).

### 2.3 Success criteria

- All control tools renamed; zero references to old names in `src/`, `spec/`,
  provider plugins, and docs (grep-gate in §6).
- `agent-respond`/`agent-finalize` collapsed into one `end-turn` tool whose
  `text` is **optional** (omitted ⇒ end turn silently), per R2.
- `agent-respond-and-continue` renamed to `continue-turn`; `agent-null-response`
  (`stay-silent`) **removed** (R4 — silence is `end-turn` with no text).
- Completion self-review fully removed (R3).
- Wakes are single-shot per `completionToolOutputID`; a user turn cancels
  pending autonomous wakes; a high resumable fail-safe bounds any surviving
  chain.
- The `a07faa16` incident is covered by a permanent regression test.
- Completion self-review **removed entirely**, per R3.
- A turn chain is bounded; a user message cancels superseded autonomous wakes; a
  wake is single-shot per `completionToolOutputID`.
- The `a07faa16` incident is covered by a permanent regression test.

### 2.4 Binding constraints

- File limits: 500 soft / 800 hard (`AGENTS.md:14-27`). `agent-interface.mjs`
  is currently ~476 lines — the review removal must **reduce**, not grow it.
- Style: `'use strict'`, 2-space, single quotes, `let`, trailing commas.
- Tests: mirrored `spec/**/*-spec.mjs`; UI changes need Stagehand. Loop/rename
  work is non-UI (verify no client keying).
- `docs/agentic-script.md:70-72`: maintain the "agentic script" vocabulary; do
  not invent alternate names.
- No implementation without authorization; deployments need explicit permission.

---

## 3. Contracts

### 3.1 Renamed tool contract (canonical, clean cut)

The turn-ending decision is a **dual verb**. The agent is *always* asked to pick
one of two next steps, which preserves the anti-lay-down pump while removing the
unconditional re-entry that caused the incident.

| old | **new** | params | LoopControl action | notes |
|---|---|---|---|---|
| `agent-respond`, `agent-finalize` | **`end-turn`** | `text?`, `reason?` | `finalize` | **Merge.** Omit/empty `text` ⇒ end with no visible frame (this replaces `stay-silent`). |
| `agent-respond-and-continue` | **`continue-turn`** | `text?`, `delayMs?`, `nextAction?` | `respond-and-continue` | Not done: schedule the next step. `text` optional; `nextAction` (defaults to `text`) is the hidden continuation prompt. |
| `agent-null-response` | **removed** | — | — | R4: killed. Silence = `end-turn` with no text. |
| `agent-progress` | **`progress`** | `text` | — | frame type `AgentProgress` unchanged |
| `loop-break` | **`stop`** | `reason?` | `break` | no visible output |
| `agent-character-set` | **`set-character`** | `character`, `compressedCharacter` | — | persisted agent-record effect |
| `route` | `route` (keep) | — | `route` | unchanged |
| `help` | `help` (keep) | — | — | unchanged |

**`end-turn` semantics (R2).** `text` optional. Present & non-empty ⇒ normal
finalize with a visible `AgentMessage`. Absent/empty ⇒ finalize with **no**
visible frame. `reason` optional, internal only, and is the R4 silence
substitute.

**`continue-turn` semantics.** Optional `text` (visible progress note) and an
optional `nextAction` naming the next step. `nextAction` becomes the hidden
continuation prompt; when omitted it defaults to `text`, else to the standard
continuation prompt. Scheduling is *not* refused for a missing next action (the
guard is prompt-level, §3.2) — but the brief requires the agent to name its next
step, and the fail-safe (§3.2) is the structural backstop.

**Final injected per-turn phrase (R4, verbatim).**

> End every turn one of two ways:
> - **`end-turn`** — with a report for the user — when your queue is empty.
> - **`continue-turn`** — with the next thing you're going to work on — when it isn't.
>
> If you don't know the next step yet, keep working to plan it out.

**"Queue" definition (R4).** The queue is: open todos (with focus) + still-running
async processes + the next action named on a `continue-turn`. The brief also
nudges: if you have open work, it belongs in the queue.

**Persisted compatibility.** `continuation.kind` changes from
`'agent-respond-and-continue'` to `'continue-turn'`. No runtime reader exists; a
single read-time normalizer tolerates the old value. No other durable tool-name
state exists.

### 3.2 Loop-termination contract

Termination stays **structural**, but the *decision* is prompt-guarded, not
cap-punished — agents are encouraged to keep working.

- **Dual-verb decision.** Every turn ends via `end-turn` (done) or
  `continue-turn` (not done). `continue-turn` is never refused.
- **Queue-as-definition-of-done (prompt guard).** The per-turn brief states the
  phrase above and, when the run is autonomous, a short stateful clue:
  `(Autonomous run — step N. <new input summary | no new input since your last step.>)`.
  This gives the model the fact it lacked in `a07faa16` (that it was repeating)
  without forbidding work. Included in P2; the clue line is the key anti-runaway
  behavior.
- **No completion review.** Delete the post-finalize `ask` entirely (R3).
- **Single-shot wakes.** A wake is scheduled at most once per
  `completionToolOutputID`.
- **Supersede on user turn.** Posting a user message marks pending autonomous
  scheduled frames `cancelled` (adds the missing writer).
- **High, non-punitive fail-safe.** If an autonomous chain reaches a high
  threshold (default 64 steps), further autonomous scheduling pauses and one
  visible notice is posted: *"Autonomous run paused — reply to continue."*
  Nothing is killed; stored output is intact; any user message resets the chain.
  Constant, config-overridable.
- **Bounded per-turn work.** Retain `maxLoopSteps`. No turn/token budget (see
  §5, rejected).

### 3.3 Storage contract (no fluff in history)

- Brief A/B, precepts, tool map, the final phrase, and the autonomous-run clue
  are **ephemeral** — assembled per request in `buildModelMessages` and never
  written to frames. Verified: no writer persists brief text.
- **Frames store only messages** (`content.text`) plus the model's `thinking`.
  `thinking` is stored but **not** projected (`frame-type-base.mjs:111` emits
  only `text`; hidden ⇒ null). Compaction summaries **are** projected by design.
- **Decision (R4):** hidden wake/`continue-turn` frames should store a **marker /
  next-action**, not a fully rendered prompt; render the continuation prompt at
  send time. Removes the last "fluff in storage" case.

---

## 4. Phases and ownership

Owned by coordinator; parallelizable tracks are marked. Each phase lands
green and is one-unit revertible. Hotspots (`agent-interface.mjs`,
`agent-tool-definitions.mjs`, `agent-loop-tools.mjs`, `agent-brief-template.mjs`,
`agent-precepts.mjs`) are serialized.

### P0 — Guards and characterization (foundational)
- **Deliverable:** failing-first regression tests that reproduce the `a07faa16`
  incident shape against the *current* code: (a) a completion-review pass that
  emits meta-text clobbers the draft; (b) N scheduled continuations run
  unbounded; (c) a pending wake fires after a user message.
- **Grep-gate:** enumerate current old-name references (baseline counts) and
  assert the rename's later zero-target.
- **Owns:** `spec/core/agent-interface-spec.mjs`,
  `spec/core/plugins/agent-loop-*-spec.mjs`, new
  `spec/core/agents/agent-loop-chain-spec.mjs`.
- **Exit:** new tests fail for the documented reason; existing 708 stay green.
- **Revert:** delete new tests.

### P1 — Completion-review removal (core)
- **Deliverable:** delete `runCompletionReview` and its call site
  (`agent-interface.mjs:145`), `buildCompletionReviewScriptPrompt` +
  `isCompletionReviewMetaResponseContent` + `canFitCompletionReview` +
  `reviewOutputReserveTokens`; drop `completion-review` handling from
  `agent-model-context.mjs:65,99` and `agent-brief-state.mjs:130`.
- **Guards:** P0 tests (a) become green; no new leaks.
- **Files:** `agent-interface.mjs` (must shrink), `agent-script-template.mjs`,
  `agent-loop-state.mjs`, `agent-model-context.mjs`, `agent-brief-state.mjs`,
  `src/core/plugins/index.mjs` (exports).
- **Exit:** core suite green; `agent-interface.mjs` line count drops.
- **Revert:** one commit.

### P2 — Single-shot wakes + cancel-on-user-turn + fail-safe (core)
- **Deliverable:** single-shot-per-`completionToolOutputID` in
  `process-manager-wake.mjs`; new cancel path writing `scheduledStatus:'cancelled'`
  for pending autonomous frames on user-turn; the high resumable fail-safe
  (default 64 autonomous steps) that pauses and posts one notice on trip; wire
  into `frameRuntime`/`frame-router`.
- **Files:** `process-manager-wake.mjs`, `process-manager.mjs`,
  `agent-route-frame-plugin-base.mjs`, `agent-route-frame-plugin.mjs`,
  `agent-loop-state.mjs` (chain/fail-safe accounting), `scheduled-frame-queue.mjs`
  (expose cancel), `frame-router.mjs` if needed.
- **Exit:** P0 tests (b),(c) green; core suite green.
- **Revert:** one commit.

### P3 — Rename, part 1: definitions, handlers, briefs, precepts (core)
- **Deliverable:** apply §3.1 to `agent-tool-definitions.mjs`,
  `agent-loop-tools.mjs`, `agent-brief-template.mjs`, `agent-precepts.mjs`;
  merge respond/finalize into `end-turn`; update `continuation.kind` writes +
  read-time normalizer.
- **Grep-gate:** old control-tool names → 0 in `src/`.
- **Exit:** core suite green.
- **Revert:** one commit.

### P4 — Queue guard + autonomous-run clue + single-party silence
- **Deliverable:** add the final per-turn phrase (§3.1) and the stateful
  autonomous-run clue line to Brief B; define "queue" = open todos + running
  processes + named next action; nudge "open work belongs in the queue". With
  `stay-silent` removed, confirm `end-turn` (no text) is the silence path in all
  party counts — a 1:1 continuation may end with no text.
- **Files:** `agent-brief-template.mjs`, `agent-precepts.mjs`,
  `agent-loop-tools.mjs:109-121`, `agent-participants.mjs`,
  `agent-brief-state.mjs` (step/newness input).
- **Exit:** new spec proves the phrase + clue appear, and a 1:1 continuation may
  end silently; core green.

### P5 — Rename, part 2: provider plugins (parallel track, separate repos)
- **Deliverable:** update `kikx-plugin-codex`, `kikx-plugin-ollama`,
  `kikx-plugin-claude`, `kikx-plugin-google` comments/name-pattern assertions;
  adjust their `spec/setup-spec.mjs`.
- **Exit:** each plugin's suite green.
- **Revert:** per-repo commit.

### P6 — Docs and exports regeneration
- **Deliverable:** update `docs/agentic-script.md`,
  `docs/proper-agent-behavior.md`; regenerate `exports/kikx-agent-prompt-*.md`
  from the new source (do not hand-edit); note the taxonomy and the store-only-
  messages contract (§3.3).
- **Exit:** grep-gate zero in docs.
- **Revert:** one commit.

### P7 — End-to-end incident regression + acceptance
- **Deliverable:** a scripted session (non-UI) that drives an async-wake chain
  and asserts it terminates and cancels on user input; plus a bounded live dev
  exercise.
- **Exit:** all gates green (core + provider suites).
- **Landed:** `f168084`.

### P8 — Boot-time stale autonomous-wake sweep (REMOVED)
- **Deliverable (original):** `FrameRuntime.sweepStaleAutonomousWakes()` cancelled
  every pending autonomous wake/continuation older than one hour at boot.
- **Landed:** `9b9feae`. **Removed** 2026-10-05.
- **Why removed (owner ruling):** durable scheduled frames exist precisely so
  session state survives restarts; discarding timers by age contradicts that.
  The sweep was a workaround for two real gaps — non-durable process records and
  a non-durable wake-consumed marker — not a fix for "old timers". Owner: "IF we
  someday discover truly stale timers that never fired when they should, we would
  fix the bug causing stale timers, not just wipe them all on every boot."
  Timers now always reload and fire when due. Follow-up: plan
  `kikx-durable-process-state.md` closes the two gaps. **That follow-up is now
  implemented (D1–D6)** — durable process records, stdio, boot rehydration,
  durable wake-consumption marker, and honest interrupted-wake semantics.

### P9 — Scheduled-frame lookup uses the correct AeorDB API (blocking fix)
- **Defect (corrected):** Kikx loaded scheduled frames via a path-scoped
  `POST /files/query` at `${root}/sessions`. `scheduledAt`/`scheduledStatus` are
  indexed **per session** under `.../interactions/.aeordb-config/indexes.json`
  (glob `**/frames/*.json`), not at the sessions root. AeorDB correctly returns
  `404 {"error":"Index not found for field 'scheduledAt' at path '/kikx/sessions'"}`.
  The old code treated any 404 as "no results" (`return []`), so
  `listScheduledFrames()` was always empty, silently disabling scheduled-frame
  loading and P8's sweep.
- **Retraction:** an earlier commit (`ac5bef5`) claimed "AeorDB 0.9.5 has no
  `/files/query` endpoint." That was **wrong** — the endpoint exists
  (`docs/src/api/querying.md`: `POST /files/query`, 404 = "Query path or index
  not found"). Corrected after reading `~/Projects/aeordb-workspace/aeordb/docs`.
- **Fix:** use the global `POST /files/search` endpoint (fans out across every
  directory that indexes the fields — the correct API for a cross-session
  lookup), scoped to the root, with the same fired/cancelled exclusion; on
  index/search error fall back to the authoritative per-session scan. Every
  returned frame is re-verified with `isPendingScheduledFrame`, so correctness
  never depends on the index filter.
- **Note:** `/files/search` combinator filtering on `scheduledStatus` is
  index-only and may return non-pending frames; the body check is authoritative.
- **Landed:** `ac5bef5` (superseded) → corrected in this phase. Tests rewritten
  to the search-first model (`spec/core/aeordb-frame-store-spec.mjs`). 720/720.
- **Also fixes (latent):** on 0.9.5 the queue never re-loaded *any* persisted
  scheduled frame on boot; new in-process wakes were unaffected.

### P10 — Dev launcher health gate + repeatable deploy verification
- **Dev gate:** `scripts/start-kikx-dev.mjs:waitForAeorDBReady` required exactly
  `healthy`, but AeorDB 0.9.5 reports `degraded` for benign conditions while
  serving normally (the container supervisor already accepts `degraded`). Now
  accepts `healthy` or `degraded`; only `failed` is fatal. This is why dev would
  not boot.
- **Repeatable verification:** new `scripts/verify-scheduled-frames.mjs`
  exchanges the root key for a token and asserts the real store path: global
  search finds scheduled frames, and the body-verified pending set matches.
  `kikx-docker/deploy.sh` runs it post-start (`verify_deploy`); non-fatal by
  default, `DEPLOY_VERIFY_REQUIRED=1` to enforce. This is the check that would
  have caught P9.

### P9/P10 verification gate (dev, pre-deploy)
1. `node scripts/verify-scheduled-frames.mjs` against dev → OK (done:
   0 pending, matching body verification).
2. Boot `kikx-dev` on the fixed launcher → listening (done; the `degraded` gate
   no longer blocks).
3. Confirm a known-stale dev wake is cancelled (done earlier: `7e1a689f`).
4. Then push + deploy (separate authorization); deploy runs `verify_deploy`.

---

## 5. Decisions (verbatim owner rulings)

- **R1** (2026-10-03). "I agree with your table above." — the rename table §3.1
  ratified, as later refined by R4.
- **R2** (2026-10-03). "I like this idea of merging the `agent-respond/agent-finalize`
  tools ... as long as the 'reason' is optional ..." — `end-turn` takes optional
  `text`/`reason`; absent text ⇒ silent end.
- **R3** (2026-10-03). "No legacy aliases... just move on" + "Yes please" — clean
  cut, no aliases; **remove the completion self-review entirely**.
- **R4** (2026-10-03). "1. No, let's kill it, and see if `end-turn` with an empty
  reason will be a good substitute. 2. Sounds good to me." — kill `stay-silent`;
  keep the high resumable fail-safe; `end-turn` with no text substitutes for
  silence.
- **R5** (2026-10-03). Dual-verb turn-ending with the **queue-as-definition-of-
  done** prompt guard; agent *always* takes a next step; no harsh "never"
  wording; bias toward continuing/planning; the guard is prompt-level, not a
  punitive cap. Verbatim final phrase in §3.1.
- **R6** (2026-10-03). Storage contract §3.3: don't store per-turn fluff; store
  messages (and thinking); post-compaction preamble is intentionally projected.
- **R7** (2026-10-04). "I want you to update the plan as well. And no, we are
  NOT going to deploy the change yet. We will test in Dev first." — P9 (the
  scheduled-frame fallback fix) is implemented and committed but must be verified
  on dev before any push/deploy.

- **R8** (2026-10-05). "We WANT the entire and full state of every session to
  survive server restarts — this is the entire reason we put the timers into the
  DB to begin with." … "I DO NOT want 'sweep stays'… IF we SOMEDAY discover
  truly stale timers that never fired when they should, well then, we would fix
  the bug causing stale timers, not just wipe them all on every boot." — the
  P8 age-based sweep is **removed**; persisted timers always reload and fire
  when due. The real gaps (non-durable process records + wake-consumed marker)
  are tracked in `kikx-durable-process-state.md`.
Self-answered (evidence-based): `route`/`help` kept (collision cost > benefit);
LoopControl action strings unchanged internally (`finalize`, etc.) to limit
blast radius; frame type `AgentProgress` unchanged; no data migration; turn/token
budget arithmetic **rejected** as the primary mechanism in favor of R5's queue
guard (with the high fail-safe as backstop).

---

## 6. Verification spine

- **Failing-first**: P0 tests reproduce all three incident behaviors before P1/P2.
- **Characterization**: existing 708 pass is the correctness baseline; each
  phase must not reduce it.
- **Grep-gates (mechanical DoD):**
  - `rg -n "agent-respond|agent-finalize|agent-null-response|loop-break|agent-progress|agent-character-set" src/ spec/` → 0.
  - `rg -n "completion-review|buildCompletionReviewScriptPrompt|runCompletionReview|isCompletionReviewMetaResponseContent" src/ spec/` → 0.
  - `rg -n "scheduledStatus: 'cancelled'|cancelScheduled" src/` → at least one writer.
  - `rg -n "end-turn|continue-turn" src/core/plugins/` → present.
- **Queue guard**: spec asserts the final phrase and the autonomous-run clue are
  in Brief B; and a 1:1 continuation may `end-turn` with no text.
- **Fail-safe**: spec asserts a synthetic chain reaches the high threshold,
  pauses, emits one notice, and a following user message resets it.
- **Supersede**: spec asserts a user message marks prior pending wakes cancelled.
- **Single-shot**: spec asserts a duplicate `completionToolOutputID` schedules no
  second wake.
- **Line-budget**: `wc -l src/core/plugins/agent-interface.mjs` must decrease.
- **Providers**: `npm test` in each `kikx-plugin-*`.
- **Real exercise**: bounded dev run driving an async chain; confirm termination
  and cancellation; record evidence under `bot-docs/reports/`.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Prefix trap `agent-respond` vs `-and-continue` | regex `(?!-)`; rename longer name first |
| `route`/`help` collateral churn | keep names; do not touch HTTP/router |
| Persisted `continuation.kind` old value | read-time normalizer tolerates both; no reader today |
| Removing completion-review changes answer quality | R3 owner-approved; P7 real exercise; revertible commit |
| Queue guard is model-self-assessed (weak models) | prompt-level intent + P4 stateful clue + P2 structural single-shot/cancel + high fail-safe |
| Unpushed `e473c8d` divergence | branch from `e473c8d`; do not push without owner |
| Provider repos drift | pin plugin refs at implementation start; separate commits |
| `agent-interface.mjs` growth | P1 must net-shrink the file (explicit gate) |
| AeorDB build lacks `/files/query` | P9 falls back to `searchFiles`/scan; do not read endpoint absence as empty |

## 8. Open items

- Authorization to implement — **granted** by owner ("Go."); implemented.
- High fail-safe threshold value (default 64) — accepted by owner.
- **P9 verification on dev (R7)** before push/deploy — see §4 P9 verification gate.
- **Owed after-change gate:** a bounded real end-to-end dev exercise driving an
  async wake chain (owner test), and push/deploy authorization.

## 9. Roadmap (out of scope here, dependency-ordered)

1. Grounding guard for post-review claims (from
   `bot-docs/bug-reports/dogfood-agent-review-hallucinated-after-self-review-loss.md`)
   — largely subsumed by R3.
2. Exec default timeout policy (`process-manager.mjs:88-89`).
3. Optional turn/token budget layer if R5's queue guard proves insufficient.
4. Push + deploy of P9 (separate authorization; R7 requires dev verification first).
5. Consider whether `continuation.kind` should be renamed `'continue-turn'`
   (currently persisted as `'send'`; no reader depends on the literal).
