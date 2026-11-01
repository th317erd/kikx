---
title: Agentic scripts campaign
status: current
doc_type: plan
audience: [developers, maintainers, operators]
applies_to: development-v3
last_verified: 2026-11-01
---

# Agentic scripts campaign

Behavioral scripts (AGIS-flavored) that agents set, view, modify, and follow —
a never-ending coordinator-driven work loop built on Kikx's existing
continuation scheduler.

## 1. Evidence

### Verified machinery (this conversation, source-read)

- `continue-turn` (respond-and-continue): `src/core/plugins/agent-loop-tools.mjs:70-91`;
  posts visible progress frame + schedules continuation carrying `nextAction` payload.
- Scheduler: `src/core/agents/agent-route/agent-route-frame-plugin-base.mjs:395-477`
  (`scheduleAgentContinuation`, `createScheduledAgentContinuationFrame`);
  `delayMs` param accepts 0 or future delay (`agent-tool-definitions.mjs:69-72`).
- Chain backstop: `src/core/runtime/autonomous-chain.mjs` —
  `MAX_AUTONOMOUS_CHAIN_STEPS = 64`; `exceedsChainLimit()` checked at schedule
  time; pause notice, user message resets. Budget-gate seam.
- Coordinator end-turn alert: `src/core/agents/end-turn-notification.mjs`
  (`buildEndTurnNotice`, `notifyCoordinatorOfEndTurn`) — validation obligation
  already posted to nearest coordinator.
- Todos: `src/core/agents/agent-todo-store.mjs` + 9 tools
  (`src/core/tools/todo-tools.mjs`); brief B injects todo + focus every turn;
  `buildAutonomousRunLine` (`agent-brief-template.mjs:227-240`) already labels
  self-scheduled turns "Autonomous run — step N".
- Character clone pattern: field on agent record; `updateAgentCharacter`
  (`agent-manager.mjs:117`); `set-character` loop tool
  (`agent-loop-tools.mjs:362-409`); `agent-create`/`agent-update`
  (`agent-tools.mjs:60,151`); limits in `character-limits.mjs`.
- Token tracking: `src/core/tokens/token-usage-tracker.mjs`;
  `totalTokensUsed()` (`agent-route/usage.mjs:55`) — future budget source.
- Brief injection points: Brief A `Character:` line
  (`agent-brief-template.mjs:139`); Brief B `todo:` line + `control:` inventory
  (`:60,206`); continuation wake prompt (`continuation.mjs:31-40`).

### Baseline

- Unit lane at planning time: 3107 pass / 0 fail / 30 skipped, main `7106d306`.
- AGIS language: `~/Projects/agis/docs/runtime.md` (bounded runtime),
  `docs/spec.md` (normative).

## 2. Frame

**Target.** Per-agent `behaviorScript` (AGIS text) defining a continuous loop:
strokes, todo-keyed selector, fixed terminator, never-ending self-continuation.
Coordinator interprets; workers execute one statement at a time. Library
templates ship first; self-authorship later (clone of character-bio flow).

**Non-goals.** No raw script editor UI; no replacement of end-turn/continue-turn;
no real budget (shell only); no delegation-accountability change; no self-
authorship in v1; no coded AGIS interpreter (model interprets; we ship a
preamble); no shared-memory redesign.

**Success criteria.** (1) Scripted coordinator loops plan→delegate→validate
across turns, halting only via budget/owner-question/completion. (2) Workers get
next-statement injection; todos synced; end-turn `reason` branches. (3) Budget
shell called at schedule gate, returns yes. (4) Four library scripts with
preamble/strokes/selector/terminator. (5) Script settable via
agent-update/set-script; in brief; no UI required. (6) Suite green + new specs.
(7) Never-ending by default.

**Constraints.** Script subordinate to identity (character/participants remain
authoritative); 500/800-line source limits; existing precepts unchanged;
window-time-aware delayMs guidance; plans-only until authorized; payload vs
todo verification on wake.

## 3. Owner decisions (verbatim, 2026-11-01)

- "I am deliberately trying to design an agentic harness _that doesn't stop_,
  by design. The user CAN update the template scripts to make the agent stop
  more often... 'never ending' is exactly what I want."
- "Token usage will be our eventual budgeting system... this is why we already
  track tokens used."
