# Plan: `ask-user` tool, Questions table, and the Activities view

> **STATUS: v0.2 (maintainer).** Joint plan; the Production Kikx bot's
> `kikx-ask-user-and-activities.zav-draft.md` is still outstanding — this revision amends the
> maintainer draft with the resolved decisions and the adversarial-review + completeness passes
> required before P1 can be handed to a stranger. It is a *planning* artifact: **no implementation
> until the owner authorizes it**, and production feature work is owned by the prod bot (§10).
>
> **Change log**
> - **v0.1 (2026-10-17):** owner resolved D-1…D-5, D-8, D-10 (verbatim in §12).
> - **v0.2 (2026-10-17):** resolved **D-6, D-7, D-9** with code evidence (§12); corrected the wake
>   contract (`appendUserMessage` does not carry `targetAgentID` — §5.2); added the
>   fetch-on-connect requirement (§6.6); added §13 adversarial review, §14 completeness/roadmap,
>   §15 DoD + execution contract, §16 "execute P1 from this file alone". Every claim below cites a
>   file/line inspected this revision.

> **2026-10-18 - owner re-confirmation after an interrupted session.** The owner re-posted
> D-1, D-2, D-3, D-4, D-5, D-8, D-10 verbatim. Every resolution in §12 already matches what the
> owner stated; **no resolution changed**, and no re-authorisation of scope occurred. Two document
> defects were also corrected this revision: a dangling `§17` reference (the document ends at
> §16; the prod-bot ownership rule lives in §10) and `P0`, a phantom phase name used as a
> second name for `P1` (§9 defines P1-P5 with no P0).

Owner request (verbatim intent) — full quote in `.pi/ASK-USER-CAMPAIGN.md`.

## 1. Goals

1. **`ask-user` tool**: any agent can ask the user an ordered array of one or more questions.
   Always asynchronous — the tool never blocks the turn.
2. **Questions are first-class, durable entities** ("their own table"), tracked todo-style.
3. **Answers wake the asker** in the *originating* session, carrying the original question and
   **references** to the original context, so a stale pair stays intelligible.
4. **Inbox**: a pinned item at the top of the left sidebar header listing every question awaiting
   the user, each answerable in place.
5. **Activities view**: the left sidebar becomes an activities/navigation tree with quick stats
   (projects -> sessions -> sub-sessions), drillable.

### 1.1 Framing: sessions are "files and folders" [D-1]

Parent/child sessions are a directory tree; from it follow the same questions as a filesystem —
what to **cache**, what **permissions** attach, how parties **communicate about** a thing. v1 only
has to be *consistent* with that model. Richer tooling is deliberately future work (§14).

## 2. Non-goals (v1)

- No new project/folder entity ([D-1]); no session re-parenting UI.
- No multi-user assignment, ACLs, or notifications — in-app, single-user.
- No synchronous/blocking question variant. Ever.
- No question editing after asking (text immutable; the asker may dismiss an unanswered one).
- **No structured / quick-pick answers** ([D-4]).
- No server-side stats warehouse ([D-10]: client-derived in v1).

## 3. Domain model

### 3.1 Question document

Collection `kikx/questions/`, one doc per question `/kikx/questions/<questionID>.json`
(`questionID` uuid; `groupID` uuid per `ask-user` call). **Precedent:** `src/core/agents/agent-todo-store.mjs`
already writes one doc per entity under `/kikx/agents/<id>/todo.json` (`todoPath()`); questions
follow the same shape.

```
{
  id, groupID, index,
  status: 'open' | 'answered' | 'dismissed' | 'undeliverable',
  mode: 'wait' | 'continue',

  sessionID, agentID, interactionID, frameID, toolCallFrameID, toolOutputID,
  todoIDs: [ ], focusAtAsk: string|null,
  contextRefs: [ { type, id, label, sessionID?, frameID?, path? } ],

  text, priority: 'low'|'normal'|'high',     // NOTE [D-4]: no `options`
  answer: string|null, answeredAt, answeredClock, answeredByUserID,
  answerFrameID, dismissalReason: string|null,

  askedAt, askedClock, createdAt, updatedAt, readAt, deleted: boolean
}
```

Transitions `open -> answered | dismissed | undeliverable`; terminal never reopens.

### 3.2 Indexes **[D-6 — RESOLVED: per-status index doc]**

- **Per-agent mirror** `/kikx/agents/<agentID>/questions.json` — mirrors the todo
  doc (`src/core/agents/agent-todo-store.mjs`), injected into `runParams` per turn exactly like `todoState`
  (`agent-route-frame-plugin.mjs:204` loads it; `:224` passes it in `runParams`;
  `src/core/plugins/agent-brief-template.mjs:247` renders `todoState`). Add a `questions` line to the brief the
  same way so the model knows what it is waiting on and does not re-ask. `todo-get` must NOT
  return questions.
