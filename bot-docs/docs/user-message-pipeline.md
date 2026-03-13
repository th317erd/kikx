# User Message Pipeline — HTTP Request to Frame Creation

How a user's chat message flows through the server, becomes a frame, gets
sent to agents, and streams back to clients.

Updated: 2026-03-13

---

## 1. Entry Point — InteractionController.sendMessage()

**File:** `src/server/controllers/interaction-controller.mjs`
**HTTP endpoint:** `POST /api/v2/sessions/:sessionID/interact/send`

### Request body

| Field      | Type   | Required | Notes                                      |
|------------|--------|----------|--------------------------------------------|
| `message`  | string | yes      | Raw user message text                      |
| `agentID`  | string | no       | If omitted, message posted with no agent   |
| `parentID` | string | no       | Parent frame ID for threading              |

### Two code paths

**No-agent path** (status 201):
```
interactionLoop.postMessage(sessionID, {
  text: message,
  authorType: 'user',
  authorID,
  parentID,
})
→ returns { interactionID, frameID }
```

**With-agent path** (status 202, non-blocking):
1. Looks up Agent record, instantiates plugin class via `core.getAgentType(agent.pluginID)`
2. Decrypts agent API key from `agent.encryptedAPIKey` using user's UMK
3. Builds `checkPermission` + `executeTool` callbacks
4. Sets up scheduler: `markActive()` + `setResolveContext()`
5. Calls `interactionLoop.startInteraction()` with all params
6. Returns `{ interactionID }` — frames arrive via SSE/WebSocket

**Key point:** `message` is passed as a raw string (`userMessage: message`) — no
transformation, no markdown conversion at this layer.

---

## 2. InteractionLoop.startInteraction()

**File:** `src/core/interaction/index.mjs`

### User message processing (lines 127–258)

1. **Queue check** — If interaction already active for this agent in this session,
   message is queued and `null` returned
2. **Slash commands** — `/command` messages intercepted before frame creation
3. **FrameManager** loaded and synced from DB
4. **`prepareMessage` hook** — Router plugins can block or transform the message
5. **User-message frame created:**

```js
await this._createFrame(sessionID, {
  id:            generateID('frm_'),
  type:          'user-message',
  content:       { text: params.userMessage, estimatedTokens },
  timestamp:     Date.now(),
  interactionID,
  authorType:    params.authorType || 'user',
  authorID:      params.authorID || null,
  parentID:      params.parentID || null,
  hidden:        false,
  deleted:       false,
  processed:     false,
});
```

**Frame content shape:** `{ text: string, estimatedTokens: number }`

6. **buildMessages()** converts frames to LLM messages:
   - `user-message` → `{ role: 'user', content: frame.content.text }`
   - `message` (agent) → `{ role: 'assistant', content: frame.content.html }`
7. Primer injected, abilities re-injected, then `agentPlugin.execute()` called

### Agent response path (in `_iterateGenerator`)

Agent yields blocks: `{ type: 'message', content: { html } }`.
The HTML is run through `sanitizer.sanitize(html)` before being saved.

**Summary:**
- **User frames** store `content.text` (plain text)
- **Agent frames** store `content.html` (sanitized HTML)

---

## 3. ContentSanitizer

**File:** `src/core/lib/content-sanitizer.mjs`

### Methods

| Method | Purpose |
|--------|---------|
| `sanitize(html)` | Main entry — strips dangerous tags, processes remaining |
| `registerCustomElement(tagName, attrs)` | Plugins can add custom allowed elements |
| `unregisterCustomElement(tagName)` | Remove plugin-registered elements |
| `getAllowedTags()` | Returns current allowlist |

### Whitelisted HTML tags

