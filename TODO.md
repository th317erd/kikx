# TODO

- [x] Add built-in command execution agent tool.
  - [x] Add a consolidated local command execution service.
  - [x] Run commands through the Kikx server login shell.
  - [x] Register the global `exec` tool.
  - [x] Add focused unit coverage.

- [x] Render agent Markdown with Kikx-controlled HTML.
  - [x] Add a client Markdown renderer that avoids paragraph wrapping.
  - [x] Render agent messages and deltas through the Markdown renderer.
  - [x] Add Markdown unit coverage for blocks, inline formatting, links, tables, and safe HTML handling.
  - [x] Add Stagehand coverage for rendered agent Markdown.
  - [x] Verify focused tests.
  - [x] Verify Stagehand tests.
  - [x] Verify full tests.

- [x] Add built-in write-file agent tool.
  - [x] Add write-file schema and tool class.
  - [x] Route writes through the consolidated local file access service.
  - [x] Support overwrite, append, and create-only modes.
  - [x] Add unit coverage for text, append/create, base64, empty content, and missing service.
  - [x] Verify focused tests.
  - [x] Verify full tests.

- [x] Add read-file line and character range support.
  - [x] Add read-file schema parameters for line and character ranges.
  - [x] Return range metadata from the local file access service.
  - [x] Add unit coverage for full, line-range, character-range, and invalid mixed reads.
  - [x] Verify focused tests.
  - [x] Verify full tests.

- [x] Persist full tool outputs and return large-result pointers.
  - [x] Add AeorDB-backed tool output store with metadata indexes.
  - [x] Add `tool-output-get` retrieval tool with byte-range arguments.
  - [x] Store registered tool results through the central tool executor.
  - [x] Remove read-file output truncation.
  - [x] Verify focused tests.
  - [x] Verify full tests.

- [x] Add built-in read-file agent tool.
  - [x] Route registered agent tools through a central tool executor service.
  - [x] Add a local file access service for filesystem reads.
  - [x] Register the `read-file` global tool.
  - [x] Verify focused tests.
  - [x] Verify full tests.

- [x] Make global web tools work through live agent routing.
  - [x] Add DuckDuckGo HTML fallback when Instant Answer has no usable search results.
  - [x] Fix browser-context extraction in `web-fetch`.
  - [x] Verify full tests.
  - [x] Verify focused tests.
  - [x] Verify Session 2 live agent calls both `web-search` and `web-fetch`.

- [x] Replace one-hop agent conversation guard with token-aware broad conversation.
  - [x] Add AeorDB-backed token usage tracker and unit tests.
  - [x] Load token usage on runtime/server startup and expose totals via API/SSE.
  - [x] Record provider usage from `Done.content.usage` into `/kikx/tokens.json`.
  - [x] Store per-frame token usage on user and agent frames.
  - [x] Remove AgentMessage cascade depth blocking while still preventing self-delivery.
  - [x] Add cost-aware agent prompt instructions and tests.
  - [x] Display token totals in the status bar with Stagehand coverage.
  - [x] Verify focused, full, and UI tests.

- [x] Broadcast visible agent messages to other session agents without loops.
  - [x] Add routing tests for visible `AgentMessage` delivery to other agents.
  - [x] Add loop-guard tests for hidden placeholders, self-delivery, and cascade depth.
  - [x] Add prompt tests for agent-authored trigger frames.
  - [x] Implement agent-route cascade metadata and `AgentMessage` selector registration.
  - [x] Fix queued router commits to route their committed frame version.
  - [x] Verify focused and full tests.

- [x] Broadcast normal user messages to all invited session agents.
  - [x] Add focused routing tests for all-agent normal message dispatch.
  - [x] Keep explicit coordinator forwarding pathway intact.
  - [x] Update prompt/tool tests so non-coordinators can null on normal messages.
  - [x] Verify focused and full tests.

- [x] Investigate Session 2 apparent missing Iron-Hand message.
  - [x] Read recent Session 2 frames including hidden/deleted routing frames.
  - [x] Determine whether Iron-Hand produced a visible message, hidden forwarding placeholder, null placeholder, or no durable frame.
  - [x] Report whether data was trampled or the UI is accurately hiding routing internals.

- [x] Investigate why coordinator still forwards after prompt change.
  - [x] Compare latest Session 2 frame times/orders against prompt-change deployment.
  - [x] Verify the running server is using the post-`bc819af` prompt code.
  - [x] Check whether tool definitions still bias the model toward `internal-forward`.
  - [x] Identify whether this is stale runtime, stale conversation context, or prompt/tool contract.