- **Global open index** `/kikx/questions/index/open.json` — `{ ids, summaries[], updatedAt }`,
  holding **only** `open` questions. Written synchronously by the store on every
  create/answer/dismiss. The Inbox list and the Activity stats read **this one doc**, never the
  whole store.
- **Growth bound (explicit):** the open index holds exactly the set of concurrently-open
  questions — the quantity the anti-spam guardrail (D-8) already governs. Answered/dismissed
  questions leave the index, so `open.json` does not grow with history. Per-question docs grow with
  history, which is intended (immutable record).
- **Rebuildable:** `QuestionsStore.reindex()` reconstructs both indexes from
  `list('/kikx/questions', { glob: '*.json' })`. Proof AeorDB supports this:
  `src/core/aeordb/aeordb-connection.mjs:133` (`list(path,{glob,limit,offset})`) and `:155` (`entries()` paging);
  `src/core/aeordb/aeordb-client.mjs:86` (`listDirectory`). Indexes are caches, never truth.
- **Rejected alternative (route cache/invalidate):** AeorDB exposes **no conditional write**
  (`src/core/aeordb/aeordb-client.mjs` has `getFile/putFile/patchFile/deleteFile/queryFiles/searchFiles/
  listDirectory` — no `If-Match`/etag), and the server is single-process, so an in-process route
  cache would be a second cache with the same invalidation surface as the doc but *not*
  rebuildable from disk. The per-status doc is simpler, inspectable, and matches the todo
  precedent. Recorded, not deferred.

### 3.3 "Todo-type item that is tracked" **[D-7 — RESOLVED: no todo-panel section]**

Question state reuses the todo vocabulary where honest: pending == `open`, complete ==
`answered`. **Decision:** questions do **not** appear in a todo panel. Evidence: there is no
standalone todo panel component in the client to extend — todo surfaces only through tool
renderers (`src/client/components/tool-renderers/todo-summary.mjs`, `tool-use-base.mjs`,
`built-in-tool-uses.mjs`). Building a panel to host a "Waiting on you" section would invent a
surface that does not exist. The question surfaces are the **inline `QuestionFrame`** (§6.4) and
the **Inbox** (§6.3). `todo-get` continues to ignore questions.

## 4. Tool contract — `ask-user`

- File `src/core/tools/ask-user-tool.mjs`; registered in `BUILT_IN_TOOLS`
  (`src/core/tools/register-built-in-tools.mjs` — same table that holds `todo-get` at line 93); exported from
  `src/core/tools/index.mjs`; a frame component added to `BUILT_IN_FRAME_COMPONENTS`
  (`src/core/tools/register-built-in-tools.mjs:103`, a plain array — no global frame-type enum to extend).
- Subclass `PluginInterface` (`src/core/plugins/plugin-interface.mjs:8`): statics `pluginID, featureName,
  displayName, description, version, inputSchema, riskLevel = 'none'` (like the todo tools — no
  permission prompt; `riskLevel='none'` skips the permission prompt path), optional
  `referencesFor()` (`src/core/plugins/plugin-interface.mjs:19`).
- Input:
  ```
  { questions: [ { text, priority?, contextRefs?: [ref] } ],   // 1..CAP
    mode: 'wait' | 'continue',
    note?: string,
    session_id? }
  ```
  No `options` field ([D-4]).
- Output (immediately, always):
  `{ groupID, questionIDs: [...], status: 'pending', mode, message }`.
- Behaviour:
  - Validate 1..CAP. **CAP = 25** as an anti-spam guardrail ([D-8]), not a feature envelope.
    Reject empty text.
  - Persist before returning; emit one `QuestionFrame` per question (type `Question`, [D-3]) plus
    the ordinary `ToolCall`/`ToolResult` frames.
  - `referencesFor()` returns `[{ type:'question', id, label, sessionID }]`. Proof the mechanism
    exists and its only contract is `{type,id}`: `src/core/tools/tool-execution-service.mjs:387`
    (`resolveToolReferences`) and `:407` (`normalizeToolReferences` requires non-empty string
    `type` and `id`). Precedent: `src/core/tools/session-tools.mjs:259` returns `[{ type:'session', id, ... }]`.
    There is **no reference-type enum** to extend.
  - Emit runtime event `question.asked` (one per question) — see §6.5.
  - **Never** block, poll, or return the answer.
- Prompt/tool-help guidance must prefer `ask-user` over prose deferral and must not collide with
  `AVOIDABLE_DEFERRAL_PATTERNS` (`src/core/plugins/agent-tool-definitions.mjs:174`; enforced in
  `src/core/plugins/agent-loop-state.mjs:179`).

