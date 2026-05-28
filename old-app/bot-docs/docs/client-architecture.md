# Kikx — Client Architecture

The Kikx client is a Web Components single-page application with a glass-morphism UI. It has **no build step** — ES modules are loaded directly by the browser via import maps, and nginx serves the static files.

---

## Technology

- **Web Components** — Custom HTML elements with Shadow DOM
- **No framework** — Vanilla `HTMLElement` subclasses, no React/Vue/Angular
- **ES modules** — Native browser `import` with import maps
- **Reactive store** — Lightweight scoped state management
- **WebSocket** — Real-time frame delivery
- **CSS custom properties** — Theming with glass-morphism design
- **~10,300 lines** across 30 components + libraries

---

## Component Pattern

Each component follows this structure:

```
src/client/components/kikx-component-name/
  kikx-component-name.mjs     JavaScript class (extends HTMLElement)
```

Templates are defined as inline template literals (no separate HTML files):

```javascript
'use strict';

const TEMPLATE_HTML = `
  <style>
    :host { display: block; /* ... */ }
  </style>
  <div class="container">
    <!-- markup -->
  </div>
`;

export class KikxComponentName extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = TEMPLATE_HTML;
  }

  connectedCallback() {
    // Setup: subscribe to store, bind events
  }

  disconnectedCallback() {
    // Cleanup: unsubscribe, remove listeners
  }
}

customElements.define('kikx-component-name', KikxComponentName);
```

---

## Component Inventory (30 Components)

### Pages (4)

| Component | Purpose |
|-----------|---------|
| `kikx-application` | Root app container, route dispatcher |
| `kikx-login-page` | Email/password login form |
| `kikx-session-page` | Main chat interface (grid layout with all sub-components) |
| `kikx-settings-page` | User settings with tabbed sections |

### Layout (5)

| Component | Purpose |
|-----------|---------|
| `kikx-top-bar` | Header: session name, buttons, rainbow gradient border |
| `kikx-sidebar` | Right sidebar: session list, agents, participants |
| `kikx-chat-view` | Scrollable message container with auto-scroll |
| `kikx-status-bar` | Footer: connection status, cost tracking |
| `kikx-modal` | Backdrop + panel container for all modals |

### Messages (5)

| Component | Purpose |
|-----------|---------|
| `kikx-interaction` | Single message bubble (header, content, footer) |
| `kikx-message-content` | Renders sanitized HTML with custom block renderers |
| `kikx-message-input` | Text input for composing messages |
| `kikx-scroll-anchor` | Invisible anchor for auto-scroll detection |
| `kikx-websocket-manager` | Invisible component managing WebSocket connection |

### Content Blocks (5)

| Component | Purpose |
|-----------|---------|
| `kikx-command-result` | Collapsible shell command execution output |
| `kikx-reflection-block` | Collapsible agent reasoning/thinking |
| `kikx-websearch-result` | Web search result display |
| `kikx-hml-prompt` | Dynamic form renderer (interactive prompts) |
| `kikx-hml-prompt-value` | Single form field within a prompt |

### Permission (1)

| Component | Purpose |
|-----------|---------|
| `kikx-permission-request` | Shell command approval UI with per-command buttons |

### User/Avatar (2)

| Component | Purpose |
|-----------|---------|
| `kikx-user-avatar` | Circular avatar with initials and color |
| `kikx-participant-list` | Session participants list |

### Lists (3)

| Component | Purpose |
|-----------|---------|
| `kikx-session-list` | List of user's sessions in sidebar |
| `kikx-session-link` | Single session list item |
| `kikx-friends-list` | Agent shortcuts list |

### Modals (5)

| Component | Purpose |
|-----------|---------|
| `kikx-create-session-modal` | Create new session form |
| `kikx-agent-list-modal` | Agent selection for sessions |
| `kikx-agent-form-modal` | Create/edit agent form |
| `kikx-add-friend-modal` | Add agent/friend shortcut |
| `kikx-settings-tabs` | Tabbed settings content |

---

## State Management

The store (`src/client/lib/store.mjs`) provides reactive state with scoped accessors:

```
Scopes:
  sessions   — add, remove, update, getSession, getActiveSession, getAllSessions
  agents     — add, remove, update, getAgent, getAllAgents
  profile    — setUser, getUser, updateUser, isAuthenticated, logout
  theme      — setBase, setAccent, getBase, getAccent
  connection — setStatus, updateCosts, getStatus, getCosts
```

Components subscribe to store updates and re-render:

```javascript
store.on('update', () => this.render());
```

Updates are batched via microtask scheduling — multiple rapid state changes trigger a single re-render.

---

## Communication

### REST API (`src/client/lib/api.mjs`)

Base URL: `/kikx/api/v2`. Bearer token auth in headers.

