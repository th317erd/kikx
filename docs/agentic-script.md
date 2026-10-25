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

- **Brief A — once per (re)start** (session start, new agent, after compaction, coordinator change): version banner, compressed character, AGIS precepts, tool map, tool notes, behavior rules, and (coordinator-only, with 3+ parties) the coordinator preamble.
- **Brief B — every turn**: the raw trigger message, compact dynamic state (todo, cwd, coordinator flag, participants), an optional autonomous-run clue, and the turn-ending phrase.

The stable system prompt carries the invariant authority/evidence/delegation/safety contract and the communication contract, so they survive long provider tool loops and do not depend on per-turn scaffolding.

`buildModelMessages` emits `[system] + [history…] + [Brief B user turn]`. On a `(re)start`, Brief A text is prepended *inside the same final user turn*, after the raw trigger text, when required. It is not a separate user message; this preserves the provider-cacheable history prefix. The trigger message appears exactly once.

Brief A and Brief B are pure builders returning `{ text }`. Providers stay ignorant of the split. Stored constants — system invariants, the communication contract, AGIS precepts, tool notes, behavior rules, coordinator preamble, and the multiparty character note — live in `src/core/plugins/agent-precepts.mjs`. Per-tool help text lives on the tool definitions in `src/core/plugins/agent-tool-definitions.mjs` and in each registered plugin tool's static `help`.

The briefs are **ephemeral**: they are assembled per request and never written to frames. Frames store only messages (and the model's `thinking`, which is stored but not re-projected). Only compaction summaries are projected into the model context by design.

The built briefs must never carry stop-inducing or FOMO language; the explicit denylist is `BRIEF_FORBIDDEN_PHRASES` in `agent-brief-template.mjs` and is checked by the brief spec.

## Turn Ending: the dual verb

Every turn ends one of two ways, and the agent is always asked to pick. This is the per-turn actionable-work rule:

- **`end-turn`** — end the turn. After doing work, pass a required `summary`: one or two sentences on the goals completed, then 2–5 Markdown bullets of steps taken. Put evidence/proof, failures/risks, and remaining/next in optional `details`. Omit both only when ending silently with no new work to report.
- **`continue-turn`** — end this turn with a visible progress report and schedule your next step back to you. Pass `text`, required `mood`/`moodWord`, and `nextAction` naming the next step, plus optional `delayMs`. Use only when you have actionable work to do right now.

Waiting is not work. Open todos or running processes are owned by the runtime: a completion/reply wakes you, so do not poll. If clearly-required work remains but you do not yet know the step, keep planning; if you are only waiting, `end-turn` with the real wait condition. `continue-turn` is never refused, but it must name an actionable next step.

The other control tools are `progress` (a visible non-final note before a new phase/related batch, before a long-running/destructive action, or after a meaningful result), `stop` (stop the loop immediately, no visible output), `set-character` (persist persona), `route` (coordinator hand-off, no visible output), and `help`.

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

Coordinator routing invariants are part of the stable system prompt; the detailed coordinator preamble is part of Brief A on (re)start:

- the coordinator is the router for all traffic and the default handler for broad, unaddressed user messages
- the coordinator routes (rather than answers) messages intended for another actor, using the `route` tool
- routing produces no visible message from the coordinator; routed recipients respond
- coordinators stay silent when another agent's reply already satisfies the request
- non-coordinators answer only when the coordinator routes the message to them

The coordinator-only preamble (`COORDINATOR_PREAMBLE_LINES`) is emitted only to the assigned coordinator and only when there are 3+ parties, counting users.

## Vocabulary

Use **agentic script** for this whole prompt-and-loop system. Avoid inventing alternate names such as "agent prompt", "system prompt", or "loop primer" when referring to this specific Kikx concept unless clarifying a narrower implementation detail.