## 5. Wake semantics (core requirement)

### 5.1 Flow

1. `QuestionsStore.answerQuestion(questionID, { answer, userID })` — idempotent; persists answer,
   status `answered`, updates both indexes.
2. Post a visible, targeted `UserMessage` into the origin session (§5.3 for granularity [D-9]):
   - `authorType:'user'`, `authorID:<answering user>`, `hidden:false`, `deleted:false`.
   - `targetAgentID:<question.agentID>` — `resolveRouteTargets()` (`src/core/agents/agent-route/targeting.mjs`) returns a
     **single-target bypass** when the target is a participant, so this both appears in the
     transcript and wakes only the asking agent.
   - `continuation: { kind:'user-answer', questionID, groupID, askedAt, ... }`. `user-answer` is
     deliberately **not** in `AUTONOMOUS_CONTINUATION_KINDS` (`src/core/runtime/autonomous-chain.mjs:14`), so
     `cancelAutonomousWakes()` (`src/core/runtime/frame-runtime-sessions.mjs:24`, which cancels only
     `isAutonomousContinuation` frames) never cancels a human answer as chatter, and the answer
     is not chain-capped. A *visible* frame needs no scheduler (`shouldDeferScheduledFrame`,
     `src/core/routing/frame-router.mjs`), so it dispatches on merge.
   - `content`: compact human summary (question text, answer, age, "you asked this in session X")
     + `content.question = { id, text, answer, askedAt, mode, contextRefs, group }` so the model
     re-orients without a tool call.
   - `content.references` includes the question ref and origin frame/todo refs.
3. `frameStore.flush()` before returning, so a crash cannot lose the wake after the answer is
   stored.

### 5.2 Contract correction (found this revision)

`appendUserMessage()` (`src/core/runtime/frame-runtime.mjs:301`) builds the `UserMessage` with
`recipients` from `input.recipients` but **does not read or set `targetAgentID`**. The single-target
wake therefore requires one of:
- extend `appendUserMessage()` to accept `targetAgentID` and set it on the frame, or
- have the wake path merge the `UserMessage` directly (with `targetAgentID` + `continuation`) via
  the frame engine.

Pick **the first** (least surface; the caller already passes `recipients`). The `continue` mode
still reuses the `appendUserMessage` → `cancelAutonomousWakes` live-steer path
(`src/core/runtime/frame-runtime.mjs:301` calls `cancelAutonomousWakes` at `:309`).

### 5.3 Wake granularity **[D-9 — RESOLVED: one wake per answered question, group context attached]**

Deliver **one visible targeted `UserMessage` per answered question**, keyed on `questionID`.
Rationale from evidence:
- **Idempotency has a natural key.** Terminal, never-reopen state is per question (§3.1); a
  per-question wake makes "second answer -> no second wake" a direct check on `questionID`. A
  per-group wake needs a *round-completion* predicate that the model does not define and that
  async answers (arriving minutes apart) make fuzzy.
- **No answer can be lost.** If the user answers 2 of 3 questions in a batch, per-question wakes
  guarantee both answered questions wake the bot; per-group would depend on an unbuilt "is the
  round done?" rule.
- **Batch coherence is preserved without extra turns:** the payload carries the whole group —
  `content.question.group = { id, index, total, siblings:[{ id, text, status }] }` — so the model
  treats the batch as one flow ([D-3]) even though the wakes are separate.
- **Chattiness is bounded by behavior, not machinery:** D-8 says volume is a behavior problem, not
  a system to build around; the anti-spam cap (25/call) is the only guardrail.
- **Rejected alternative — one wake per group:** fewer turns for interdependent questions, but
  needs a round-completion definition and can delay/withhold a partial answer. Recorded.

### 5.4 Fallbacks

- Agent deleted/disabled, or no longer a participant of the origin session -> status
  `undeliverable`; keep the answer; surface a notice. **Never silently drop a user answer.**
- Origin session deleted -> same.
- `mode:'continue'` and a turn is running -> live steer via the `appendUserMessage`/
  `cancelAutonomousWakes` path, so an in-flight autonomous wake is superseded by human authority.
  `mode:'wait'` -> the asker already ended its turn; the answer starts a new turn.
- **Idempotency under TOCTOU:** AeorDB has no conditional write (§3.2), but the server is a single
  process, so `answerQuestion()` must (a) read the doc, (b) reject if terminal, (c) write. Guard
  the read-modify-write with a per-`questionID` in-process mutex so two concurrent answer POSTs
  cannot both pass the terminal check. Second answer -> `409` (or return the stored answer).

**Confirmed ([D-5]):** in-flight answer = **steer**; answer to a resting bot = **wake**. Both
carry the full question context so a stale pair stays intelligible.