Key endpoints:
- `api.login(email, password)` — POST `/auth/login`
- `api.getAgents()` — GET `/agents`
- `api.getSessions()` — GET `/sessions`
- `api.getFrames(sessionID)` — GET `/sessions/:id/frames`
- `api.sendMessage(sessionID, text, agentID)` — POST `/sessions/:id/interact/send`
- `api.approvePermission(sessionID, frameID, decisions)` — POST `/sessions/:id/interact/:frameID`

Auth token persisted to `localStorage`.

### WebSocket (`kikx-websocket-manager`)

- Connects to `/api/v2/ws?token=...`
- Auto-reconnect with exponential backoff (1s to 30s)
- Message types received:
  - `{ type: 'frame', frame }` — New/updated frame
  - `{ type: 'replay-complete' }` — Reconnection replay finished
  - `{ type: 'interaction:start', sessionID, interactionID }` — Agent started responding
  - `{ type: 'interaction:end', sessionID, interactionID }` — Agent finished
- Subscription: `{ type: 'subscribe', sessionID, lastSeenOrder? }` for replay on reconnect

---

## Routing

The router (`src/client/lib/router.mjs`) uses the History API:

| Route | Page | Auth Required |
|-------|------|---------------|
| `/kikx/login` | `kikx-login-page` | No |
| `/kikx/` | `kikx-session-page` | Yes |
| `/kikx/sessions/:id` | `kikx-session-page` (specific session) | Yes |
| `/kikx/settings` | `kikx-settings-page` | Yes |

Auth guards redirect unauthenticated users to login. 401 responses trigger auto-logout.

---

## Key Workflows

### Login

1. User submits credentials via `kikx-login-page`
2. `api.login()` returns JWT token
3. Token stored in `localStorage` and `store.profile`
4. Router navigates to `/kikx/`

### Chat

1. User selects session -> navigate to `/kikx/sessions/:id`
2. Frames fetched via `api.getFrames(sessionID)`
3. Frames loaded into local `FrameManager`
4. Each frame renders as a `kikx-interaction` component
5. User types message -> `api.sendMessage()` -> server returns interaction ID
6. Server streams frames via WebSocket
7. Client merges new frames into FrameManager, DOM updates reactively

### Streaming

- Server sends phantom frames over WebSocket (partial content)
- Phantom frames with the same `groupID` merge into a single display frame
- `kikx-message-content` re-renders as content accumulates
- Auto-scroll keeps the view anchored to the bottom

### Permission Approval

1. Server sends `permission-request` frame via WebSocket
2. `kikx-permission-request` renders per-command approve/deny buttons
3. User decides for each command
4. Client sends decisions via `api.approvePermission()`
5. Server executes approved commands, returns result frames

---

## Styling

### Glass-Morphism Design

The UI uses a dark, translucent aesthetic with neon accents:

```css
:host {
  background: var(--glass-background, rgba(255, 255, 255, 0.05));
  backdrop-filter: blur(var(--glass-blur, 16px));
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
}
```

### CSS Custom Properties

| Variable | Purpose |
|----------|---------|
| `--background-base` | Dark navy background |
| `--glass-background` | Semi-transparent white |
| `--glass-blur` | Backdrop blur amount |
| `--text-primary` | Main text color |
| `--text-secondary` | Muted text color |
| `--accent-primary` | Neon cyan (#00e5ff) |
| `--spacing-xs/sm/md/xl` | Spacing scale |
| `--border-radius-*` | Border radius scale |

### Rainbow Accents

Top bar and status bar feature gradient rainbow borders:

```css
background: linear-gradient(90deg, #ff4081, #b040ff, #448aff, #00e5ff, #00e676, #ffea00, #ff9100);
```

---

## Security

### XSS Protection (Multi-Layer)

1. **Server-side**: `ContentSanitizer` (primary defense, whitelisted tags)
2. **Client-side denylist**: Dangerous tags removed (`script`, `iframe`, `form`, `input`, `style`, `link`, `meta`)
3. **Attribute stripping**: Event handlers (`on*`), JavaScript URIs (`javascript:` in href/src)
4. **Link safety**: All external links get `target="_blank" rel="noopener noreferrer"`

---

## Shared Code (`src/shared/`)

The `FrameManager` is shared between server and client:

- `frame-manager.mjs` — In-memory frame history with commit log
- `frame.mjs` — Immutable frame data structure
- `frame-pointer.mjs` — Named references to commits
- `deep-merge.mjs` — Deep merge for phantom frame collapsing
- `event-emitter.mjs` — Simple EventEmitter
- `create-store.mjs` — Store factory

---

## Deployment

```
nginx
  |-- Serves src/client/ at /kikx/ (static files)
  |-- Serves src/shared/ at /kikx/lib/ (shared modules)
  |-- Proxies /kikx/api/ -> localhost:8089 (Mythix server)
  \-- Proxies /kikx/ws -> localhost:8089 (WebSocket)
```

No build step, no bundler, no transpilation. Browser-native ES modules with import maps.