- [x] Ignore local `cxp.sh` helper script.

- [x] Fix `dev:watch` startup against local `.env.dev`.
  - [x] Add focused watcher tests for `.env.dev` loading and refused health probes.
  - [x] Load `.env.dev` before deriving the health URL.
  - [x] Treat failed health fetches as unhealthy instead of fatal.
  - [x] Verify focused and full tests.

- [x] Expand coordinator recipient-inference instructions.
  - [x] Inspect Session 2 to identify the missed forwarding case.
  - [x] Add prompt tests for explicit recipient self-questioning and turn-taking.
  - [x] Include session agent names/ids in the agent prompt without secrets.
  - [x] Tighten coordinator and forwarded-target routing instructions.
  - [x] Verify focused and full tests.

- [x] Revise coordinator prompt to prefer null over normal session forwarding.
  - [x] Add focused prompt coverage for coordinator null guidance.
  - [x] Remove normal intra-session forwarding guidance from coordinator instructions.
  - [x] Keep coordinator forwarding tool available for explicit/future forwarding paths.
  - [x] Verify focused and full tests.

- [x] Read aeor-web-components skill and API surfaces.
- [x] Serve kikx client assets and aeor-web-components assets from the Node server.
- [x] Build the initial kikx browser shell with Element Builder, ReactiveState, Query Engine, and shared components.
- [x] Document the frontend policy and shared-component boundary.
- [x] Add tests and run the full suite.
- [x] Remove human-HML composer wording, the context checkbox, and the right sidebar.
- [x] Add first AeorDB-backed auth proxy routes and browser sign-in shell.
- [x] Read all archived project plan files and summarize project direction/questions.
- [x] Build new core foundation from old-app inspiration: plugin system, FrameEngine, FrameRouter.
- [x] Add AeorDB persistence adapter for FrameEngine sessions, commits, frames, and indexes.
- [x] Wire FrameEngine and AeorDBFrameStore into runtime session/message API endpoints.
- [x] Add npm scripts for AeorDB and Kikx dev startup.
- [x] Move connection status to bottom bar and tighten empty-session controls.

- [x] Fix /api/v1/sessions 500 during authenticated UI load.

- [x] Add AeorDB operational safety SKILL.md for corruption evidence and graceful start/stop.

- [x] Add numbered session defaults, session list spacing, and session rename modal.

- [x] Fix Session Edit modal Save button action.

- [x] List sessions from AeorDB and lazily open active sessions after Kikx restart.

- [x] Preserve and persist session message counts across selection changes.
  - [x] Move session list/details into a global reactive client state queue.
  - [x] Keep frame hydration scoped to the selected session.
  - [x] Add state reducer tests for inactive session metadata.

- [x] Add Enter-to-send composer keyboard behavior.

- [x] Add AeorDB-backed agent management CRUD.
  - [x] Add agent persistence store and tests.
  - [x] Add `/api/v1/agents` server routes and tests.
  - [x] Add global reactive agent state.
  - [x] Add browser agent management UI.
  - [x] Run full verification and restart Kikx.

- [x] Split agent list and create/edit modals.

- [x] Render plugin-declared select fields with shared `aeor-select`.

- [x] Expand Codex/OpenAI plugin model choices.

- [x] Fix Agent Create modal footer button action.

- [x] Add one-command dev stack startup script.

- [x] Add routed slash-command support and `/invite` agent sessions.
  - [x] Add command registry/parser and internal invite command.
  - [x] Persist idempotent session participant agent IDs.
  - [x] Wire command routing before future agent routing.
  - [x] Verify `/invite agent-name` and `/invite agent-id`.

- [x] Support quoted agent names in `/invite`.

- [x] Fix `/invite` agent lookup returning raw AeorDB HTTP 404 for agent names with spaces.

- [x] Fix routed command results appearing only after the next message.

- [x] Add SSE-driven frame/session updates so routed frames appear without manual reloads.
  - [x] Emit runtime frame events for persistent and phantom frames.
  - [x] Add a Kikx SSE endpoint scoped to session/global runtime events.
  - [x] Consume Kikx SSE in the browser global reactive state.
  - [x] Verify live AI chat with Playwright.

- [x] Hook invited agents into low-priority frame routing.
  - [x] Add generic agent dispatch after slash/internal routing.
  - [x] Make API message appends await routed agent side effects.
  - [x] Implement Codex/OpenAI streaming in the Codex plugin.
  - [x] Persist final agent output and emit phantom thinking/output frames while streaming.

