# Agentic Script

In Kikx, **agentic script** means the runtime prompt script and loop contract that every agent receives before it decides whether to answer, stay silent, use tools, forward, or continue later.

The exact source of truth is executable code:

- `buildStartBrief(context)` in `src/core/plugins/agent-brief-template.mjs` — **Brief A**, the start brief.
- `buildMessageBrief(context)` in `src/core/plugins/agent-brief-template.mjs` — **Brief B**, the per-message brief.
- `AgentInterface.buildStartBrief(context)` / `AgentInterface.buildMessageBrief(context)` in `src/core/plugins/agent-interface.mjs`.
- `buildModelMessages(params, options)` in `src/core/plugins/agent-model-context.mjs` — the single place that decides the emitted message shape.
- `buildCompletionReviewScriptPrompt(input)` in `src/core/plugins/agent-script-template.mjs`.
- `AgentInterface.buildCompletionReviewPrompt(context, state)` in `src/core/plugins/agent-interface.mjs`.

Do not maintain a separate hand-copied prompt as the authoritative version. The builder functions are the copy that reflects exactly what the code sends.

## Two-Tier Briefs

The monolith per-turn prompt is gone. Agents now receive two tiers:

- **Brief A — once per (re)start** (session start, new agent, after compaction, coordinator change): version banner, compressed character, AGIS precepts, the tool map, tool notes, behavior rules, and (coordinator-only, with 3+ parties) the coordinator preamble.
- **Brief B — every turn and every tool round**: `Message from {sender} {timestamp}:`, the message, and compact dynamic state (todo, cwd, coordinator flag, participants).

`buildModelMessages` emits `[system] + [Brief A user turn when required] + [history…] + [Brief B user turn]`. The trigger message appears exactly once, inside Brief B. Brief A is protected from budget trimming and is not re-sent on completion review.

Brief A and Brief B are pure builders returning `{ text }`. Providers stay ignorant of the split. Stored constants — AGIS precepts, tool notes, behavior rules, coordinator preamble and the multiparty character note — live in `src/core/plugins/agent-precepts.mjs`. Per-tool help text lives on the tool definitions in `src/core/plugins/agent-tool-definitions.mjs` and in each registered plugin tool's static `help`.

The built briefs must never carry stop-inducing or FOMO language; the explicit denylist is `BRIEF_FORBIDDEN_PHRASES` in `agent-brief-template.mjs` and is checked by the brief spec.

## `help` Tool

Every agent turn exposes a `help` tool. With no argument it lists every available tool (including plugin-registered tools) with its one-line help; with a `tool` argument it returns that tool's full help and parameter schema. Help is derived from the same definitions the model received, so it cannot drift from the actual tool set.

## Completion Review Script

`buildCompletionReviewScriptPrompt(input)` accepts:

- `frameMessage`
- `finalFrameContent`
- `toolDefinitions`

The generated script asks:

- Have you completed all tasks the user requested?
- What did you miss?
- What did you forget?
- What could you have done better?

If complete, the agent calls `agent-finalize` with the actual visible answer/report/progress message for the original user request. The completion review is private control logic and must not be emitted as the visible response. If not complete, it explains the next work and continues with tools or `agent-respond-and-continue`.

If the draft asks the user whether the agent should take an obvious next safe/read-only step, the script treats that draft as incomplete and tells the agent to continue instead.

Direct provider `AgentMessage` outputs are treated as draft final answers too. Kikx routes them through completion review before publishing them.

If a completion review emits meta-review text such as "Self-review..." instead of a substantive final answer, Kikx preserves the prior draft final answer. This deterministic guard prevents the private audit from replacing the user-facing response.

After completion review, Kikx also applies a deterministic deferral guard. If the final text is an avoidable permission/continuation question such as "should I continue?", "would you like me to...", or "which step should I do next?" for a visible user turn, Kikx converts the turn into an immediate `respond-and-continue` instead of stopping for another user confirmation.

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