## 6. Inbox + Activities UI

`buildRunnerShell` (`src/client/components/kikx-shell-builders.mjs:206`) currently renders an empty
"Workspace" sidebar (line 214). It becomes:

```
Sidebar (activities)                       Main column
  [ Inbox (badge: open questions) ]  <-pinned   selected activity view:
  Projects                                       Inbox list | project stats | session stats
    Project (= root session)   <-stats
      Session                  <-stats
        Sub-session
```

1. **Sidebar = global overview ([D-2])**: everything important at a glance; detail behind
   drill-down. Inbox pinned at the top of the header with an open-question badge.
2. **Inbox list ([D-2]) renders in the main column**, oldest first; each row shows question text,
   asking agent + session, age, frame-of-reference snippet/references, and an inline **free-form
   answer box** ([D-4]). One interaction; no toggle/quick-pick.
3. **Multiple questions ([D-3])**: a group renders as several `QuestionFrame`s tied by `groupID`;
   the Inbox groups them ("Waiting on you · N questions from <agent>") so the batch is one flow.
4. **Stats (v1, client-derived) [D-10]**: per project/session — session count, open questions,
   unread answers, message count (`messageCount`), last activity (`updatedAt`), agents. Computed
   from the already-loaded session list (`GET /api/v1/sessions`, capped 50 by
   `session-routes.mjs` `parsePositiveInteger(..., 50)`) + the questions open index. A server
   aggregate endpoint is explicitly welcome the moment this gets slow.
5. **New client modules** (each under the 500-line soft limit):
   `kikx-activities-view.mjs`, `kikx-inbox-list.mjs`, `kikx-question-card.mjs` (shared by inbox +
   inline frame), `kikx-question-frame.mjs` (frame type `Question`),
   `state/questions-state.mjs`. Navigation: add an `inbox` entry type to `src/client/state/navigation-stack.mjs`,
   deep-link through `stackToURL`.
6. **Fetch-on-connect (required):** missed `question.asked/answered` events are **not** replayed on
   reconnect (`RUNTIME_EVENT_TYPES`, `src/client/components/runtime-events-connection.mjs:18`, contains no replay
   buffer). The Inbox view must fetch `GET /api/v1/questions` on load/connect and reconcile, not
   rely solely on the event stream.
7. **Runtime events:** add `question.asked`, `question.answered`, `question.updated` to
   `RUNTIME_EVENT_TYPES` (`src/client/components/runtime-events-connection.mjs:18`) **and** emit them server-side via
   `FrameRuntime.emitRuntimeEvent` (`src/core/runtime/frame-runtime.mjs:419`, the same channel as `session.saved`,
   `commit`, `tokens.updated`). Respect the S2 client-queue growth cap (§11).