- [x] Fix invited agents not receiving messages until server restart.
  - [x] Add regression coverage for `/invite` followed by a normal message in the same active runtime session.
  - [x] Keep router session context current after participant updates.
  - [x] Run focused and full verification.

- [x] Fix agent streaming UX and cached context.
  - [x] Emit BeginTyping/EndTyping phantoms around provider streams.
  - [x] Coalesce streamed thinking/output into single dynamic frames instead of one row per chunk.
  - [x] Remove live phantoms when the final durable agent message arrives.
  - [x] Pass rolled-up frame history to agent providers and use OpenAI prompt caching.
  - [x] Add typing indicator WebComponent based on old app behavior.
  - [x] Run plugin, focused app, full app, and browser verification.

- [x] Attach streamed agent thinking to the original agent response frame.
  - [x] Pre-create the agent response frame before provider API calls.
  - [x] Tie thinking/output phantom frames to the response frame id.
  - [x] Persist final response JSON with a durable `content.thinking` block.
  - [x] Verify focused plugin, routing, and full app tests.

- [x] Fix frame display ordering for finalized agent response frames.
  - [x] Track latest frame commit position separately from stable frame creation order.
  - [x] Hydrate frames by commit history and surface missing committed frame bodies as evidence placeholders.
  - [x] Write frame bodies before commit records to avoid publishing commits that point at missing frames.
  - [x] Keep live SSE frame state sorted by commit order while preserving unordered phantom arrival order.

- [x] Fold response-bound thinking phantoms into their AgentMessage frame in the browser.
  - [x] Keep `AgentThinking` PhantomFrames transitory and non-persistent.
  - [x] Merge `content.thinking` into the response frame state instead of rendering a second thinking row.
  - [x] Preserve accumulated thinking when the final AgentMessage event arrives.

- [ ] Clear current test sessions and frames from AeorDB while preserving agents.
  - [x] Preserved pre-delete and post-delete AeorDB evidence copies.
  - [x] Removed normal session manifests from the test DB while preserving agents.
  - [x] Created AeorDB bug report for recursive listing/delete inconsistency.
  - [ ] Fully remove orphaned session-subtree entries after AeorDB storage bug is diagnosed.

- [x] Add high-resolution hybrid-logical frame clocks for deterministic message ordering.
  - [x] Add focused clock tests.
  - [x] Stamp frames and commits with `createdClock` / `updatedClock`.
  - [x] Sort server and client frame views by HLC clocks before legacy numeric fallbacks.
  - [x] Persist/query HLC fields in AeorDB frame/session metadata.

- [x] Verify updated AeorDB build and adopt multi-fetch where Kikx batch-loads files.
  - [x] Read AeorDB `/files/fetch` documentation.
  - [x] Restart local AeorDB with `/home/wyatt/.local/bin/aeordb`.
  - [x] Re-test session creation/listing against the fixed build.
  - [x] Replace repeated per-file fetches with `POST /files/fetch` where appropriate.

- [x] Add Stagehand UI test support.
  - [x] Read current Stagehand v3 docs.
  - [x] Install Stagehand and required test dependencies.
  - [x] Add a local Stagehand test harness.
  - [x] Load the dev OpenAI key from the `Test 1` Kikx agent without printing it.
  - [x] Add a Stagehand UI test for New Session behavior.
  - [x] Verify focused Stagehand test and full app tests.

- [x] Add session coordinators and base agent loop.
  - [x] Persist exactly one `coordinatorAgentID` when a session has participants.
  - [x] Route normal user messages coordinator-first by default.
  - [x] Add deterministic base `AgentInterface` loop primitives and break/finalize tools.
  - [x] Update Codex provider to use the base loop primitive.
  - [x] Verify focused app/plugin tests and full app tests.

- [x] Add @mention routing and coordinator forwarding.
  - [x] Add high-priority internal mention plugin and parser.
  - [x] Resolve mentioned actors by id/name/quoted name and attach top-level `mentions`.
  - [x] Preserve coordinator-first routing, then route coordinated frames to all mentioned session agents.
  - [x] Implement agent `/forward` loop control as frame mutation plus next-tick router requeue.
  - [x] Feed mentions JSON into the agent coordinator primer.
  - [x] Verify with unit tests, Stagehand UI coverage, and Puppeteer/browser confirmation.

- [x] Add agent self-configuration tools and character priming.
  - [x] Map agent config, loop tool, and provider tool-call surfaces.
  - [x] Add tests for persistent agent character configuration.
  - [x] Add hyphenated agent loop tool descriptors and `agent-character-set`.
  - [x] Feed each agent's character into the priming instructions.
  - [x] Expose hyphenated tools through the Codex/OpenAI provider.
  - [x] Verify focused app/plugin tests and full app tests.

