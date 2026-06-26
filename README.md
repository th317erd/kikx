# Kikx

Kikx is AEOR Development's modular agent runner: a server-first chat harness where humans, agents, tools, and internal commands communicate through persisted frames. The database remains a searchable collection of raw frames, while the shared `FrameManager` stitches those frames into the coherent message view consumed by the server, browser client, and agent context builders.

The old Mythix/Mythix ORM/Solr application is archived in `old-app/` for reference only. The active implementation is plain Node.js, native browser modules, AeorDB over HTTP, explicit service boundaries, and plugin-defined agent/tool behavior.

## Current Capabilities

- AeorDB-backed sessions, frame history, agents, teams, token usage, tool outputs, user profiles, feedback reports, and context compaction frames.
- Git-like frame flow with `FrameEngine`, `FrameRouter`, and shared `FrameManager` projection.
- Agent plugins for provider-specific configuration and execution, with OpenAI/Codex-style development support.
- Internal slash commands such as `/invite` and `/compact`, routed before agent providers.
- Teams of actors: teams may include agents and real users, and `/invite` can invite a whole team.
- Agentic loop primitives for responding, null responses, forwarding, progress updates, continuation scheduling, todo lists, per-session cwd, and completion self-review.
- Tool system with persisted tool results, typed tool frames, range/grep/search access for large outputs, web search/fetch, database search/fetch, file read/write, async shell execution, process inspection, session/team management, todo management, and feedback reporting.
- Browser client with magic-link auth, sessions, agents, teams, account profile editing, markdown rendering, custom tool-frame components, token/status display, SSE updates, and no shadow DOM.
- Asynchronous context compaction using `CompactionFrame` records and a manual `/compact` command.

## Requirements

- Node.js 22 or newer.
- AeorDB binary at `/home/wyatt/.local/bin/aeordb`, or set `AEORDB_BIN`.
- AEOR shared browser components at `~/Projects/aeor-web-components`.
- A local `.env.dev` for development defaults when needed.

Kikx defaults to:

- Kikx server: `http://127.0.0.1:3000`
- AeorDB HTTP: `http://127.0.0.1:6830`
- AeorDB database: `.aeordb/kikx.aeordb`
- AeorDB log: `/tmp/codex/kikx/aeordb.log`

## Development

Install dependencies:

```bash
npm install
```

Start the full local dev stack:

```bash
npm run dev
```

This starts AeorDB if needed, waits for `/system/health`, starts Kikx if needed, and prints the local URL.

Start only AeorDB:

```bash
npm run start:aeordb
```

Start only Kikx:

```bash
npm run start:kikx
```

Restart Kikx automatically when source files change:

```bash
npm run dev:watch
```

`dev:watch` expects AeorDB to already be running. It watches `src`, `scripts`, `package.json`, and `.env.dev`, and intentionally ignores runtime/generated directories such as `.aeordb`, `.git`, `node_modules`, `old-app`, and `.stagehand`.

Generate a development magic login link:

```bash
npm run magic-link
```

The login-link script defaults to `wegreenway@taraani.org`. To target another account:

```bash
npm run magic-link -- user@example.com
```

The script talks to the running Kikx server. Override with `KIKX_URL` when needed.

## Useful Environment Variables

- `KIKX_HOST`, `KIKX_PORT`: Kikx bind host/port.
- `AEORDB_URL`: AeorDB base URL used by Kikx.
- `AEORDB_BIN`: AeorDB executable path.
- `AEORDB_DATABASE`: local `.aeordb` database path.
- `AEORDB_HOST`, `AEORDB_PORT`: AeorDB bind host/port.
- `AEORDB_LOG_PATH`: log path used by the magic-link helper.
- `AEORDB_LOG_MAGIC_LINKS=1`: enables dev magic-link logging.
- `KIKX_WATCH_PATHS`: comma-separated dev-watch paths.

Do not commit local secrets or root keys.

## Architecture

The active runtime boundaries are:

- `src/core/aeordb/`: HTTP client and AeorDB-backed stores.
- `src/core/frames/`: `FrameEngine`, merge behavior, clocks, and shared frame exports.
- `src/shared/frame-manager/`: browser-safe `FrameManager` that projects raw frames into coherent messages.
- `src/core/routing/`: frame router and selector compiler.
- `src/core/commands/`: slash command registration and command router plugin.
- `src/core/agents/`: agent manager, todo/cwd stores, and agent route plugin.
- `src/core/plugins/`: plugin interfaces, registry, loader, agent interface, and agentic script templates.
- `src/core/tools/`: built-in tools, process manager, tool output storage, and client component metadata.
- `src/core/compaction/`: compaction prompt, context builder, and background compaction service.
- `src/core/teams/`: actor team management.
- `src/server/`: plain Node HTTP server, API routes, static module serving, SSE, and shutdown.
- `src/client/`: native browser client built with AEOR frontend primitives.

The server exposes browser modules from:

- `/client/` for Kikx client modules.
- `/shared/` for browser-safe shared Kikx modules.
- `/vendor/aeor-web-components/` for the actively developed shared AEOR component repo.

## Frames And Storage

AeorDB is intentionally treated as durable frame storage, not as the message renderer. Session load is:

1. Load raw frame JSON records from AeorDB.
2. Hydrate the process-local `FrameEngine`.
3. Feed raw frames through `FrameManager`.
4. Use the projected message list for UI, agent context, counts, and API views.

Raw frames remain valuable for history, debugging, indexing, and search. Phantom frames are transitory SSE data and are not persisted. Durable lifecycle frames, tool call/result frames, compaction frames, and message frames are persisted.

The default AeorDB root path is `/kikx`.

## Plugins And Tools

Agent-specific behavior belongs in plugins. Plugins can define:

- Agent provider classes and provider-specific config fields.
- Tool classes and OpenAI-safe tool names.
- Slash commands.
- Client frame/tool components for custom rendering.

The built-in tool execution service stores every tool result in AeorDB. Small outputs are returned inline to the agent; large outputs return a pointer with instructions for `output-read`, `output-grep`, `output-search`, `database-fetch`, or range reads.

Long-running shell work is managed by the async process system. `exec` starts managed processes, waits briefly for very short commands, stores output, exposes process inspection/kill/read/grep tools, and wakes the agent when long work completes.

## Agentic Script

Kikx uses an executable agentic script rather than a hand-copied prompt document. The source of truth is:

- `src/core/plugins/agent-script-template.mjs`
- `src/core/plugins/agent-interface.mjs`
- `docs/agentic-script.md`
- `docs/proper-agent-behavior.md`

The script tells agents how to decide whether to respond, stay silent, use tools, coordinate, delegate to child sessions, update todos, minimize token cost, report progress, and complete self-review before finalizing.

## Frontend

Kikx client code uses AEOR's shared frontend primitives:

- Element Builder for DOM creation.
- `ReactiveState` for dynamic state.
- Query Engine for DOM selection and event helpers.
- Shared components from `~/Projects/aeor-web-components` when a component is reusable across AEOR products.

Product-specific components stay in `src/client/`. Web components must not use shadow DOM.

## Tests

Run all unit tests:

```bash
npm test
```

Run UI test groups:

```bash
npm run test:ui:playwright
npm run test:ui:stagehand
npm run test:ui:puppeteer
```

UI changes should include Stagehand coverage when practical.

## More Documentation

- `docs/architecture.md`: high-level runtime boundaries.
- `docs/frontend.md`: frontend conventions.
- `docs/agentic-script.md`: current agentic script contract.
- `docs/proper-agent-behavior.md`: desired agent behavior.
- `docs/context-compaction.md`: compaction behavior and frame contract.
- `docs/mythix-translation.md`: notes for translating old Mythix-era concepts.
- `bot-docs/`: working notes and bug reports for bots.

