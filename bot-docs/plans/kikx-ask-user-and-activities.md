# Plan: `ask-user` tool, Questions table, and the Activities view

> **STATUS: DRAFT v0 (assistant).** Written by the stability maintainer as the first half of a
> joint plan. The Production Kikx bot writes `kikx-ask-user-and-activities.zav-draft.md` in
> response; this file is then merged and becomes the implementation contract the prod bot
> executes. Sections marked **[D-N]** are open decisions — see §12.

Owner request (verbatim intent) — see `.pi/ASK-USER-CAMPAIGN.md` for the full quote.

## 1. Goals

1. **`ask-user` tool**: any agent can ask the user an ordered array of one or more questions.
   Always asynchronous — the tool never blocks the turn.
2. **Questions are first-class, durable entities** ("their own table"), tracked todo-style:
   they have an id, text, state, timestamps, and they show up anywhere a tracked item does.
3. **Answers wake the asker** in the *originating* session, carrying the original question and
   **references** to the original context (frames, todo items, documents), so a bot that asked a
   long time ago can re-orient.
4. **Inbox**: a pinned item at the top of the left sidebar header listing every question awaiting
   the user, each with its original frame of reference, answerable in place.
5. **Activities view**: the left sidebar becomes an activities/navigation tree with quick stats
   (projects -> sessions -> sub-sessions), drillable.

## 2. Non-goals (v1)

- No new project/folder entity (see [D-1]); no session re-parenting UI.
- No multi-user assignment, ACLs, or notifications (email/push) — in-app only, single-user product.
- No synchronous/blocking question variant. Ever.
- No question editing after asking (text is immutable; the asker may dismiss an unanswered one).
- No server-side stats warehouse; v1 stats are derived from existing manifests + the questions
  index (see §8).

## 3. Domain model

### 3.1 Question document

Collection `kikx/questions/`, one document per question:
`/kikx/questions/<questionID>.json` (`questionID` a uuid; `groupID` a uuid per `ask-user` call).

```
{
  id: uuid,
  groupID: uuid,                 // one ask-user call == one group
  index: 0,                      // position within the group
  status: 'open' | 'answered' | 'dismissed' | 'undeliverable',
  mode: 'wait' | 'continue',     // the asker's choice at ask time

  // --- origin (the frame of reference) ---
  sessionID,                     // origin session (visible thread)
  agentID,                       // asking agent (the wake target)
  interactionID,
  frameID,                       // the AgentMessage being produced
  toolCallFrameID, toolOutputID, // the ToolCall / ToolResult frames
  todoIDs: [ ],                  // the asker's focused todo ids at ask time
  focusAtAsk: string|null,
  contextRefs: [ { type, id, label, sessionID?, frameID?, path? } ],

  // --- content ---
  text: string,                  // the question
  options: [ string ],           // optional suggested answers (quick-pick)
  priority: 'low'|'normal'|'high',

  // --- answer ---
  answer: string|null,
  answeredAt, answeredClock, answeredByUserID,
  answerFrameID,                 // the visible UserMessage posted into the origin session
  dismissalReason: string|null,

  // --- bookkeeping ---
  askedAt, askedClock, createdAt, updatedAt,
  readAt,                        // inbox read/unread (badge)
  deleted: boolean
}
```

Status transitions: `open -> answered | dismissed | undeliverable`. Terminal states never reopen;
the answer path must be idempotent (a second answer is a 409, or returns the stored answer unchanged).

### 3.2 Indexes

- `/kikx/agents/<agentID>/questions.json` — mirrors `agent-todo-store.mjs`'s
  `/kikx/agents/<id>/todo.json`: the agent's own open/answered questions, injected into
  `runParams` per turn like `todoState` so the model knows what it is still waiting on and does
  not re-ask.
- Listing for the inbox must not scan the whole store on every render: the store keeps a
  per-status index document (e.g. `/kikx/questions/index/open.json` holding ids + summaries) or
  the server route caches+invalidates. **[D-6]** — see risks.
- Answers are also mirrored into the origin session's frames (§5), so the transcript is the
  durable record even if an index is lost. Indexes are rebuildable caches, never truth.

### 3.3 "Todo-type item that is tracked"

Question state reuses the todo vocabulary where it maps: pending == `open`, complete ==
`answered`. `todo-get` should not return questions, but the *UI* shows both in the same tracked
slot (todo panel gains a "Waiting on you" section, or the question frame is enough on its own).
**[D-7]**

## 4. Tool contract — `ask-user`

- File: `src/core/tools/ask-user-tool.mjs`, registered in `BUILT_IN_TOOLS`
  (`register-built-in-tools.mjs`), exported from `src/core/tools/index.mjs`, plus a frame
  component in `BUILT_IN_FRAME_COMPONENTS`.
- Subclass `PluginInterface` (`src/core/plugins/plugin-interface.mjs`): statics `pluginID`,
  `featureName`, `displayName`, `description`, `version`, `inputSchema`, `riskLevel = 'none'`
  (like todo tools — no permission prompt), optional `referencesFor()`.
