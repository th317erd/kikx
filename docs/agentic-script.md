# Agentic Script

In Kikx, **agentic script** means the runtime prompt script and loop contract that every agent receives before it decides whether to answer, stay silent, use tools, forward, or continue later.

The exact source of truth is executable code:

- `buildStartBrief(context)` in `src/core/plugins/agent-brief-template.mjs` — **Brief A**, the start brief.
- `buildMessageBrief(context)` in `src/core/plugins/agent-brief-template.mjs` — **Brief B**, the per-message brief.
- `AgentInterface.buildStartBrief(context)` / `AgentInterface.buildMessageBrief(context)` in `src/core/plugins/agent-interface.mjs`.
- `buildModelMessages(params, options)` in `src/core/plugins/agent-model-context.mjs` — the single place that decides the emitted message shape.

Do not maintain a separate hand-copied prompt as the authoritative version. The builder functions are the copy that reflects exactly what the code sends.

## Two-Tier Briefs

The monolith per-turn prompt is gone. Agents now receive two tiers:

- **Brief A — once per (re)start** (session start, new agent, after compaction, coordinator change): version banner, compressed character, AGIS precepts, the tool map, tool notes, behavior rules, and (coordinator-only, with 3+ parties) the coordinator preamble.
- **Brief B — every turn and every tool round**: `Message from {sender} {timestamp}:`, the message, compact dynamic state (todo, cwd, coordinator flag, participants), an optional autonomous-run clue, and the turn-ending phrase.

`buildModelMessages` emits `[system] + [Brief A user turn when required] + [history…] + [Brief B user turn]`. The trigger message appears exactly once, inside Brief B. Brief A is protected from budget trimming.

Brief A and Brief B are pure builders returning `{ text }`. Providers stay ignorant of the split. Stored constants — AGIS precepts, tool notes, behavior rules, coordinator preamble and the multiparty character note — live in `src/core/plugins/agent-precepts.mjs`. Per-tool help text lives on the tool definitions in `src/core/plugins/agent-tool-definitions.mjs` and in each registered plugin tool's static `help`.

The briefs are **ephemeral**: they are assembled per request and never written to frames. Frames store only messages (and the model's `thinking`, which is stored but not re-projected). Only compaction summaries are projected into the model context by design.

The built briefs must never carry stop-inducing or FOMO language; the explicit denylist is `BRIEF_FORBIDDEN_PHRASES` in `agent-brief-template.mjs` and is checked by the brief spec.

## Turn Ending: the dual verb

Every turn ends one of two ways, and the agent is always asked to pick. This is the whole per-turn contract (the queue-as-definition-of-done rule):

- **`end-turn`** — end the turn. Pass `text` for a visible report to the user, or omit it to end silently. Use when the queue is empty.
- **`continue-turn`** — end this turn and schedule your next step back to you. Optional `text` (visible progress), `nextAction` (the continuation prompt), and `delayMs`. Use when the queue is not empty.

"Queue" means: open todos (with focus) + still-running async processes + the next action named on a `continue-turn`. The brief biases toward continuing: if the agent does not know the next step, it keeps working to plan it out rather than stopping. `continue-turn` is never refused.

The other control tools are `progress` (a visible non-final pre-tool note), `stop` (stop the loop immediately, no visible output), `set-character` (persist persona), `route` (coordinator hand-off, no visible output), and `help`.

## No completion review

Kikx does **not** run a second "are you done?" LLM pass. A turn ends on a `LoopControl` (a control-tool result) or on a non-phantom `AgentMessage`; the model decides done-ness structurally. Completion is bounded instead by:

- **Single-shot wakes** — at most one async exec-completion wake per `completionToolOutputID`.
- **Cancel on user turn** — a new user message marks pending autonomous wakes/continuations `cancelled`, so the user supersedes the autonomous backlog.
- **Fail-safe chain pause** — every autonomous frame carries a `continuationDepth`; past `MAX_AUTONOMOUS_CHAIN_STEPS` (64) the scheduler stops and posts one visible, non-routing `SystemNotice` (`Autonomous run paused — reply to continue.`). Nothing is killed; stored output remains; any user message resets the chain.

After finalization Kikx applies a deterministic deferral guard. If the final text is an avoidable permission/continuation question such as "should I continue?", "would you like me to...", or "which step should I do next?" for a visible user turn, Kikx converts the turn into an immediate `continue-turn` instead of stopping for another user confirmation.

## Autonomous-run clue

Brief B gains one stateful line on self-triggered turns only:

`(Autonomous run — step N. <A process you started has completed. | No new input since your last step.>)`

An exec-wake genuinely brings new input; a `continue-turn` continuation brings none. This gives the model the fact it otherwise lacks — that it is repeating — without forbidding work.

## Routing

Coordinator routing guidance is part of Brief A, not a separate per-turn prompt:

- the coordinator is the router for all traffic and the default handler for broad, unaddressed user messages
- the coordinator routes (rather than answers) messages intended for another actor, using the `route` tool
- routing produces no visible message from the coordinator; routed recipients respond
- coordinators stay silent when another agent's reply already satisfies the request
- non-coordinators answer only when the coordinator routes the message to them

The coordinator-only preamble (`COORDINATOR_PREAMBLE_LINES`) is emitted only to the assigned coordinator and only when there are 3+ parties, counting users.

## Vocabulary

Use **agentic script** for this whole prompt-and-loop system. Avoid inventing alternate names such as "agent prompt", "system prompt", or "loop primer" when referring to this specific Kikx concept unless clarifying a narrower implementation detail.
