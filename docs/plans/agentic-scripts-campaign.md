---
title: Agentic scripts campaign
status: current
doc_type: plan
audience: [developers, maintainers, operators]
applies_to: development-v3
last_verified: 2026-11-16
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
agent-update/script-set; in brief; no UI required. (6) Suite green + new specs.
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
3. **`script-set` loop tool**: clone of `set-character`;
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
   **Design-level supersession (2026-11-16): the single exit list is now
   §12.2(8)** — `blocked-on-upstream` kept as a yielding override with
   notice, `task-complete` retired until done-semantics exist, owner-abort
   and fatal error added; shipped P1–P3 behavior unchanged until
   implementation is authorized (§12.9). `N` here and in §12.4 still to be
   set.
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
   writes, `script-set`, and `agent-update`. Non-coordinator cross-agent
   writes refuse. Verified today: todo tools are hard-scoped to self (no
   target param — coordinator sub-agent todo writes are new capability);
   `agent-tools.mjs` has no hierarchy checks (tightening required).

## 5. Critique amendments (folded above)

- Progress-escalation exit (semantic-deadlock defense).
- Continuation-frame visibility check: verify workers cannot read coordinator
  next-step payloads in shared session history — implementation-time spec.
- `script-set` respects review-only denylist.
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
  (Tool naming later corrected to the noun-first convention: `set-script`
  renamed to `script-set`, read-only sibling `script-get` added for any
  agent id including self.)
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
- **P4 — Self-authorship (separate authorization).** script-set conversational
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

## 12. Design record — the executor pivot (event-driven operator script)

**Status: design record only — NOT authorized for implementation** (owner, 2026-11-16).

Owner pivot (conversation of 2026-11-16): the P1–P3 script *persuades* via the
executor preamble; this work makes it *drive*. Every ruling below is the
owner's, verbatim or faithfully condensed. Supersedes §2 only where stated
(§2's non-goals otherwise stand — including *"no replacement of
end-turn/continue-turn"*, read as the tool surface: the gate changes when
`end-turn` **succeeds**, not the tool set; §7 P4 remains reserved and
untouched).

### 12.1 Motivation (owner)

- (a) bots end prematurely; (b) they do not ask "what needs to be done
  next?" when they end; (c) they skip testing; (d) other unilateral stops.
- Goal: the agentic script **actually drives the bot in a loop**. The bot
  may not break out until the script is fully exhausted. Progress happens
  only through tools; an early `end-turn` returns: *"Agentic Script
  execution is not complete… if you have questions, ask the user with the
  `question-create` tool, and continue."*

### 12.2 Rulings and decisions

1. **The todo list is the driver; the script drives/generates the todo
   list** (owner). The script's only writes are todo mutations (within the
   §3 authority ruling) plus flow directives. **Todos are the language's
   memory — v1 has no variables.**
2. **The language is only complicated enough to step through** (owner):
   free-form questions/statements plus simple branching. No variables, no
   arithmetic, no subroutines, no parallel branches; one program counter
   per agent. **Ruling: no condition `kind` tags** — conditions are
   model-answered questions; every verdict lands as a frame so honesty is
   auditable rather than enforced.
3. **Two-level design**: machine control flow (sequence, AND-chain, OR-
   dispatch, labels, gotos, events) around AGIS prose. The model still
   interprets prose — §2's *"model interprets; we ship a preamble"* stays
   true at the prose level; what becomes machine-owned is the skeleton:
   stepping and gating.
4. **JSON, strict** — the `//` comments in the owner's example were
   explanatory only (**ruling: no JSONC**). The authoring form stays AGIS.
5. **Compile-then-execute**: the agent compiles AGIS source to IR up-front
   (the compiler may itself be an AGIS discipline, e.g. `::agis.compile`);
   the runtime structurally validates it (every target resolves, handlers
   non-empty, terminator present, size cap) — failed validation **rejects**
   `script-set`; store `{source, IR, compiledAt}`; execution reads IR only;
   edits recompile. The model is an untrusted compiler — and **structural
   validation proves shape, not fidelity**: a compile that faithfully
   shapes but softens the source passes. Known hole (critique): the guard
   is user-visible compiled-IR preview frames, folding into §7 P4's
   already-planned preview/versioning flow — see §12.9.