- Input:
  ```
  {
    questions: [ { text, options?: [string], priority?, contextRefs?: [ref] } ],  // 1..N
    mode: 'wait' | 'continue',
    note?: string                     // optional preamble shown once above the group
  }
  session_id?                         // standard cross-session parameter
  ```
- Output (immediately, always):
  ```
  { groupID, questionIDs: [...], status: 'pending', mode, message: '...' }
  ```
- Behaviour:
  - Validate 1..MAX questions per call (cap, [D-8]); reject empty text.
  - Persist the questions (durable, before returning).
  - Emit one `QuestionFrame` per question (type `Question`, [D-3]) plus the ordinary
    `ToolCall`/`ToolResult` frames.
  - `referencesFor()` stamps `content.references` with `[{ type:'question', id, label,
    sessionID }]` and the origin frame references, so the existing reference click-through path
    navigates back.
  - Emit runtime events `question.asked` (one per question).
  - **Never** block, never poll, never return the answer.
- Prompt/tool-help guidance must be updated so the model prefers `ask-user` over deferring in
  prose, and must not collide with `AVOIDABLE_DEFERRAL_PATTERNS`.

## 5. Wake semantics (the core requirement)

When the user answers question(s) (inbox, inline frame, or any future surface):

1. `QuestionsStore.answerQuestion(questionID, { answer, userID })`
   - idempotent, persists answer + status `answered`, updates both indexes.