- "Let's have an empty shell of a budgeting system, and simply call a
  'canContinueWithCurrentBudget()' type of function call that always returns
  'yes' for now."
- "Conversation is the best UI" — scripts updated/visualized through the agent,
  never a raw script editor.
- Agent bicycle: todo list is state/pump; script is the process; fixed
  terminator "check next todo; if none, end turn" is always last.
- Authority ruling (2026-11-01, on Q4): "we want the coordinator to be able to
  change itself, and sub-agents (equal to or lower than itself in session
  hierarchy), but to not be able to change stuff for an agent upstream of
  itself. This will allow the coordinator to directly alter the todo lists of
  sub-agents, and their own todo lists, while not allowing sub-agents the
  ability to alter the coordinators (the coordinator has elevated privilege...
  all other bots only have the permission to update their own todo
  lists/data/tools/facts/whatnot)."
- Question stance (2026-11-01): "always go with recommendations... when the
  user responds to your questions later, we can adjust" — questions surface
  alongside progress updates; they do not halt the loop; the coordinator
  proceeds on its recommendation and incorporates answers when they arrive.

## 4. Contracts

1. **Agent record**: optional `behaviorScript: string` (cap ~16KB,
   `script-limits.mjs`). Empty = legacy behavior. Snapshot semantics: registry
   ID materializes text onto the agent; library updates do not auto-propagate
   (stability; self-authorship edits text directly later).
2. **`end-turn` reason**: optional `step-complete | blocked | done | error`.
   Absent = legacy validation path (backward compatible). Included in
   `buildEndTurnNotice` when present.
3. **`set-script` loop tool**: clone of `set-character`;
   `updateAgentScript` on agent-manager; params on `agent-create`/`agent-update`;
   server route + validators. Added to review-only denylist (amendment).
4. **Registry + preamble**: `src/core/scripts/script-registry.mjs` +
   `library/{coordinator,engineer,qa,design}-loop.mjs`. Executor preamble
   (`executor-preamble.mjs`, ~1-2KB from AGIS runtime.md) injected at
   brief-time, not stored per-agent.
5. **Execution**: coordinator ends every turn — sync todos → `continue-turn`
   (`nextAction` = next stroke + todo focus; window-time `delayMs`). On wake:
   verify payload vs todo focus (trust todos on disagreement); execute; repeat.
   Workers: fixed terminator → `end-turn reason=done`. Script demands
   continuation unless exits: blocked-on-upstream, budget-gate,
   task-complete, **progress-escalation** (N consecutive wakes with no
   todo-state change → visible notice + owner question — critique amendment).
   Questions are not exits: always proceed with the recommendation, surface
   the question in the progress update, adjust when the user answers
   (owner ruling §3).
6. **Budget shell**: `canContinueWithCurrentBudget()` called in
   `scheduleAgentContinuation` beside `exceedsChainLimit`; returns
   `{allowed:true}`; token checks later.
7. **Cursor v1**: coordinator's own todo list (stroke-prefixed focus);
   dedicated store deferred.
8. **Mutation authority** (owner ruling §3): every agent mutates only its own
   data (todos, script, agent record). A coordinator additionally may mutate
   descendants — equal-or-lower in its session hierarchy — and never anything
   upstream. One shared authority check mirrors session-control's
   descendants-only rule (`coordinator-scope.mjs`); applied to todo target
   writes, `set-script`, and `agent-update`. Non-coordinator cross-agent
   writes refuse. Verified today: todo tools are hard-scoped to self (no
   target param — coordinator sub-agent todo writes are new capability);
   `agent-tools.mjs` has no hierarchy checks (tightening required).

## 5. Critique amendments (folded above)

- Progress-escalation exit (semantic-deadlock defense).
- Continuation-frame visibility check: verify workers cannot read coordinator
  next-step payloads in shared session history — implementation-time spec.
- `set-script` respects review-only denylist.
- Registry snapshot semantics recorded.

## 6. Territory

**New.** `src/core/scripts/script-registry.mjs`,
`src/core/scripts/executor-preamble.mjs`,
`src/core/scripts/library/{coordinator,engineer,qa,design}-loop.mjs`,
`src/core/agents/script-limits.mjs`, `src/core/agents/mutation-authority.mjs`,
budget shell (extend `autonomous-chain.mjs` or sibling), specs under
`spec/core/scripts/` + `spec/core/agents/budget-gate-spec.mjs` +
`spec/core/agents/mutation-authority-spec.mjs`.

