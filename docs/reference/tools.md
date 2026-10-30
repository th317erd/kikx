# Tool system reference

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against built-in registration, tool execution, output storage, process management, and model-facing definitions.

Tools are plugin classes executed through a common lifecycle. The registry is extensible, tool calls and outcomes are durable frames, large results are stored separately, and long-running commands remain manageable after the initiating model request returns.

## Tool class contract

A tool extends `PluginInterface` and normally declares:

- `pluginID` and `featureName`;
- display name, description, and optional help;
- JSON-compatible `inputSchema`;
- `riskLevel`;
- optional frame type and browser component descriptor;
- `_execute(params)`.

`execute(params)` records the parameters, performs the permission check, and invokes `_execute`. Static `referencesFor()` may return entity references so clients can attach actions to a result.

## Execution lifecycle

`ToolExecutionService`:

1. normalizes input;
2. resolves the source and optional target session;
3. pins a cross-session target runtime so it cannot be evicted mid-call;
4. persists a tool-call frame;
5. marks the call started;
6. executes the tool;
7. stores output or error details;
8. persists the result frame and completion timestamps;
9. untracks shutdown state and releases the session pin in `finally` paths.

Enriched internal fields carry agent, target-session, source-session, source-frame, and coordinator context without requiring the model to supply them.

Tool-call and result frames are correlated and projected as one coherent UI item. `ask-user` deliberately hides its raw call frame because the separately persisted Question frame is the user-facing request; the hidden call remains auditable.

During shutdown, new work can be deferred, in-flight calls receive a grace period, and abandoned calls are finalized as interrupted failures. Pending calls and process completions have boot recovery paths.

## Output storage

Every built-in result can be stored through `ToolOutputStore`. Small results are returned inline. Large results return a compact pointer rather than flooding model context. Agents can inspect the durable content with:

- `output-read` for byte ranges;
- `output-grep` for regular-expression matches;
- `output-search` for indexed/scan-backed search as supported;
- `database-fetch` for locator-driven retrieval.

The HTTP API also exposes bounded reads of stored output. Documentation should say results are stored in **the database**, regardless of the active driver.

## Asynchronous process model

`exec` always uses `ProcessManager`. The manager starts a foreground child process, waits a short grace period for trivial commands, and returns either the completed result or a managed process ID. Long work remains observable and can wake the originating agent when it finishes.

Managed process operations include list, status, ranged output read, grep, termination, suspension, and resumption. Records and output paths are persisted; boot rehydrates durable records and recovers pending wake delivery. Access checks constrain ordinary agents to their own/session-visible processes while coordinator context permits broader management.

`exec-script` uses the same process pipeline. It creates an isolated temporary workspace, writes the declared files, optionally installs declared npm dependencies, then runs the provided start command. Keeping the temporary directory is opt-in.

## Built-in inventory

The core registers 63 tools. The registration list is authoritative.

### Web and files

- `web-search`, `web-fetch`
- `read-file`, `write-file`
- `ocr`

### Commands and managed processes

- `exec`, `exec-script`
- `exec-list`, `exec-status`, `exec-read`, `exec-grep`
- `exec-kill`, `exec-suspend`, `exec-resume`

### Working directory and feedback

- `cwd-get`, `cwd-set`, `cwd-clear`
- `feedback-report`

### Database and stored output

- `database-search`, `database-fetch`
- `output-read`, `output-grep`, `output-search`

### Agents, sessions, and cross-session control

- `agent-list`, `agent-create`, `agent-update`
- `session-list`, `session-create`, `session-get`, `session-frames`, `session-search`, `session-message`
- `session-invite-agents`, `session-invite-team`
- `session-control`
- `session-merge`, `session-merge-status`

### Teams

- `team-list`, `team-create`, `team-update`, `team-delete`
- `team-add-member`, `team-remove-member`

### Questions

- `question-list`, `question-get`, `question-create`, `question-answer`, `question-dismiss`
- `ask-user`

### Tags

- `tag-create`, `tag-list`, `tag-get`, `tag-read`, `tag-update`, `tag-delete`

### Todos and focus

- `todo-get`, `todo-add`, `todo-update`, `todo-complete`, `todo-delete`, `todo-clear`
- `todo-focus-set`, `todo-focus-clear`

## Agent-loop control tools

Agent providers also receive model-facing loop controls assembled by `AgentInterface`: `end-turn`, `continue-turn`, `progress`, `route`, `stop`, `help`, and `set-character`. These control the agentic loop and are not entries in the 63-class built-in registry above.

Visibility and authorization are contextual. For example, coordinator-only controls and review-only deny lists are applied while constructing the model tool set. Provider adapters should consume core's tool definitions instead of independently inventing incompatible schemas.

## Sources of truth

- `src/core/plugins/plugin-interface.mjs`
- `src/core/plugins/agent-interface.mjs`
- `src/core/plugins/agent-loop-tools.mjs`
- `src/core/plugins/agent-tool-definitions.mjs`
- `src/core/tools/register-built-in-tools.mjs`
- `src/core/tools/tool-execution-service.mjs`
- `src/core/tools/tool-output-store.mjs`
- `src/core/tools/process-manager.mjs`
- `src/core/tools/exec-tool.mjs`
- `src/core/tools/exec-script-tool.mjs`

## Related

- [Plugin system reference](plugins.md)
- [HTTP and SSE API](http-api.md)
- [Runtime lifecycle](../operations/runtime-lifecycle.md)
- [Agentic script](../architecture/agentic-script.md)
