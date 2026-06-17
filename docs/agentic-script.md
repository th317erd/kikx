# Agentic Script

In Kikx, **agentic script** means the runtime prompt script and loop contract that every agent receives before it decides whether to answer, stay silent, use tools, forward, or continue later.

The exact source of truth is executable code:

- `buildAgenticScriptPrompt(input)` in `src/core/plugins/agent-script-template.mjs`
- `buildCompletionReviewScriptPrompt(input)` in `src/core/plugins/agent-script-template.mjs`
- `AgentInterface.buildDefaultAgentPrompt(context)` in `src/core/plugins/agent-interface.mjs`
- `AgentInterface.buildCompletionReviewPrompt(context, state)` in `src/core/plugins/agent-interface.mjs`

Do not maintain a separate hand-copied prompt as the authoritative version. The template functions are the copy that reflects exactly what the code sends.

## Main Agentic Script

`buildAgenticScriptPrompt(input)` accepts:

- `frameMessage`
- `mentions`
- `participantAgents`
- `character`
- `tokenUsage`
- `isCoordinator`
- `triggerFrameLines`
- `routingLines`
- `toolDefinitions`

The generated script tells the agent to:

- participate in the Kikx agentic coordination loop
- decide whether to answer, stay silent, or use explicit forwarding for special workflows
- treat token usage as real user cost
- ask "Who is this message really for?" before tool use or visible response
- pass strict speaking gates before any visible progress note or answer
- use `agent-null-response` when it should stay silent
- use explicit mentions, names, nicknames, turn-taking, and recent context to infer intended recipients
- before each tool call, use `agent-progress` with a short visible note describing only the next tool action
- run one tool at a time, inspect the result, then ask "What is the next most important thing to do?"
- finish tool work before `agent-respond` or `agent-finalize`
- run a completion self-review before finalizing
- use `agent-respond-and-continue` when it must report progress and resume later
- use `session_id` on registered task tools when the visible tool call/result belongs in another session
- use `session-message` for visible cross-session agent-authored messages
- use `agent-list`, `session-create`, `session-invite-agents`, `session-message`, and `session-frames` for delegated sub-agent work
- use `session-search`, `output-search`, and `database-fetch` for large history or stored tool-output lookup

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

If complete, the agent calls `agent-finalize`. If not complete, it explains the next work and continues with tools or `agent-respond-and-continue`.

## Routing Script

`AgentInterface` still builds routing-specific lines because they depend on frame state:

- coordinators are preferred for broad or ambiguous messages
- coordinators do not answer on behalf of another session agent
- coordinators keep `internal-forward` for explicit forwarding workflows, not normal intra-session handoff
- non-coordinators answer only when directly targeted, coordinated to, mentioned, delegated to, or clearly useful

## Vocabulary

Use **agentic script** for this whole prompt-and-loop system. Avoid inventing alternate names such as "agent prompt", "system prompt", or "loop primer" when referring to this specific Kikx concept unless clarifying a narrower implementation detail.
