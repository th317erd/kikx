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
