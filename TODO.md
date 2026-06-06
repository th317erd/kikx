# TODO

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
  - [x] Route normal user messages only to the coordinator by default.
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
  - [x] Add namespaced agent loop tool descriptors and `agent.character.set`.
  - [x] Feed each agent's character into the priming instructions.
  - [x] Expose namespaced tools through the Codex/OpenAI provider.
  - [x] Verify focused app/plugin tests and full app tests.

- [x] Add Xenocept-inspired Kikx dev watcher.
  - [x] Add a process-group restart wrapper for Kikx dev server.
  - [x] Poll source file fingerprints and restart on change.
  - [x] Add npm script and unit coverage for watcher helpers.
  - [x] Verify watcher tests and relevant script behavior.