| Category | Tags | Attributes |
|----------|------|------------|
| Formatting | `b`, `i`, `em`, `strong` | (none) |
| Code | `code`, `pre` | `class` |
| Headings | `h1`–`h6` | `id`, `class` |
| Block | `p`, `div`, `span`, `blockquote`, `br`, `hr` | `class` / `id`, `class` |
| Links | `a` | `href`, `title`, `target`, `rel`, `class` |
| Images | `img` | `src`, `alt`, `title`, `width`, `height`, `class` |
| Lists | `ul`, `ol`, `li` | `class`, `start`/`type` |
| Tables | `table`, `thead`, `tbody`, `tr`, `th`, `td` | `class`, `colspan`, `rowspan` |
| Custom | `kikx-hml-prompt`, `kikx-hml-option` | various |

### Dangerous tags (removed with content)

`script`, `iframe`, `style`, `object`, `embed`, `applet`, `form`, `input`,
`textarea`, `select`, `button`

### Security rules

- `on*` event handler attributes always stripped
- `javascript:` URIs in `href`/`src`/`action` stripped
- Attribute values HTML-entity encoded in output

**Currently:** Sanitizer is only called on **agent output**. User message text is
stored as-is in `content.text`.

---

## 4. Transport Layer (SSE / WebSocket)

### SSE — StreamController

**File:** `src/server/controllers/stream-controller.mjs`
**Endpoint:** `GET /api/v2/sessions/:sessionID/stream`

Attaches listeners to `interactionLoop` (EventEmitter) and forwards events:
`frame`, `commit`, `interaction:start`, `interaction:end`, `permission:request`,
`delta`, `reflection-delta`, `usage`, `relay:delta`, `relay:reflection-delta`.

### WebSocket — WebSocketTransport

**File:** `src/server/transport/websocket-transport.mjs`
**Endpoint:** `/api/v2/ws?token=<JWT>`

Client sends: `{ type: 'subscribe', sessionID, lastSeenOrder? }`
Server pushes: `{ type: 'frame', frame }`, `interaction:start`, `interaction:end`

**Key point:** WebSocket is **outbound-only** (subscriptions + frame streaming).
There is no `sendMessage` path over WebSocket — all user messages go through
the HTTP REST endpoint.

---

## 5. Plugin System

### Class hierarchy

```
PluginInterface (src/core/plugin-loader/plugin-interface.mjs)
  └── AgentInterface (src/core/plugins/agent-interface.mjs)
        └── ClaudeAgent, etc. (external plugins)
```

### PluginInterface

- Constructor takes `context` (a `CascadingContext`)
- `execute(params)` → `_execute(params)` (override for tools)
- Static metadata: `pluginID`, `featureName`, `displayName`, `description`, `riskLevel`

### AgentInterface

- `execute(params)` calls `async *_createGenerator(params)` and returns generator
- Generator yields typed blocks:
  - `{ type: 'message', content: { html }, authorType, authorID }`
  - `{ type: 'tool-call', content: { toolName, arguments } }`
  - `{ type: 'reflection', content: { text }, hidden: true }`
  - `{ type: 'done', content: {} }`
- `getSystemPrompt(agent, context)` — assembles system prompt
- `assembleMessages(messages, systemPrompt)` — formats for API

### Service access

Plugins use `this._context.getProperty('serviceName')` to access shared services:
- `sessionManager`, `framePersistence`, `contentSanitizer`
- `interactionLoop`, `sessionScheduler`

---

## 6. Frame Content Model Summary

| Frame type | `content` shape | Example |
|-----------|----------------|---------|
| `user-message` | `{ text, estimatedTokens }` | `{ text: "hello", estimatedTokens: 2 }` |
| `message` (agent) | `{ html }` | `{ html: "<p>Hello!</p>" }` |
| `tool-call` | `{ toolName, arguments, toolUseID }` | — |
| `tool-result` | `{ toolUseID, result }` | — |
| `pending-action` | `{ toolName, arguments, toolUseID }` | — |
| `error` | `{ html }` | — |
| `reflection` | `{ text }` | — |
| `session-link` | `{ linkedSessionID, linkedFrameID }` | — |
