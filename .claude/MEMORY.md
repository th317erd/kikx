# Session Memory (2026-03-09)

## What We Did This Session

### 1. Committed & Pushed All Uncommitted Work
- Commit `67f31e6`: Agent-less messaging, context truncation, permission denial feedback, UI polish
- Pushed 14 commits to `origin/v2` (was 13 ahead, now synced)
- **1800 tests, 0 failures** — clean

### 2. Reviewed bot-docs Plans
- Read all files in `bot-docs/future-plans/` (22 files at start)
- Read `.claude/conversation.md` — the full Reactive Frame Engine design dialog (Phases A-D)
- Cross-referenced plans against implemented code

### 3. Dropped Stale Plans
- **`npm-plugin-support.yaml`** — DELETED. Already implemented: `_loadPlugins()` in `kikx-core.mjs:219` supports internal plugins, data dir, config paths, and `KIKX_PLUGIN_PATHS` env var.
- **`generator-suspension.yaml`** — DELETED. Superseded by Phase C's `next()`/`done()` middleware routing model.
- **`chained-command-permissions-ux.yaml`** — DELETED. Permissions system working as designed with envelope signing.

### 4. Rewrote Plans
- **`configurable-plugin-ordering.yaml`** — Rewritten to scope only API endpoint + org-owner UI for reordering external plugins. Router already supports ordered evaluation.
- **`signatures-federation.yaml`** — Rewritten with "already built" vs "remaining" sections. Documents that Keystore, envelope signing, and PermissionService are COMPLETE. Remaining: per-user Ed25519 keys, per-frame authorship signatures, federation protocol.

### 5. Detailed Plan Reviews (for user)
- Explained `sessions-as-frames.yaml` and `general-re-feed-recovery.yaml` in depth
- Explained `signatures-federation.yaml` and `meta-permissions.yaml` in depth
- Confirmed Phase C3 envelope signing is live and working

## Current State of Plans

### Future Plans Still Active (19 files after cleanup)
**High Priority:**
- `meta-permissions.yaml` — Who can modify permission rules (file paths need V2 update)
- `device-approval-auth.yaml` — Cross-device login without credential transmission

**Medium Priority:**
- `sessions-as-frames.yaml` — Unify sessions + frames into single data model
- `abilities-system.yaml` — Natural language agent customization via DM sessions
- `inter-agent-streaming.yaml` — Member responses streamed to coordinator
- `cross-session-replay-prevention.yaml` — Nonce-based multi-session security
- `general-re-feed-recovery.yaml` — Self-healing for stuck frames after crash

**Low Priority:**
- `signatures-federation.yaml` — Per-user keys + federation (partially built)
- `key-rotation.yaml` — Versioned system key pairs
- `configurable-plugin-ordering.yaml` — API/UI for org owners to reorder plugins
- `multi-coordinator-protocol.yaml`
- `settings-ui-polish.yaml`
- `participant-sidebar.yaml`
- `agent-avatar-picker.yaml`
- `plugin-auto-reload.yaml`
- `structured-command-args.yaml`
- `rich-content-renderers.yaml`
- `message-screenshots.yaml`

## Build Status (as of 2026-03-09)

| Phase | Status |
|-------|--------|
| Phase 1 (MVP, Steps 1-13) | COMPLETE |
| Phase 2 (V1 Parity, Steps 14-19) | COMPLETE |
| Phase 3 (V2 Differentiators) | NOT STARTED |
| Phase A (Commit log, refs, diff) | COMPLETE |
| Phase B (Author fields, ACL, scheduler) | COMPLETE |
| Phase C1 (Frame Router Foundation) | COMPLETE |
| Phase C2 (Scheduling → router plugin) | COMPLETE |
| Phase C3 (Permissions + envelope signing) | COMPLETE |
| Phase C4 (Hooks → routing plugin) | COMPLETE |
| Phase C5 (InteractionLoop slimmed) | COMPLETE |
| Phase D1-D6 (Streaming + viewport) | COMPLETE |
| Context Truncation Phase 1 | COMPLETE |
| Agent-less Messaging | COMPLETE |
| Permission Denial Feedback | COMPLETE |

## Key Conversation.md Context
- `.claude/conversation.md` — The full Reactive Frame Engine design dialog (2026-03-06 to 2026-03-07). User annotates with HTML comments. Contains all design decisions for Phases A-D.
- **conversation.md is owned by another bot instance** per DETAILS.md... BUT this session we read it as a reference to understand what was built. The user asked us to read it.
- Context truncation "Phase 2" (rolling compacts with agent involvement) was discussed in a prior session but never written to a file. No plan exists for it.

## Key Reminders
- **Anthropic prompt cache**: `cache_control: { type: 'ephemeral' }` caches context for ~5 minutes. Deleting DB frames doesn't clear the agent's "memory" until cache expires.
- **Server restart required** after changing any file in `src/core/` or `src/server/` — client files are served fresh on reload.
- **V2 server PID**: check with `ps aux | grep 'node.*index.mjs'`
- **Shadow DOM gotcha**: `this._chatView.querySelector(...)` can't reach into shadow DOM. Must use `this._chatView.shadowRoot.querySelector(...)`.
- **Usage selector collision**: `_handleUsage` must include `[alignment="agent"]` to avoid overwriting user bubble tokens.