6. **Enforcement = three layers**: (a) tool gate — refusal names the active
   step and the blocking condition; **scope: ALL scripted agents — the
   first implementation focuses on the coordinator only** (approved
   2026-11-16); (b) scheduler re-wake — silence does not escape the loop;
   **mechanism (approved): a turn-completion hook** — when a turn ends with
   the PC non-terminal, the runtime itself schedules the continuation
   carrying the active line. The chain cap refreshes on every PC/lap
   advance, so only steps that make no progress trip it (→ stall question,
   never a silent pause); (c) PC persisted server-side — restarts resume
   mid-script. **Teleprompter framing (owner): the script acts like the
   operator** — its branch lines are the questions (*"Where are you at with
   the implementation?" / "How thorough is your test coverage?" / "Did you
   *prove* your work with tests?" / "Let's continue planning the next
   step."*), so refusal text is editable script content, not hardcoded.
7. **Event layer**: events are the places bots currently decide
   unilaterally. v1 set: `endTurn`, `todoListEmpty`, `userResponded`
   (`stallWake` under review). **Rule: events ask, directives decide, the
   gate enforces** — events never move the PC themselves; moves are
   validated `goto` / `next-step` directives (vocabulary: `goto <label>`,
   `continue` — stay in phase, `ask` — non-blocking, `end` — terminal; v1
   scripts contain no `end`). **Event lookup**: phase-local handler first,
   else the script-global default (`coordinator_v6` carries a global
   `endTurn`; a phase block overrides it). The `next-step` contract
   (params, validation, refusals) is spec-time — §12.7.
8. **Exits — ruling: end state to be defined as we go.** v1 has no silent
   terminal branch: every exit line ends in a question to the user.
   **This list is the single exit authority for the whole plan**
   (supersedes §4.5, annotated there): harness overrides = budget gate,
   *blocked-on-upstream* yield with notice, stall escalation, owner abort,
   fatal error — the only non-script stops. `task-complete` is retired
   until done-semantics exist; *owner abort* and *fatal error* are
   additions. *Blocked on user* is a branch (ask
   via `question-create`, then requeue to unblocked work), never an end.

### 12.3 Coordinator behavior contract (the owner's six steps)

1. **Set Vision** — user's responsibility; if thin, the agent collects the
   user's thoughts as it goes and continually fleshes the Vision out.
2. **Plan Mission** — current implementation tasks; a subset of the Vision
   (e.g. "Implement the Auth system"), never the whole project.
3. **Confirm the plan** — AGIS critical-thinking pass for gaps.
4. **Implement the plan** — deviations and issues worked out here; anything
   needing the user gets asked (**question-create, non-blocking**) while
   work continues on unblocked items — **DO NOT STOP**.
5. **Prove work** — unit + functional tests, happy **and** unhappy paths,
   still aligned with Mission and Vision.
6. **If the full and complete Vision is not yet met, goto step 1.**

Five confirmations from the follow-up exchange:

- Per-item **required proof** during step 4 + step-5 coverage audit with
  backfill (the "no" branch adds test todos and returns to step 4).
- **Blocked-everywhere → re-scope upstream** (4→5→6→1); the stall
  escalation's question is the backstop.
- **Mission persists across laps** and rotates only when its slice is
  satisfied; rotation is posted as a progress frame.
- **Vision + Mission are agent-record fields**, injected into the brief;
  coordinator self-authority covers their writes; edits are posted visibly
  (conversation is the UI).
- **Step 6's "fully met" stays undefined in v1**; both candidate
  done-conditions (*vision met* / *gone as far as possible without user
  guidance*) likely converge where step 1/2 cannot choose a productive
  slice that doesn't need the user — the structure accumulates the evidence
  that will define done later. **Henhouse guard (critique):** the
  coordinator both writes the Vision and answers "fully met" — whenever
  that branch is defined, the Vision edit and the met-claim must be
  user-visible and never collapse into one silent lap.

### 12.4 Accepted-items stall guard (approved answer to re-scope churn)

A re-scope loop can shuffle todos forever and thereby satisfy a *no
todo-state change* detector without landing work. Progress for stall
escalation must therefore count **accepted items** (proof-passing, moved to
done) per outer lap: N consecutive laps with **zero acceptances** → visible
notice and a question to the owner, regardless of todo churn.
**Intra-lap scope (approved):** not lap-only — chain/stall accounting
refreshes on every PC advance, so an inner loop that stops advancing (a
phase-3 re-check that never resolves) trips the same question instead of
running forever. Touches the future progress-escalation contract; recorded
here, **not implemented**.

### 12.5 Draft script — `coordinator_v6` (approved shape, design artifact)

```text
SCRIPT coordinator_v6

events {
  endTurn -> "Agentic Script execution is not complete — you are at the
              active phase. [the operator question for this phase] If you
              have questions, ask the user with question-create, then
              continue."
}

phase 1_set_vision {
  >>>Your Vision lives in your record field.<<<
  branch {
    "Vision is detailed enough to choose the next slice of work" -> goto 2_plan_mission
    "Vision is empty, thin, or stale" -> {
      "Fold in everything the user has said so far; write/update the Vision
       field with your best interpretation; surface visionary questions
       (question-create, non-blocking); then continue — never wait on the
       user to proceed." -> goto 2_plan_mission
    }
  }
}

phase 2_plan_mission {
  >>>Mission = current implementation tasks — a subset of the Vision (e.g.
  "Implement the Auth system"), not the whole project.<<<
  branch {
    "A mission is chosen and its plan is seeded as todos (owner, definition
     of done, required proof on every item)" -> goto 3_confirm_plan
    "No mission or plan yet" -> {
      "Choose the mission; seed the plan todos; ask visionary questions if
       useful (non-blocking)." -> goto 3_confirm_plan
    }
  }
}

phase 3_confirm_plan {
  >>>Run an AGIS critical-thinking pass over the plan: gaps, missed edges,
  risks, tests implied but absent.<<<
  branch {
    "Material gaps found" -> {
      "Add a todo per gap (owner, definition of done, required proof)."
        -> goto 3_confirm_plan
    }
    "No material gaps" -> goto 4_implement
  }
}

phase 4_implement {
  >>>Work the plan as defined. Deviations and issues get worked out here.
  If resolution needs the user: ask (question-create) AND move to the next
  item that isn't held up. Questions never halt you.<<<

  >>>At each continuation, answer this branch before the event handlers.<<<

  branch {
    "An unblocked todo exists" -> {
      "Take the next unblocked todo and work it (required proof included)."
        -> continue
    }
    "No unblocked todo exists — every remaining item needs the user" -> {
      "Re-scope upstream: prove what is done, then re-examine Vision and
       Mission for a slice that does not need the user."
        -> goto 5_prove
    }
  }

  events {
    endTurn        -> "Agentic Script execution is not complete. Where are
                       you at with the implementation? Answer it, then take
                       the next unblocked todo."
    todoListEmpty  -> "Prove-before-advance: is everything from the plan
                       actually in the list, with proof?" -> goto 5_prove
    userResponded  -> "Fold answers into Vision/Mission, unblock items,
                       continue."
  }
}

phase 5_prove {
  branch {
    "Every implemented item is covered by unit AND functional tests — happy
     AND unhappy paths — and still aligns with Mission and Vision"
      -> goto 6_check_vision
    "Coverage, proof, or alignment is missing" -> {
      "Add the missing test/fix todos with required proof, then get
       started." -> goto 4_implement
    }
  }
}

phase 6_check_vision {
  branch {
    "Full and complete Vision is not yet met" -> goto 1_set_vision
    "Vision fully met" -> UNDEFINED (interim: must end in a question)
  }
}
```

Harness overrides sit outside this file; they are the only non-script
exits. **Delivery shape (resolved, critique):** the brief carries the
script, the PC/cursor, and the active line (full-script injection §4.4
keeps working); the directive itself rides `continue-turn`'s `nextAction`
and the continuation wake prompt — evolution of existing machinery, no new
injection path. Both channels are stated so §4 and this section stop
disagreeing.

### 12.6 Team-of-bots seam (future)

Phases 2, 4 and 5 later carry delegation content: the coordinator assigns
descendants' todos (per the §3 authority ruling), monitors, validates, and
stays a coordinator, not a worker. Structure unchanged — prose swaps
inside phases. **Worker signal under the gate:** the gate covers all
scripted agents (§12.2(6)), first implementation coordinator only;
per-item worker completion rides `continue-turn` progress frames (already
visible per §1), `end-turn` + reason fires only at script-defined exits —
the monitor branch reads frames as well as end-turn notices.

### 12.7 Open items (define as we go, per owner)

- done-semantics for phase 6's "fully met" branch;
- final event set (is `stallWake` an event?);
- depth of the honesty backstop beyond frame audit;
- team content for phases 2/4/5;
- `next-step` tool contract (params, validation, refusals) and the full
  directive-vocabulary semantics — written at authorization;
- stall/escalation `N` (here and in §4.5);
- IR storage fields on the agent record (extends §4.1's
  `behaviorScript: string` with the compiled pair);
- acceptance definition for §12.4 (self vs coordinator-accepted items);
- source-comment handling for the compiler (the draft carries none; strict
  JSON applies to IR only);
- `userResponded` re-entry = §6's already-listed unverified edge
  ("question-wake re-entry into script loop") — verify at implementation;
- P4 cross-ref: "edits text directly" (§4.1) now means source edit →
  recompile → validate; P4's preview frames become the compiler-fidelity
  guard;
- phase numbering, start gates, and DoD for this work — written when
  implementation is authorized.

### 12.8 Execution contract for this section

Design record only. No source, spec, or migration changes are authorized
by this section. When implementation is authorized: failing-first TDD,
unit lane green before each commit, `git commit -F`, push per standing
rules.

### 12.9 Critique amendments (owner-approved 2026-11-16)

Critical pass over the whole plan — the plan's own phase-3 discipline
applied to itself. Findings → approved fixes → where applied:

1. **Layer (b) had no mechanism; the chain cap contradicted it.** Fixed in
   §12.2(6): a turn-completion hook auto-schedules the continuation while
   the PC is non-terminal; the chain cap refreshes on PC/lap advance, so
   only no-progress steps trip it — landing on the stall question, never a
   silent pause. (Verified against §1: continuations were previously
   scheduled only by the model's own `continue-turn`, so silence *did*
   escape the loop — the mechanism was aspirational until this ruling.)
2. **Two divergent exit lists.** §12.2(8) is now the single authority;
   §4.5 annotated as design-level superseded; `task-complete` retired until
   done-semantics exist; owner-abort/fatal added; blocked-on-upstream kept
   as a yielding override with notice.
3. **The gate severed the worker→coordinator signal.** Gate = all scripted
   agents, first implementation = coordinator only; per-item worker
   completion moves to `continue-turn` progress frames (§12.5 delivery
   shape, §12.6).
4. **Blocked-everywhere was missing from the draft.** Phase 4 gained the
   branch — no unblocked todo → `goto 5_prove` (the re-scope path) —
   checked at each continuation before the event handlers; no new event,
   so the v1 event set stays three (§12.5).
5. **Compiler fidelity overclaimed.** Structural validation proves shape,
   not fidelity (§12.2(5)); the guard is compiled-IR preview frames via P4.
6. **The refusal message named a nonexistent tool.** `ask-user` →
   `question-create` throughout (§12.1); the owner's quoted message is
   corrected accordingly.
7. **Event lookup was undefined** → phase-local handler first, else the
   script-global default; a global `endTurn` was added to the draft; the
   `next-step` contract is deferred to §12.7.
8. **The stall guard was lap-only** → intra-lap scope added (§12.4).
9. **Delivery shape disagreed across §4 and §12** → both channels stated
   (§12.5 trailer).
10. **Supersession was unnamed** → the §12 header now states the gate
    modifies `end-turn`'s success, not the tool surface (§2's non-goal
    preserved).
11. **Vision henhouse** → visibility guard recorded for when "fully met"
    is defined (§12.3).
12. **The draft carried a source comment** → removed (strict JSON for IR;
    no comments in the draft until the compiler question in §12.7 is
    answered).

LOW items and spec-time contracts live in §12.7. No code authorized.