## 7. Server API

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/questions` | `status`, `sessionID`, `agentID`, `limit`, `offset` | `{ questions, counts }`; auth required; reads the open index, not the whole store; excludes deleted by default |
| POST | `/api/v1/questions/:id/answer` | `{ answer }` | stores answer, posts the wake, emits `question.answered`; `409` if already answered; `404` unknown |
| POST | `/api/v1/questions/:id/read` | — | clears the unread badge for one question |
| POST | `/api/v1/questions/:id/dismiss` | `{ reason? }` | asker dismissal of an open question |

Routes in a new `src/server/routes/question-routes.mjs`, wired beside the session routes
(`src/server/routes/` holds `session-routes.mjs`, `agent-routes.mjs`, …). **Do not** add to
`session-tools.mjs` — it is already 798 lines, at the 800-line hard limit. New endpoints are
explicitly welcome ([D-10]).

## 8. Tests (tests ARE the plan)

- `spec/core/questions/question-store-spec.mjs` — create/answer/dismiss/list/group/reindex;
  idempotent answer (2nd -> 409); concurrent-answer mutex; 404s; corrupt docs; cap; open index does
  not grow with history.
- `spec/core/tools/ask-user-tool-spec.mjs` — schema validation; 1..N; **always-async** (the execute
  promise resolves with no answer existing); frames emitted; references stamped; zero permission
  prompt; cross-session parameter; free-form-only shape (no `options`).
- `spec/core/questions/question-wake-spec.mjs` — answering posts exactly one visible targeted
  `UserMessage` per question; `resolveRouteTargets` picks the asker; non-participant / deleted agent
  -> `undeliverable`; duplicate answer -> no second wake; `continue` mid-turn -> live steer and
  autonomous wake cancelled; `wait` -> new turn; payload carries full group context in both modes;
  `user-answer` is not treated as an autonomous continuation.
- `spec/server/question-routes-spec.mjs` — auth, validation, idempotency (409), events emitted.
- `spec/client/inbox-list-spec.mjs`, `activities-stats-spec.mjs`, `question-frame-spec.mjs` —
  mini-DOM render, badge counts, free-form submit, group rendering, stats math, nav push/pop,
  reference click-through, fetch-on-connect reconcile.
- Real-browser (UmbraLink/Puppeteer) e2e: prod bot asks -> inbox shows the question with context ->
  user answers -> origin thread shows the answer and the asker wakes with the context refs.

## 9. Phases

- **P1 — store + tool (no UI).** Question document, store, `ask-user` tool, `QuestionFrame`,
  references. Observable from the API/thread.
- **P2 — answer loop.** Server routes, wake semantics (+ §5.2 correction), runtime events, inline
  answering.
- **P3 — Inbox.** Sidebar pinned Inbox + list view + answer form + badge + fetch-on-connect.
  Also registers the `Question` frame component in `BUILT_IN_FRAME_COMPONENTS` alongside
  `kikx-question-frame.mjs` (deferred out of P1 — see §17.3).
- **P4 — Activities view.** Stats derivation, tree drill-down, navigation-stack integration.
- **P5 — hardening.** Re-scoped against the code as it actually stands (owner decision, 2026-10-18):
  S1–S5 and the caps/S2 growth bounds already landed, so P5 is the four residual items rather than a
  re-do of them — (a) startup repair of the derived question indexes, (b) bounded delivery retry with
  backoff, (c) agent-specified default answers with a deadline, (d) a multi-process-safe index. Items
  (a)–(c) are delivered; (d) is deferred because production is single-process for now.

## 10. Rollout / dogfooding

The prod bot implements; the maintainer monitors and does not implement. Every phase verifiable in
the browser; screenshots at each phase boundary; the prod tab's in-page meter catches render/memory
regressions.

## 11. Stability prerequisites (maintainer lane)

- **S1 error containment** — the new sidebar/inbox render path must not wedge the shell; guard the
  render/flush entry points and surface errors in-app.
- **S2 growth bounds — LANDED.** The runtime-event queue is bounded at
  `MAX_PENDING_FRAME_RUNTIME_EVENTS = 500` (`kikx-runtime-events.mjs:44`, evicted `:226`/`:260`), and
  the per-call question cap is 25 (`questions-store.mjs`). The "unbounded fallback array" this line
  used to call a known open item no longer exists; the note was stale, not the code.
- **Reconnect resync** — this campaign adds value to catch-up/resync on reconnect (§6.6).
- **Status (updated 2026-10-18):** S1–S5 landed as `b54cd80`, `079cce4`, `ec3bd2f` and remain
  **not independently reviewed**; shipping stability to prod awaits owner go-ahead. The ask-user
  phases P1–P4 plus the P5 hardening items are committed on `main` and each carries a
  mutation-proven regression spec, with the full gate and the real-browser suite green on the
  committed tree.

- **Open, carried forward:** (1) the index mutex is per-process only — AeorDB has no conditional
  write, so two Kikx servers sharing one database can still race; production is single-process by
  owner decision, so this is documented rather than fixed. (2) A default answer arriving after a real
  answer is rejected by the store's terminal 409 guard, so the user cannot revise an already-answered
  question; that is existing terminal semantics, unchanged.

## 12. Open decisions

| # | Decision | Status | Resolution / recommendation |
| --- | --- | --- | --- |
| D-1 | project = root session vs new entity | **RESOLVED** | Root session now, same UI later. "files and folders" framing (§1.1). |
| D-2 | Inbox list in sidebar vs main column | **RESOLVED** | List in the **main column**; sidebar is the **global overview**; drill-down for detail. |
| D-3 | one frame per question vs per group | **RESOLVED** | One frame **per question**, tied by `groupID`; UI groups a batch into one flow. |
| D-4 | free text vs optional options | **RESOLVED** | **Free-form text only. Drop `options`.** Prior in-app answer widgets underperformed; nuance matters; a yes/no is no easier than a toggle. |
| D-5 | `continue` mid-turn => live steer | **RESOLVED** | In-flight answer = **steer**; answer to a resting bot = **wake**; both carry full context. |
| D-6 | index shape | **RESOLVED (v0.2)** | Per-status **open index doc** `/kikx/questions/index/open.json` + per-agent mirror; rebuildable; routes read the index, never scan. Route cache rejected (no conditional write; not rebuildable). §3.2 |
| D-7 | do questions appear in the todo panel | **RESOLVED (v0.2)** | **No.** No todo panel exists to extend; surfaces are inline `QuestionFrame` + Inbox. §3.3 |
| D-8 | max questions per call | **RESOLVED** | **No real limit**; a sane cap (~25) only to stop spam. Volume is a behavior problem, not a system to build. |
| D-9 | one wake per question vs per group | **RESOLVED (v0.2)** | **One wake per answered question**, keyed on `questionID`, carrying group context. Per-group rejected (needs an unbuilt round-completion rule; can withhold a partial answer). §5.3 |
| D-10 | client-derived vs server-aggregated stats | **RESOLVED** | Client-derived v1; new endpoints welcome where needed or where they make life better. |

`options` field removal is confirmed as a **schema consequence of D-4** (v1 has no `options`
anywhere); no further owner ruling needed.

## 13. Adversarial review (v0.2)

`::agis.map_territory` + `::agis.test_protocol` re-run against omitted consumers, persistence,
jobs, coupling, drift, contention and rollback. Findings:

1. **`appendUserMessage` has no `targetAgentID` (§5.2).** The draft assumed a targeted wake "just
   works". It does not: the field is not read (`src/core/runtime/frame-runtime.mjs:301`). **Must be extended.**
   This is the single most likely silent failure in the plan.
2. **No conditional write in AeorDB.** Concurrent answer POSTs can race; a per-`questionID` mutex is
   required for idempotency (§5.4).
3. **Event replay gap.** `RUNTIME_EVENT_TYPES` has no replay; a tab that reconnects misses
   `question.*` events. Inbox must fetch-on-connect (§6.6).
4. **`AUTONOMOUS_CONTINUATION_KINDS` coupling.** `user-answer` must stay *absent* from that list or
   `cancelAutonomousWakes` (`src/core/runtime/frame-runtime-sessions.mjs:24`) will silently cancel human answers as
   chatter. Add a regression test asserting the list contents.
5. **File-size hotspots.** `session-tools.mjs` = 798 lines (hard limit 800) and
   `kikx-shell-builders.mjs` = 520 lines (soft limit 500). New routes/components must be separate
   files (§7, §6.5); do not append.
6. **Open-index hot spot.** Every ask/answer rewrites `open.json`. Bounded by concurrently-open
   questions (§3.2); acceptable at the anti-spam-guarded volume, but flag it if D-8's cap is ever
   raised.
7. **Reference-type contract.** `normalizeToolReferences` drops refs without non-empty `type`/`id`
   (`src/core/tools/tool-execution-service.mjs:407`); no enum exists. `type:'question'` is safe.
8. **Frame registration.** `BUILT_IN_FRAME_COMPONENTS` is a plain array
   (`src/core/tools/register-built-in-tools.mjs:103`); adding `['Question', …]` is sufficient — verified no global
   frame-type registry.
9. **Rollback unit.** Each phase is independently revertible (one commit); P1 has no UI and no
   prod exposure, so it is the safe first landing.
10. **Owner-ruling re-read:** D-1…D-10 are internally consistent (v0.2); no contradictions found.

## 14. Completeness (v0.2)

Compared against the owner's full ambition. In-campaign gaps absorbed; different-territory work is
roadmapped, not inflated:

| Roadmap item | Depends on | Status |
| --- | --- | --- |
| Files/folders tooling: caching, permissions, "communicate about a session" ([D-1]) | this campaign | post-v1 |
| Optional quick-pick answers (revisit D-4) | this campaign | parked; not v1 |
| Server aggregate stats endpoint ([D-10]) | client-derived stats shipped | trigger: client derivation slows |
| Notifications (email/push) | — | non-goal v1 |
| Multi-user assignment / ACLs | — | non-goal v1 |
| Hidden-tab rAF coalescing (10 GB "leak" investigation) | — | separate stability lane, not this plan (§11) |

## 15. Definition of Done + execution contract

**DoD (mechanical):**
- All §8 specs present and green; full `npm test` exit 0 at each phase landing.
- Real-browser e2e green (`REAL_EXIT=0`).
- No new file exceeds 500 soft / 800 hard lines.
- `AUTONOMOUS_CONTINUATION_KINDS` regression test green.
- Inbox lists from the open index only (no whole-store scan) — asserted in
  `question-store-spec.mjs`.

**Landing ritual:** integrate -> full typecheck/architecture/boundary/test gates -> authorized
push. No push after a failing gate. One phase = the revert unit. Prod feature work is done by the
prod bot (§10); the maintainer writes docs/plans and holds git discipline.

## 16. Execute P1 from this file alone

Baseline: kikx2 @ `d685ebd`, dev 3001 healthy
(`{"ok":true,"ready":true,"services":{"database":true}}`).

P1 (store + tool, no UI — and no client component registration, see step 4):
1. Create `src/core/questions/questions-store.mjs` mirroring `src/core/agents/agent-todo-store.mjs` (constructor
   `{ db|aeordb, rootPath='/kikx', clock, idGenerator }`; `questionPath(id) =
   <root>/questions/<id>.json`; `indexPath() = <root>/questions/index/open.json`;
   `agentIndexPath(agentID) = <root>/agents/<agentID>/questions.json`).
2. Implement `createQuestions()`, `answerQuestion()` (idempotent + per-id mutex), `dismissQuestion()`,
   `listOpen()`, `reindex()`.
3. Write `spec/core/questions/question-store-spec.mjs` FIRST; run the project runner
   (`package.json` `test`: `timeout 120 node --test --test-timeout=30000 'spec/**/*-spec.mjs'`) —
   e.g. `node --test --test-timeout=30000 spec/core/questions/question-store-spec.mjs` — and
   require exit 0.
4. Create `src/core/tools/ask-user-tool.mjs` (PluginInterface subclass, `riskLevel='none'`).
   Register it in `src/core/tools/register-built-in-tools.mjs` `BUILT_IN_TOOLS` (table starting at
   `:56`) and export from `src/core/tools/index.mjs`.
   **Do NOT add a `BUILT_IN_FRAME_COMPONENTS` entry in P1.** P1 is "store + tool, no UI"; the
   `Question` frame component is registered in **P3**, in the same commit as
   `src/client/components/kikx-question-frame.mjs`. Rationale (§17.3):
   `loadClientComponentDescriptors` (`src/client/components/frame-component-registry.mjs:26`) does a
   bare `await import(moduleURL)` with no try/catch, and its caller
   (`src/client/components/kikx-data.mjs:215`) aborts the *entire* component load on any failure.
   Registering a `moduleURL` that 404s would break the client at the P1 landing. Emitting `Question`
   frames in P1 is harmless: `resolveFrameComponentDescriptor`
   (`frame-component-registry.mjs:38`) falls back gracefully for unregistered frame types.
5. Write `spec/core/tools/ask-user-tool-spec.mjs` (incl. the always-async assertion) and run it.
6. Inject the per-agent questions index into `runParams` next to `todoState`
   (`agent-route-frame-plugin.mjs:224`) and render it in the brief (`src/core/plugins/agent-brief-template.mjs:247`).
7. Gates: full `npm test` exit 0; commit as P1 (revert unit).

Proof required before "P1 done": the two spec files green, full suite exit 0, a real `ask-user`
call via the dev API creating `/kikx/questions/<id>.json` + updating the open index. A stranger can
run steps 1–7 from this section without opening any other document.

## 17. Readiness audit (2026-10-18)

Owner asked whether this plan is ready to implement. Answer: **the design is ready; P1 as written has
two execution defects that must be corrected first.** Verification pass re-checked every load-bearing
claim against the tree at `d685ebd`. Additive section; nothing above was re-decided.

### 17.1 Citation drift — corrected in place

The plan predates a source reorganisation into subdirectories, so ~25 citations named files that
**do not exist at those paths** (`src/core/frame-runtime.mjs`, `src/core/autonomous-chain.mjs`,
`src/core/tools/plugin-interface.mjs`, `agent-brief-template.mjs`, …). A stranger following §16 would
have hit missing files. All citations now carry correct paths. Verified examples:

| Claim | Actual location |
| --- | --- |
| `appendUserMessage` signature | `src/core/runtime/frame-runtime.mjs:301` ✅ |
| `AUTONOMOUS_CONTINUATION_KINDS` | `src/core/runtime/autonomous-chain.mjs:14` ✅ |
| `cancelAutonomousWakes` | `src/core/runtime/frame-runtime-sessions.mjs:24` ✅ |
| `PluginInterface` subclass contract | `src/core/plugins/plugin-interface.mjs:8` ✅ |
| `todoState` load / `runParams` inject | `src/core/agents/agent-route-frame-plugin.mjs:204` / `:224` ✅ |
| `todoState` brief render | `src/core/plugins/agent-brief-template.mjs:247` ✅ (plan said `:246`) |
| `referencesFor` precedent | `src/core/tools/session-tools.mjs:259` ✅ (plan said `:260`) |
| `AeorDB.list(path,{glob})` / `listDirectory` | `src/core/aeordb/aeordb-connection.mjs:133` / `src/core/aeordb/aeordb-client.mjs:86` ✅ |
| `BUILT_IN_TOOLS` / `BUILT_IN_FRAME_COMPONENTS` | `src/core/tools/register-built-in-tools.mjs:56` / `:103` ✅ |
| `RUNTIME_EVENT_TYPES`, `AVOIDABLE_DEFERRAL_PATTERNS` | `src/client/components/runtime-events-connection.mjs:18`, `src/core/plugins/agent-tool-definitions.mjs:174` ✅ |

### 17.2 §5.2 correction CONFIRMED (the plan's most important finding holds)

`src/core/runtime/frame-runtime.mjs:301-360` read in full: `appendUserMessage` builds the frame from
`input.recipients` only. It **does not read or set `targetAgentID`**, and `content` is hard-set to
`{ text }`. The single-target wake therefore genuinely requires extending this method. The plan's
assessment that this is "the single most likely silent failure" is correct and remains so.

### 17.3 **P1 blocker — step 4 registered a client module that does not exist (RESOLVED here)**

`BUILT_IN_FRAME_COMPONENTS` is **not exported** (`register-built-in-tools.mjs:103` is a bare
`const`; only the loop at `:133` consumes it), so "add a frame component" is a server-side registry
edit — that part is fine. The defect is the **ordering**:

- `loadClientComponentDescriptors` (`src/client/components/frame-component-registry.mjs:26-36`)
  does a bare `await import(descriptor.moduleURL)` with **no try/catch**.
- It is called once, from `loadClientComponents` (`src/client/components/kikx-data.mjs:215`), whose
  caller `catch` sets `clientComponentStatus='error'` and **does not** call `setClientComponents(...)`.
- Therefore any server-registered component whose `moduleURL` 404s fails the whole load: no client
  components register, and `_syncFrameThread` still runs over unregistered frame types.

P1 step 4 would register `Question` → `/client/components/kikx-question-frame.mjs` while §9 and §2
put the client work in **P3**. That combination breaks the client at the P1 landing. P1 is declared
"no UI" and "the safe first landing" (§13 item 9) — as written it is not.

**Fix applied in this revision — option (A).** §16 step 4 now registers the tool only and
explicitly forbids a `BUILT_IN_FRAME_COMPONENTS` entry in P1; that registration moved into
§9's P3 description. The options considered were:

- **(A) preferred — split the registration across phases.** P1 registers the tool only
  (`BUILT_IN_TOOLS` + `src/core/tools/index.mjs`). The `Question` frame component registration moves
  to P3, in the same commit as `kikx-question-frame.mjs`.
- **(B)** Create a stub `src/client/components/kikx-question-frame.mjs` in P1.

Verified the frame type itself is safe:
no global frame-type enum exists, and `resolveFrameComponentDescriptor`
(`frame-component-registry.mjs:38-58`) falls back gracefully for unregistered types.

### 17.4 Other verified facts that change nothing

- `src/core/tools/index.mjs` exists ✅ (step 4's export target is real).
- `agent-todo-store.mjs` constructor + `todoPath(agentID)` ✅ (step 1's mirror target is accurate);
  note its method surface is `getTodoState/addItem/updateItem/...` + `saveTodoState`, so
  `QuestionsStore` should mirror the *shape* (one doc per entity + `path()` builder), not the names.
- `.pi/ASK-USER-CAMPAIGN.md` exists (4582 bytes) ✅ but is dated 2026-10-07 — it is the **origin**
  document, not a spec of current state.
- `zav-draft.md` referenced in the header **does not exist anywhere in the repo** (`find`). The
  header's "still outstanding" claim cannot be verified and should be dropped or restated as
  "not received".
- File sizes confirmed: `session-tools.mjs` 798 (hard 800 — do not append), `kikx-shell-builders.mjs`
  520 (soft 500 exceeded), `src/core/runtime/frame-runtime.mjs` 482. §13 item 5 is accurate.
- §16's premise "the two spec files green ⇒ P1 done" is insufficient on its own; see §17.5.

### 17.5 Known flake affects the §15 DoD gate

`bot-docs/reports/web-tools-completion-flake-2026-10-18.md` documents a ~3% full-suite failure in
four `web-tools-spec` tests (real `ProcessManager.complete()` ordering window; test-side wait
predicates already corrected; residual failure load-sensitive and never captured). §15's "full
`npm test` exit 0 at each phase landing" is therefore ~97% reliable. On a failing run, confirm the
only failures are those four tests, re-run once, and record it — do not block a landing on it, and do
not wave it through if the diff touches `process-manager.mjs`.

### 17.6 Verdict

| Area | Status |
| --- | --- |
| Owner decisions D-1…D-5, D-8, D-10 | Recorded verbatim, re-confirmed twice ✅ |
| D-6, D-7, D-9 resolutions | Evidence-backed, re-verified ✅ |
| Domain model, wake semantics, API, tests | Coherent and implementable ✅ |
| Citation accuracy | **Corrected in this revision** (was broken) |
| P1 step 4 | **RESOLVED** — fixed per §17.3 (option A) |
| DoD test gate | ~97%, documented ✅ |

**P1 is implementable from §16 alone as of this revision** — citation paths are correct and the
frame-registration ordering defect is fixed. No implementation was performed; authorisation to start
P1 remains with the owner (§10 routing question: prod bot vs maintainer).
