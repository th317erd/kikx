# Session Memory (2026-03-04)

## Changes Made This Session

### UI Polish & Bug Fixes
- **User chat bubble color** now follows active accent/theme color (`--accent-dim` / `--accent-glow`) instead of hardcoded red/pink. Changed in both `theme.css` and `kikx-interaction.mjs`.
- **Status bar cost values** colored with `--accent-text` via `.cost-value` CSS class. Category labels ("Global", "Service", "Session") remain `--text-secondary`.
- **Message input padding** increased: `:host` uses `--spacing-md` (16px) horizontal, `.input-area` uses `--spacing-md` (16px) horizontal for proper Send button breathing room.
- **Interaction component layout**: Timestamp moved from header to footer. Footer format is "timestamp / ~N tokens" (combined in `.footer-meta` span). Header now only shows avatar + name.

### Token Tracking (Server-Side)
- **Server estimates user message tokens** in `InteractionLoop.startInteraction()`: `Math.ceil(text.length / 4) * agentCount`. Stored as `content.estimatedTokens` in user-message frames. Persists across reload.
- **SSE user-message frames** no longer fully skipped on client — they find the optimistic bubble and set `token-count`, `data-frame-id`, `data-interaction-id` from server data.
- **Usage event** sets output tokens on agent bubbles only (`[alignment="agent"]` selector prevents overwriting user bubble).
- **History rendering** reads `estimatedTokens` from frame content for user messages.

### Bug: querySelector + Shadow DOM
- `this._chatView.querySelector(...)` can't find interactions inside `kikx-chat-view`'s shadow DOM. Must use `this._chatView.shadowRoot.querySelector(...)` instead. The interactions are appended via `appendInteraction()` into the shadow DOM's `.interaction-stream` div, not as light DOM children.

### Bug: Usage selector collision
- Both user and agent bubbles can share the same `data-interaction-id`. The `_handleUsage` selector must include `[alignment="agent"]` to avoid overwriting the user bubble's estimated tokens with the agent's output tokens.

## Key Reminders
- **Anthropic prompt cache**: `cache_control: { type: 'ephemeral' }` caches context for ~5 minutes. Deleting DB frames doesn't clear the agent's "memory" until cache expires.
- **Server restart required** after changing any file in `src/core/` or `src/server/` — client files are served fresh on reload.
- **V2 server PID**: check with `ps aux | grep 'node.*index.mjs'`
