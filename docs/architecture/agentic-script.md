# Agentic Script and Loop

> **Current v3 architecture.** Last verified against source: 2026-10-27.
> Status: implemented. Executable builders, not this prose, are authoritative.

In Kikx, **agentic script** means the complete runtime prompt and loop contract
that governs answers, silence, tools, routing, forwarding, and continuation. Use
narrower terms such as system prompt or brief only for those individual parts.

## Prompt shape

Kikx uses two generated briefs:

- **Brief A, the start brief**, appears on session start, a newly invited agent,
  after compaction, or after coordinator change. It contains the version banner,
  compressed character, stable precepts, tool map, behavior rules, delegation
  policy, and coordinator instructions when applicable.
- **Brief B, the message brief**, appears on every turn and tool round. It starts
  with the raw triggering text, then adds current sender/time, todo, open
  questions, working directory, coordinator status, participants, autonomous-run
  state, suspension warning, and compaction warning.

The model message builder emits a stable system message, projected history, and
one final user turn containing Brief B. On a restart, Brief A is inserted inside
that same final user turn after the raw trigger. It is not a separate history
message, which preserves a cacheable provider prefix and avoids duplicating the
trigger.

Briefs are ephemeral and are not stored as conversation frames. The user frame
can retain the fitted model-message list for inspection, but one-shot and
compaction prompts are deliberately excluded from that recording.

## Agent loop

`AgentInterface` supplies the common loop around provider `ask` behavior. It
builds tools and definitions from core plus registered plugins, streams provider
frames, handles loop-control results, records usage, and enforces a bounded step
count. Providers own model-specific I/O; they do not reimplement Kikx routing or
turn semantics.

A non-phantom `AgentMessage` finalizes a turn. Kikx does not run a second LLM
“are you done?” review. Deterministic guards can suppress an avoidable
permission/continuation question and convert it into a continuation instead.

## Ending and continuing

- `end-turn` finalizes with an optional visible report. Omitting both summary and
  details ends silently.
- `continue-turn` finalizes the visible response and creates a scheduled
  continuation with a concrete next action and optional delay.
- `progress` writes a visible non-final progress frame.
- `stop` breaks the loop without visible output.
- `route` is available only to the coordinator and records a handoff.
- `set-character` persists the full and compressed character.
- `help` describes the exact tool definitions exposed to this turn.

Waiting is not actionable continuation work. Managed processes, scheduled
frames, replies, and completed compactions wake the agent. A new user message
cancels pending autonomous continuations so stale work cannot outrank new user
authority. Autonomous chains carry a depth and pause with a visible notice at
the safety limit rather than looping forever.

Brief B labels autonomous turns as either a process completion (new input) or a
self-scheduled continuation (no new input). This gives the model the state it
needs to avoid treating a repeated continuation like a fresh user request.

## Multi-party behavior

The coordinator receives the coordinator preamble when coordination applies.
Ordinary frames reach it first; it answers broad requests or routes specific
work. Non-coordinators run only when selected. Agents may end silently when they
have no distinct contribution. The compressed character in Brief A helps each
agent contribute a differentiated perspective without spending the full
character budget on every turn.

## Source of truth

- [`src/core/plugins/agent-interface.mjs`](../../src/core/plugins/agent-interface.mjs)
- [`src/core/plugins/agent-brief-template.mjs`](../../src/core/plugins/agent-brief-template.mjs)
- [`src/core/plugins/agent-model-context.mjs`](../../src/core/plugins/agent-model-context.mjs)
- [`src/core/plugins/agent-loop-tools.mjs`](../../src/core/plugins/agent-loop-tools.mjs)
- [`src/core/plugins/agent-loop-state.mjs`](../../src/core/plugins/agent-loop-state.mjs)
- [`src/core/plugins/agent-precepts.mjs`](../../src/core/plugins/agent-precepts.mjs)

## Related

- [Architecture overview](./README.md)
- [Actors and routing](./actors-and-routing.md)
- [Context compaction](./context-compaction.md)
- [Agent behavior reference](../reference/agent-behavior.md)

