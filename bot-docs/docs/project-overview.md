# Kikx — Project Overview

Kikx is an **AI agent orchestration platform** — a multi-agent, multi-user chat system where humans and AI agents collaborate in persistent sessions. Think of it as a self-hosted Discord where your bots are first-class participants with real tool access, permissions, and cryptographic identity.

---

## What Kikx Does

- **Multi-agent sessions**: Multiple AI agents (Claude, GPT, etc.) participate in the same conversation alongside human users
- **Plugin-based tool system**: Agents can execute shell commands, search the web, manage memory, and use custom tools — all gated by a permission engine
- **Permission engine**: Rule-based access control with risk levels, session-scoped rules, and human-in-the-loop approval for dangerous operations
- **Cryptographic identity**: Ed25519 key pairs for agents and users, frame signing for integrity, signed value storage for tamper detection
- **Frame-based architecture**: All communication (messages, tool calls, permission requests, errors) is represented as immutable, ordered, signed "frames"
- **Embeddable core**: The engine has zero HTTP dependencies — it can run in a web server, CLI, Discord bot, or Electron app

---

## Architecture

Kikx is split into four layers:

```
src/
  core/       Embeddable engine (zero HTTP). Models, plugins, permissions,
              interaction loop, routing, crypto, primer assembly.
  server/     Thin HTTP wrapper (Mythix framework). REST API, WebSocket
              transport, auth middleware, controllers.
  client/     Web Components SPA. 30+ components, reactive store,
              WebSocket real-time updates, glass-morphism UI.
  shared/     Code shared between server and client. FrameManager,
              EventEmitter, deep-merge utilities.
```

### Core Engine (`KikxCore`)

The core is the heart of Kikx. It manages:

1. **Database** — Mythix ORM with SQLite (configurable), 9 models
2. **Plugin loading** — Internal and external plugins register tools, commands, selectors, and instructions
3. **Permission engine** — Rule-based evaluation with session ancestry walk-up
4. **Frame router** — Event-driven routing of frame changes to registered plugin handlers
5. **Primer assembler** — Builds the system prompt (primer) injected into the first message of each interaction

### Server Wrapper

The server adds HTTP/WebSocket transport on top of the core:

- **REST API** at `/api/v2/` — Auth, agents, sessions, interactions, frames, permissions
- **WebSocket** at `/api/v2/ws` — Real-time frame streaming with reconnection support
- **Auth** — JWT-based authentication with per-user encryption keys (UMK)
- **Controllers** — Thin adapters that translate HTTP requests into core operations

### Client

A Web Components SPA served as static files through nginx:

- **No build step** — ES modules loaded directly by the browser via import maps
- **30 components** — Login, session chat, agent/session management, permissions UI, settings
- **Reactive store** — Lightweight scoped state management with microtask batching
- **WebSocket** — Real-time frame delivery with auto-reconnect

---

## Key Concepts

### Frames

Frames are the atomic unit of communication. Every message, tool call, permission request, and system event is a frame:

```
Frame {
  id            — Unique XID (frm_...)
  type          — 'user-message', 'message', 'tool-call', 'tool-result',
                  'permission-request', 'error', 'reflection', etc.
  content       — Type-specific JSON payload
  authorType    — 'user', 'agent', or 'system'
  authorID      — Who created this frame
  parentID      — Parent frame (for hierarchical conversations)
  order         — Monotonic counter per session
  signature     — Ed25519 signature (hex)
  phantom       — Fire-and-forget (streaming tokens, not persisted individually)
  groupID       — Phantom frames collapse into a group frame
}
```

Frames are **append-only** — they are never mutated, only logically deleted. This provides an auditable, replayable communication history.

### Sessions

Sessions are persistent conversations. Each session has:

- **Participants** — Agents bound to the session
- **Frames** — The conversation history (managed by FrameManager)
- **Type** — `'chat'` (normal) or `'dm'` (agent configuration channel)
- **Hierarchy** — Sessions can have parent/child relationships (sub-sessions)
- **Context** — Key-value metadata stored in ValueStore, inherited down the session tree

### Agents

Agents are configured AI instances. Each agent has:

- **Plugin type** (`pluginID`) — Which AI provider to use (e.g., `claude`, `openai`)
- **Encrypted API key** — Stored encrypted with a per-user derived key
- **Instructions** — Custom system prompt additions
- **Ed25519 key pair** — For signing frames and value store entries
- **Behaviors** — User-defined behavioral rules that customize the agent's behavior

### Plugins

Plugins extend Kikx with tools, commands, and event handlers:

- **Tools** — Operations agents can invoke (shell, web search, memory, etc.)
- **Commands** — System commands (slash commands like `/reload`)
- **Selectors** — Frame event handlers triggered by matching patterns
- **Instructions** — Text injected into agent primers
- **Hooks** — Lifecycle callbacks (before_interaction, after_message, etc.)

See [Plugin System](./plugin-system.md) for details.

### Permissions

Every tool call goes through the permission engine:

1. **Risk level** — Tools declare `none` (auto-allow), `low`, `high`, or `critical` (always needs approval)
2. **Rules** — Stored rules with `allow`/`deny` effects, scoped to global, session, or frame
3. **Session ancestry** — Rules propagate from parent sessions to children
4. **Custom matching** — Plugins can provide custom permission logic (e.g., per-command matching for shell)
5. **Hard-break** — When approval is needed, the interaction stops. On approval, a new interaction replays the full context.

### Interaction Loop

The interaction loop drives agent communication:

1. User sends a message
2. Server loads session frames and builds message history
3. Primer is injected into the first message (system prompt, plugin instructions, behaviors)
4. Agent plugin runs as an async generator, yielding text blocks and tool calls
5. Tool calls are permission-checked; approved tools execute and return results
6. All outputs become frames, signed and persisted
7. Frames are broadcast to connected clients via WebSocket

---

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 24+ (required for `node:sqlite`) |
| HTTP Framework | Mythix |
| ORM | Mythix ORM + SQLite |
| WebSocket | `ws` library |
| Client | Vanilla Web Components (no framework, no build step) |
| Crypto | Ed25519 (signing), AES-256-GCM (encryption), PBKDF2 (key derivation) |
| Markdown | `marked` (parse) + `turndown` (HTML-to-Markdown conversion) |
| IDs | XID (distributed, time-ordered, collision-resistant) |

---

## Running Kikx

```bash
# Start the server (requires Node 24+)
KIKX_PLUGIN_PATHS=~/Projects/kikx-workspace node src/server/index.mjs

# Run tests
npm test

# Add a user
npm run add-user
```

- **Server port**: 8089
- **Database**: `~/.config/kikx/kikx.db` (SQLite)
- **nginx** serves static client files and proxies API/WebSocket requests to the Node server

---

## Related Documentation

- [Data Models](./data-models.md) — All database models, fields, and relationships
- [Plugin System](./plugin-system.md) — Plugin architecture, tool development, internal plugins
- [Client Architecture](./client-architecture.md) — Web Components, state management, UI patterns
- [User Message Pipeline](./user-message-pipeline.md) — Full data flow from HTTP request to frame creation
- [Permission System](./permission-system.md) — Rule evaluation, risk levels, approval lifecycle
- [ValueStore Signing](./valuestore-signing.md) — Ed25519 signing for tamper-proof stored values
- [Signing Surface Area](./signing-surface-area.md) — Complete inventory of all signing operations