- [x] Add Xenocept-inspired Kikx dev watcher.
  - [x] Add a process-group restart wrapper for Kikx dev server.
  - [x] Poll source file fingerprints and restart on change.
  - [x] Add npm script and unit coverage for watcher helpers.
  - [x] Verify watcher tests and relevant script behavior.

- [x] Preserve AeorDB recursive-listing corruption evidence and restore session listing.
  - [x] Copy current DB/log evidence before any workaround.
  - [x] Add read-only shallow session-manifest fallback.
  - [x] Verify `/api/v1/sessions` returns sessions against the corrupt DB.
  - [x] Run focused and full test coverage.

- [x] Restart with fixed AeorDB binary and clean dev database.
  - [x] Preserve old corrupt DB before and after the new-binary retry.
  - [x] Archive the corrupt DB out of the active `.aeordb/kikx.aeordb` path.
  - [x] Restore the existing dev agent into the clean DB.
  - [x] Treat missing clean-DB sessions directory as an empty session list.

- [x] Fix OpenAI tool-name compatibility.
  - [x] Replace provider-facing dotted tool names with hyphenated names.
  - [x] Remove old exposed tool aliases.
  - [x] Add contract tests that reject dotted OpenAI tool names.
  - [x] Verify with a live Kikx agent message smoke.

- [x] Fix `/invite` for punctuated agent names.
  - [x] Reproduce `Mr. Bennett` failing through the live HTTP route.
  - [x] Add command/runtime tests for spaced and punctuated agent names.
  - [x] Fix slash-command argument parsing or agent lookup behavior.
  - [x] Verify with unit tests and a live invite smoke.

- [x] Show configured agent names on agent message frames.
  - [x] Add `authorDisplayName` to agent-authored frame data.
  - [x] Add frame-label and agent-history tests for configured names.
  - [x] Replace hardcoded `frame.type` labels for agent-authored frames.
  - [x] Add Stagehand coverage for rendered agent-name labels.
  - [x] Verify with unit tests, Stagehand, and browser/live checks.

- [x] Fix Kikx web server shutdown with active SSE clients.
  - [x] Add regression coverage for shutdown while an event stream is open.
  - [x] Close idle and active HTTP connections during signal shutdown.
  - [x] Shut down Kikx child processes when npm/dev wrappers are orphaned.
  - [x] Verify focused shutdown tests, full app tests, and real dev-wrapper shutdown.

- [x] Fix agent forwarding infinite loop in Session 2.
  - [x] Inspect Session 2 frames and agent/session metadata from AeorDB.
  - [x] Reproduce the forwarding loop with a focused routing test.
  - [x] Add a loop guard or route eligibility fix without breaking normal forwarding.
  - [x] Verify focused tests and full app tests before restarting anything.

- [x] Fix forwarded target agent not responding after loop guard.
  - [x] Inspect latest Session 2 frames after the no-loop test.
  - [x] Determine whether target routing, provider output, or UI rendering suppressed Mr. Bennett's response.
  - [x] Add focused regression coverage for the failure path.
  - [x] Verify focused and full tests.

- [x] Add global web tools for all agents.
  - [x] Add `web-search` DuckDuckGo instant-answer tool.
  - [x] Add `web-fetch` Puppeteer rendering tool with CDP port 9223 first.
  - [x] Register built-in global tools during server startup.
  - [x] Expose registered global tools through the base agent loop.
  - [x] Add focused unit coverage for tool execution and agent tool exposure.
  - [x] Verify focused and full tests.

- [x] Fix Codex provider continuation after tool calls.
  - [x] Inspect Session 2 frames and identify the `Tool web-search completed.` failure mode.
  - [x] Send tool results back to OpenAI as `function_call_output` with `previous_response_id`.
  - [x] Keep typing/streaming open across tool rounds until a final model answer arrives.
  - [x] Add Codex plugin regression coverage for multi-request function-call handling.
  - [x] Verify the Codex plugin tests.

- [x] Keep agent turns alive when global tools fail.
  - [x] Inspect Session 2 frames and identify the `Unexpected end of JSON input` tool failure.
  - [x] Convert Codex provider tool execution errors into `function_call_output` error payloads.
  - [x] Wrap DuckDuckGo empty/malformed responses with web-search-specific errors.
  - [x] Add Codex plugin and Kikx web-search regression coverage.
  - [x] Verify plugin tests and full Kikx tests.