2. Post **one visible, targeted `UserMessage`** into the origin session per answered question
   (or one per group — [D-9]):
   - `authorType: 'user'`, `authorID: <answering user>`, `hidden: false`, `deleted: false`
   - `targetAgentID: <question.agentID>` — `resolveRouteTargets` treats an explicit target as a
     single-agent bypass *when the target is a participant* (`targeting.mjs:63`), so this both
     appears in the transcript **and** wakes the asking agent.
   - `continuation: { kind: 'user-answer', questionID, groupID, askedAt, ... }` — a **new
     continuation kind** that is deliberately *not* in `AUTONOMOUS_CONTINUATION_KINDS`
     (a human answer is new authority; it must not be chain-capped like autonomous wakes and it
     must not be cancelled as chatter).
   - `content`: a compact human-readable summary (question text, answer, age, "you asked this in
     session X") + `content.question = { id, text, answer, askedAt, mode, contextRefs }` so the
     model sees everything without a tool call.
   - `content.references` includes the question ref and the origin frame/todo refs, so the model
     can `question-get` / `session-frames` / `database-fetch` to rehydrate.
3. Route happens on merge; `frameStore.flush()` before returning, so a crash cannot lose the wake
   after the answer is stored. No scheduler needed for a *visible* frame (only hidden frames need
   `scheduledDispatch`); the durable scheduled queue remains the fallback when the origin session
   is closed and the frame must be posted later.
4. Fallbacks:
   - Agent deleted/disabled, or no longer a participant of the origin session ->
     status `undeliverable`, keep the answer, surface a notice (never silently drop a user answer).
   - Origin session deleted -> same.
   - Turn currently running:
     - `mode: 'wait'` — normal: the asker already ended its turn; the answer starts a new turn.
     - `mode: 'continue'` — the answer must land as a live steer in the running turn. Reuse the
       `appendUserMessage` / `cancelAutonomousWakes` path (`frame-runtime-sessions.mjs:9`) so an
       in-flight autonomous wake is superseded by human authority, and the running turn sees it.

`wait` vs `continue` is an *asker intent*, not a delivery mechanism: both deliver identically when
the turn has ended; they differ only in what the asker promised to do while waiting, and in the
guidance the tool result gives ("end your turn now" vs "you may keep working; the answer can also
arrive mid-turn"). The tool result text is what the model acts on.

## 6. Inbox + Activities UI

`buildRunnerShell` (`src/client/components/kikx-shell-builders.mjs:113`) currently renders an empty
"Workspace" sidebar. It becomes:

```
Sidebar (activities)
  [ Inbox  (badge: open questions) ]        <- pinned, top of header
  Projects
    Project (= root session)                <- quick stats row
      Session                               <- quick stats row
        Sub-session
Main column
  selected activity view: Inbox list | project stats | session stats
```

- **Inbox list**: every `open` (and optionally recently answered) question, oldest first, each row
  showing: question text, asking agent + session, age, original frame-of-reference snippet/references,
  and an inline answer box (+ quick-pick buttons if `options`). Answering is one interaction.
- **Stats (v1, derived client-side)**: per project/session — session count, open questions, unread
  answers, message count (`messageCount` on the manifest), last activity (`updatedAt`), agents.
  Computed from the already-loaded session list + the questions index; no new aggregation endpoint
  in v1. **[D-10]** (server aggregate later if the client derivation gets slow).
- **New client modules** (each under the 500-line soft limit):
  - `src/client/components/kikx-activities-view.mjs`
  - `src/client/components/kikx-inbox-list.mjs`
  - `src/client/components/kikx-question-card.mjs` (shared by inbox + inline frame)
  - `src/client/components/kikx-question-frame.mjs` (frame type `Question`)
  - `src/client/state/questions-state.mjs` (or extend `kikx-state.mjs`)
- **Navigation**: add an `inbox` entry type to `navigation-stack.mjs`; deep-link through the
  existing `stackToURL` mechanism.
- **Runtime events**: add `question.asked`, `question.answered`, `question.updated` to
  `RUNTIME_EVENT_TYPES` (`src/client/components/kikx-runtime-events.mjs`) and reconcile through the
  same batched/queued path as frame events — **and respect the S2 growth cap** (see §11).

## 7. Server API

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/questions` | `status`, `sessionID`, `agentID`, `limit`, `offset` | returns `{ questions, counts }`; auth required; never returns deleted by default |
| POST | `/api/v1/questions/:id/answer` | `{ answer }` | stores answer, posts the wake, emits `question.answered`; 409 if already answered; 404 unknown id |
| POST | `/api/v1/questions/:id/read` | — | clears the unread badge for one question (batched endpoint optional) |
| POST | `/api/v1/questions/:id/dismiss` | `{ reason? }` | asker-only dismissal of an open question (or user "won't answer") |

Routes live in a new `src/server/routes/question-routes.mjs` and are wired in the same place the
session routes are. Events go through `src/server/events.mjs`.

## 8. Tests (tests ARE the plan)

- `spec/core/questions/question-store-spec.mjs` — create/answer/dismiss/list/group/reindex,
  idempotent answer, 404s, corrupt docs, caps, no unbounded growth (ties to S2).
- `spec/core/tools/ask-user-tool-spec.mjs` — schema validation, 1..N, always-async (assert the
  execute promise resolves without any answer existing), frames emitted, references stamped,
  zero permission prompt, cross-session parameter.
- `spec/core/questions/question-wake-spec.mjs` — answering posts exactly one visible targeted
  `UserMessage`; `resolveRouteTargets` picks the asker; non-participant / deleted agent ->
  `undeliverable`; duplicate answer -> no second wake; `continue` mid-turn -> live steer and
  autonomous wake cancelled; `wait` -> new turn.
- `spec/server/question-routes-spec.mjs` — auth, validation, idempotency (409), events emitted.
- `spec/client/inbox-list-spec.mjs`, `activities-stats-spec.mjs`, `question-frame-spec.mjs` —
  mini-DOM render, badge counts, answer submit, stats math, nav push/pop, reference click-through.
- Real-browser (UmbraLink) end-to-end: prod bot asks -> inbox shows the question with context ->
  user answers -> origin session thread shows the answer and the asker wakes with the context refs.

## 9. Phases

- **P1 — store + tool (no UI).** Question document, store, `ask-user` tool, `QuestionFrame`,
  references. Observable end-to-end from the API/thread.
- **P2 — answer loop.** Server routes, wake semantics, runtime events, inline answering.
- **P3 — Inbox.** Sidebar pinned Inbox + list view + answer form + badge.
- **P4 — Activities view.** Stats derivation, tree drill-down, navigation stack integration.
- **P5 — hardening.** Caps/rate limits, error containment (stability S1), growth bounds (S2),
  monitoring, docs.

## 10. Rollout / dogfooding

The prod bot implements; the maintainer monitors and does not implement. Every phase must be
verifiable in the browser; screenshots at each phase boundary; the prod tab carries the in-page
meter so any render/memory regression is caught by the same instrumentation used for stability.

## 11. Stability prerequisites (maintainer's lane, must land with/ before this)

- **S1 error containment** — the new sidebar/inbox render path must not be able to wedge the shell;
  guard the render/flush entry points and surface errors in-app.
- **S2 growth bounds** — the questions index and the runtime-event queue must be capped/pruned;
  `queueFrameRuntimeEvent`'s unbounded fallback array is a known open item.
- Answers arriving while a tab is disconnected must be recoverable — this campaign adds real value
  to the **catch-up/resync on reconnect** item (missed `question.asked/answered` events currently
  are not replayed).

## 12. Open decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D-1 | project = root session vs new entity | root session now, same UI later |
| D-2 | Inbox list renders in sidebar vs main column | main column |
| D-3 | one QuestionFrame per question vs per group | per question, tied by `groupID` |
| D-4 | free text vs optional `options` | text + optional options |
| D-5 | `continue` mid-turn => live steer | yes |
| D-6 | index shape (per-status doc vs route cache) | per-status index doc, rebuildable |
| D-7 | do questions appear in the todo panel | inline frame + inbox is enough |
| D-8 | max questions per call / max open per agent | 10 per call, 50 open, dedupe by text |
| D-9 | one wake message per question vs per group | per group (one answer round = one wake) |
| D-10 | client-derived vs server-aggregated stats | client-derived v1 |
