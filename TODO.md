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
