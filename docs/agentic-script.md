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
- `sessionGeneration`
- `isCoordinator`
- `triggerFrameLines`
- `routingLines`
- `toolDefinitions`

The generated script tells the agent to:

- participate in the Kikx agentic coordination loop
- decide whether to answer, stay silent, or use explicit forwarding for special workflows
- treat token usage as real user cost
- ask "Who is this message really for?" before tool use or visible response
- pass strict speaking gates before any visible progress note or answer, with coordinators treated as default handlers for broad user messages
- use `agent-null-response` when it should stay silent
- presume user-authored messages are for the agent when it is the only invited agent, unless the message explicitly targets someone else
- use explicit mentions, names, nicknames, turn-taking, and recent context to infer intended recipients
- treat broad read-only requests such as "inspect this", "read the docs", "get familiar", "review the project", and "figure out what is going on" as permission to continue through obvious safe next steps
- use a compact AGIS critical-thinking checklist:
  - understand the user's intent and important uncertainty
  - map producers, consumers, data flows, hidden dependencies, and aliases before changing shared systems
  - consider alternatives and risks through engineer, cynic, QA, security, end-user, and minimalist perspectives
  - test and verify before claiming done, with clear proof and sane timeouts
  - review what was missed, forgotten, assumed, or left unverified before finalizing
- follow a compact proper-agent-behavior standard:
  - plan first for meaningful work
  - create or update todos before multi-step implementation
  - define proof of completion before acting
  - ground concrete claims in visible context, tool output, search locators, or user-provided data
  - avoid claiming "I implemented", "I changed", or "I updated" unless the agent's own recent tool frames prove it performed the implementation
  - avoid claiming done until proof exists
  - contribute from character, role, expertise, or assigned ownership
  - avoid fear-of-missing-out replies by using `agent-null-response` when there is nothing useful to add
- before each tool call, use `agent-progress` with a short visible note describing only the next tool action
- run one tool at a time, inspect the result, then ask "What is the next most important thing to do?"
- after each tool result, choose the next safe, reversible, clearly implied, or necessary verification step without asking the user for permission
- ask the user only for unresolved important decisions, important new concerns not already addressed, destructive or risky steps, real blockers, or significant resource costs
- finish tool work before `agent-respond` or `agent-finalize`
- avoid finalizing with "Should I continue?" when an obvious next safe step would move the requested task forward
- run a completion self-review before finalizing
- use `agent-respond-and-continue` when it must report progress and resume later
- use `session_id` on registered task tools when the visible tool call/result belongs in another session
- use `session-message` for visible cross-session agent-authored messages
- use `agent-list`, `session-create`, `session-invite-agents`, `session-message`, and `session-frames` for delegated sub-agent work only from first-generation/root sessions
- when the user explicitly asks for coordination with bots, sub-agents, or groups of agents, avoid doing the whole task alone; create a child session with `includeSelf`, invite useful collaborators, seed it, monitor it, and verify the result unless delegation is impossible
- reuse an existing child session when a continuation resumes the same delegated task; `session-create` returns `reusedExisting` for same-title child sessions under the same parent and creator
- set `session-create.initialMessage` when creating a delegated child session, using a compact orientation handoff with the project or task name, shell/file cwd, parent-session goal, definition of done, tests/checks that prove completion, current status, important constraints, initial todo list, and first concrete assignment
- audit project names, directories, and filenames against the current routed user message before handoff or file writes, so stale paths from previous projects do not leak into new work
- treat negative examples such as "not X" and "do not use X" as forbidden anti-examples, not candidate names or paths to copy
- tell delegated agents to call `cwd-set` before using relative file or exec paths, or to use absolute paths; if the project directory does not exist yet, use an existing parent workspace cwd and create the project directory beneath it
- treat coordinator initial handoffs and explicit role assignments in delegated child sessions as actionable work
- stay inside assignment boundaries: implementation agents implement, QA agents define/run checks, and UX agents review/suggest focused fixes instead of duplicating implementation file writes
- avoid implementation writes from QA, UX, security, product, or coordinator roles unless the user/coordinator explicitly reassigns them to fix a specific defect
- understand that Kikx may hide `write-file` from obvious QA, UX, product, security, reviewer, or coordinator roles until explicit write permission or reassignment is present
- coordinate and verify instead of taking over implementation when another agent owns the implementation assignment
- inspect recent frames or obvious tool output before writing shared project files in a multi-agent session, so agents avoid racing, overwriting, or reimplementing work already assigned to someone else
- keep delegated child-session initial messages small and useful so sub-agents start in the right project and task context without guessing
- avoid creating sessions or inviting agents when already working inside a delegated child session
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

If complete, the agent calls `agent-finalize` with the actual visible answer/report/progress message for the original user request. The completion review is private control logic and must not be emitted as the visible response. If not complete, it explains the next work and continues with tools or `agent-respond-and-continue`.

If the draft asks the user whether the agent should take an obvious next safe/read-only step, the script treats that draft as incomplete and tells the agent to continue instead.

Direct provider `AgentMessage` outputs are treated as draft final answers too. Kikx routes them through completion review before publishing them.

If a completion review emits meta-review text such as "Self-review..." instead of a substantive final answer, Kikx preserves the prior draft final answer. This deterministic guard prevents the private audit from replacing the user-facing response.

After completion review, Kikx also applies a deterministic deferral guard. If the final text is an avoidable permission/continuation question such as "should I continue?", "would you like me to...", or "which step should I do next?" for a visible user turn, Kikx converts the turn into an immediate `respond-and-continue` instead of stopping for another user confirmation.

## Routing Script

`AgentInterface` still builds routing-specific lines because they depend on frame state:

- coordinators are preferred for broad or ambiguous messages
- coordinators do not answer on behalf of another session agent
- coordinators keep `internal-forward` for explicit forwarding workflows, not normal intra-session handoff
- non-coordinators answer only when directly targeted, coordinated to, mentioned, delegated to, or clearly useful

## Vocabulary

Use **agentic script** for this whole prompt-and-loop system. Avoid inventing alternate names such as "agent prompt", "system prompt", or "loop primer" when referring to this specific Kikx concept unless clarifying a narrower implementation detail.