**Modified.** `agent-manager.mjs`, `agent-tools.mjs`, `agent-loop-tools.mjs`,
`agent-tool-definitions.mjs`, `agent-brief-template.mjs`, `continuation.mjs`,
`agent-route-frame-plugin-base.mjs`, `end-turn-notification.mjs`,
`agent-routes.mjs`, `validators.mjs`, review-only denylist.

**Unverified edges (check at implementation).** Continuation-frame visibility to
other session participants; question-wake re-entry into script loop; client
rendering of continuation frames (follow-up UI pass).

## 7. Phases and start gates

- **P1 — Contracts + registry + preamble + coordinator script.** Field, limits,
  agent-manager, tools, server, registry, preamble, coordinator-loop library
  script. Gate: existing suite green + plumbing specs.
  **Done 2026-11-01** — unit lane 3140/0/30 green; 22 new specs.
- **P2 — Execution wiring.** Brief injection, script-aware continuation prompt,
  budget-gate call, end-turn reason, notice inclusion, mocked wake-loop spec.
  Gate: unit lane green incl. new execution specs.
  **Done 2026-11-01** — unit lane 3154/0/30 green; execution-wiring spec
  (brief injection, script-aware wakes, schedule-gate budget shell with
  deny/allow/chain-limit coverage, end-turn reason threading + notices).
- **P3 — Library content + artifact + acceptance.** engineer/qa/design scripts;
  acceptance demo (scripted coordinator multi-turn loop). Gate: unit green;
  demo evidence recorded here.
  **Done 2026-11-01** — unit lane 3156/0/30 green. Library ships four templates
  (coordinator-loop, engineer, qa, design), all terminator-gated by the
  registry spec. Demo evidence: `spec/core/agents/scripted-coordinator-demo-spec.mjs`
  runs a deterministic mocked loop — briefs carry preamble+script; coordinator
  schedules two wakes (budget gate consulted each time; script-aware wake
  prompts); worker ends reason=task-complete → coordinator notice carries the
  Exit reason; worker→coordinator mutation refused; highest coordinator ends
  task-complete without messaging itself.
- **P4 — Self-authorship (separate authorization).** set-script conversational
  flow, preview frames, versioning/rollback. Not authorized by this plan.

One phase = one revert unit. P2 depends on P1; P3 depends on P2; P4 independent
authorization.

## 8. Verification spine

- Registry loads 4 scripts; grep-gate: every library script ends with the fixed
  terminator marker.
- Preamble present in brief when script set; absent when empty.
- Field plumbing ×3 layers (manager/tools/server) mirrors character specs.
- Budget shell: spy that it is *called* at the schedule gate and returns
  allowed; chain-depth-64 backstop still trips (existing specs).
- End-turn reason normalization; notice includes reason; absent → legacy path.
- Mocked scripted-coordinator wake loop: continue → wake → verify → stroke →
  continue; progress-escalation fires on stalled todos.
- Continuation-frame visibility spec (amendment check).
- Watchdogs 10s unit default. Puppeteer continuous-loop demo = acceptance only.
- Regression: full unit lane (`npm run test:unit`) each phase; 3107 baseline.

## 9. Owner rulings (resolved 2026-11-01)

1. **Field naming** → `behaviorScript`.
2. **Client UI pass** → deferred; minimal running-state cue only if the P3
   acceptance demo needs it.
3. **`end-turn` reason default when absent** → legacy validation path
   unchanged.
4. **Self-authorship** → P4, separate authorization. Plus the authority
   ruling (§3): coordinator mutates self + descendants only; all other bots
   self-only.
5. **Budget shell scope** → yes-shell called at the schedule gate; token
   checks later (tracker already live).
6. **Question stance** (§3) → always go with recommendations; adjust when the
   user responds.

## 10. Definition of done (P1-P3)

- All success criteria in §2 evidenced; §8 gates green; this file updated with
  P3 acceptance results; unit lane green on final revision; push authorized by
  owner.

## 11. Execution contract

Integrate → full unit lane → lint/typecheck per repo convention → authorized
push only. Conflicts resolved manually with compatible union semantics.
