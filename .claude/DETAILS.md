# Project Details

Important details to remember across sessions.

---

## Planning Workflow

- **`.claude/conversation.md`** — Ephemeral Q&A scratchpad for planning rounds. OVERWRITE each time it's updated. User answers questions inline, then we start a new round.
- **`bot-docs/`** — Persistent planning artifacts (docs/, plan/, test/). Accumulates across sessions.
- **`.claude/TODO.md`** — Execution plan, updated as we go.

## Key File Locations

- **Server entry:** `server/index.mjs`
- **Database:** `~/.config/hero/hero.db`
- **Agent instructions:** `server/lib/processes/__onstart_.md`
- **Streaming routes:** `server/routes/messages-stream.mjs`
- **Interactions system:** `server/lib/interactions/`
- **HML Prompt component:** `public/js/components/hml-prompt.js`
- **Markup processor:** `public/js/markup.js`
- **Frames system:** `server/lib/frames/`
- **Form validation:** `public/js/lib/form-validation.js`
- **Step modal base:** `public/js/components/hero-step-modal/hero-step-modal.js`
- **Step component:** `public/js/components/hero-step/hero-step.js`

## Credentials & Config

- JWT tokens stored in localStorage on frontend
- API keys encrypted in database (`encrypted_api_key` column)
- Config directory: `~/.config/hero/`
- Test login: `claude` / `claude123`

---

## Mythix UI Resources

### Documentation
- **Main docs:** `~/Projects/mythix-ecosystem/mythix-ui-core/docs/`
  - `component-architecture.md` - Component lifecycle, split files, OOP patterns
  - `template-engine.md` - `@@expression@@` syntax, transformers
  - `dynamic-property.md` - Reactive data binding
  - `utils.md` - Utility functions
  - `elements.md` - DOM builder API
  - `query-engine.md` - jQuery-like selection/manipulation
  - `mythix-ui-component.md` - Base class reference
- **README:** `~/Projects/mythix-ecosystem/mythix-ui-core/README.md`

### Example Applications
- **Genesis Forge Client:** `~/Projects/genesis-forge-client` - Example Mythix UI app
- **Mythix.info Website:** `~/Projects/mythix.info` - Documentation website (also a Mythix UI app)

### Hero Component Examples
- **Split file pattern:** `public/js/components/hero-sessions-list/` (HTML + JS)
- **Base component:** `public/js/components/hero-base.js` (GlobalState, HeroComponent)
- **Modal base:** `public/js/components/hero-modal/hero-modal.js` (HeroModal extends MythixUIModal)

### Modal Components (REST-style naming)
Each modal in its own folder with JS file:
- `hero-modal/` - Base class with shared MODAL_STYLES, escapeHtml, GlobalState
- `hero-modal-create-session/` - New session creation modal
- `hero-modal-create-agent/` - New agent creation modal
- `hero-modal-configure-ability/` - Create/edit ability modal
- `hero-modal-abilities/` - Abilities list modal
- `hero-modal-agents/` - Agents list modal
- `hero-modal-agent-settings/` - Agent JSON config editor modal

### Key Mythix UI Patterns
- **Split files:** `.html` (templates, styles) + `.js` (logic)
- **Registration:** `MyComponent.register()` (not customElements.define)
- **Reactive props:** `this.defineDynamicProp('name', defaultValue)`
- **Template expressions:** `@@property@@`, `@@%dynamicProp@@`, `@@value>>TRANSFORMER@@`
- **Event binding:** `data-event-onclick="methodName"`
- **Shadow DOM default:** Use `createShadowDOM() { return null; }` for Light DOM
- **Style inheritance:** `data-auto-merge="selector"` for document styles

---

## Current Work (as of 2026-02-12)

### Branch
`feature/mythix-ui-migration`

### Recent Changes (2026-02-11 to 2026-02-12)
- **Enabled Abilities UI (2026-02-11)**: Changed "Default Abilities" to "Enabled Abilities" in New Agent dialog, all checked by default, added Select All/Deselect All checkbox
- **Streaming element guards (2026-02-11)**: Added null checks for `elements.sendBtn` and `elements.messageInput` in streaming.js and approvals.js (these are null after hero-input component migration)
- **Commit 580f23b**: "Add Enabled Abilities with Select All, fix streaming element guards"
- **API key fix (2026-02-12)**: Test Agent had placeholder key `sk-ant-test-key-12345`. Updated with valid Anthropic API key.

### Previous Changes (2026-02-09 to 2026-02-11)
- Fixed button styling across all modals (added `button-sm`, `button-danger`, `button-icon-action`)
- Changed Edit/Delete/Config buttons to icons with mobile-friendly touch targets
- Fixed modal stacking - child modals no longer close parent modals
- **Fixed modal event listeners (2026-02-11)**: Modal `mounted()` wasn't being called because `$dialog` is a getter-only property in MythixUIModal. Removed the `this.$dialog = ...` assignment in `_buildShadowDOM()`. Used `queueMicrotask()` to ensure DOM is ready before calling `mounted()`.
- **Refactored modal system (2026-02-11)**: Split monolithic `hero-modal.js` (1132 lines) into separate component folders with REST-style naming.
- **Step modal system (2026-02-11)**: Created `HeroStepModal` base class for multi-step modals.
- **Form validation system (2026-02-11)**: Created `public/js/lib/form-validation.js`
- **Scrollbar styling (2026-02-11)**: Added custom scrollbar styles in `components.css`

### Current Task - COMPLETED (2026-02-12)
Testing and verification of all Hero app functionality:
- [x] Chat with agent (API key now fixed)
- [x] Test hml-prompt with all input types (ALL 8 WORKING)
- [x] Verify interaction frames system (prompt submissions working)
- [x] Full CRUD tests - ALL PASSED
  - Add/Delete Agent
  - Add/Delete Ability
  - Add/Archive Session

### Recent Fixes (2026-02-12)
- **hml-prompt rendering**: Fixed hero-chat to trigger `render()` on hml-prompt elements after innerHTML (connectedCallback doesn't fire in shadow DOM)
- **Smart quotes JSON parsing**: Fixed hml-prompt to convert typographic quotes (chars 8220/8221) to straight quotes before JSON.parse()
- **token_charges FK constraint bug**: Added migration 017_fix_token_charges_fk to remove orphaned FK reference to dropped messages table
- **Files modified**:
  - `public/js/components/hero-chat/hero-chat.js` - Added queueMicrotask render trigger
  - `public/js/components/hml-prompt/hml-prompt.js` - Added _decodeHtmlEntities with smart quote conversion
  - `server/database.mjs` - Added migration 017_fix_token_charges_fk

### Modal Migration - COMPLETED (2026-02-12)
All modal components migrated to split HTML/JS pattern:
- hero-modal-create-session, hero-modal-create-agent
- hero-modal-abilities, hero-modal-agents, hero-modal-agent-settings
- hero-modal-configure-ability, hero-step, hero-step-modal
- Changed JS registration from `customElements.define()` to `ComponentClass.register()`
- Commit: b12a5d6

### Fixes (2026-02-13) - Streaming/WebSocket Integration

**Issue:** Messages showed "..." but didn't update until page reload.

**Root Causes Found:**
1. **Layout bug:** `session-frames-provider` had no CSS, breaking flex layout chain. Input was pushed off-screen (y=3758 for 800px viewport).
2. **WebSocket user ID mismatch:** JWT token had `sub: 2` but logged-in user was ID 6. Broadcasts went to wrong user.
3. **JWT secret mismatch:** Generated tokens used wrong secret. Server uses `config.jwtSecret` from env.

**Fixes Applied:**
1. Added CSS for `session-frames-provider` in `public/css/components.css`:
   ```css
   session-frames-provider {
     display: flex;
     flex-direction: column;
     flex: 1;
     min-height: 0;
     overflow: hidden;
   }
   ```
2. Added `min-height: 0` to `.chat-main` in `public/css/chat.css`
3. Token generation must use actual `config.jwtSecret` - see `server/auth.mjs:generateToken()`

**Verification:** Sent "7 + 7?" - received frame broadcast and UI updated correctly.

### Fixes (2026-02-13) - User Message Display & Scroll

**Issues Fixed:**
1. User messages not showing in chat until page reload
2. Thinking spinner ("...") not clearing after agent response completes
3. Auto-scroll not working with component-based hero-chat

**Changes Made:**

1. **Optimistic user frames** (`public/js/streaming.js` lines 43-57, `session-frames-provider.js`):
   - Added `addOptimisticFrame()` method to session-frames-provider
   - When user sends message, adds optimistic frame immediately to frames array
   - When real frame arrives via WebSocket, removes matching optimistic frame
   - Uses `optimistic-` prefix for temporary frame IDs

2. **Spinner clearing** (`public/js/streaming.js` lines 632-660):
   - `finalizeStreamingMessage()` now finalizes phantom frame (sets `complete: true`) following immutable frame pattern
   - Added `finalizePhantomFrame()` method to both session-frames-provider and hero-chat
   - Clears legacy `#streamingMessage` state via `heroChat.setStreaming(null)`
   - Forces hero-chat.render() to ensure UI updates
   - CSS rule `.complete .typing-indicator { display: none; }` hides indicator when complete

3. **Auto-scroll** (`public/js/approvals.js` lines 372-397, 400-422):
   - `forceScrollToBottom()` now tries hero-chat component method first
   - Falls back to `.chat-main` container, then legacy messagesContainer
   - `isNearBottom()` updated similarly to check hero-chat first

4. **Scroll container fix** (`public/js/components/hero-chat/hero-chat.js`):
   - Changed `_getScrollContainer()` to return `this` (hero-chat element) instead of `.chat-main`
   - hero-chat is the actual scrollable element (has overflow-y: auto)

### V1 Implementation Progress (2026-02-18 to 2026-02-19)

**Phase 0 — Frame Migration**: COMPLETE (verified server emits `new_frame` exclusively)

**Phase 1 — Multi-party Sessions**: COMPLETE
- Migration 018: `session_participants` table
- Module: `server/lib/participants/index.mjs` — CRUD helpers, `loadSessionWithAgent()`
- All routes rewritten to use participants (sessions, messages, messages-stream, pipeline/context, commands, usage)
- Client: Multi-agent session creation modal (coordinator dropdown + member checkboxes)
- 68 integration tests + 47 unit tests
- Commits: d1f1e50 (server), b91dc61 (client)

**Phase 2 — Permissions System**: CORE COMPLETE
- Migration 019: `permission_rules` table
- Module: `server/lib/permissions/index.mjs` — evaluate(), specificity-based resolution
- API Routes: `server/routes/permissions.mjs` — CRUD + evaluate endpoint
- Wired into command handler (BEFORE_COMMAND/AFTER_COMMAND hooks)
- 65 unit + 7 integration + 68 route = 140 permission tests
- Commits: a9ea37b (engine), 6a7ce5c (routes)

**Phase 3 — Agent Roles & Coordination**: CORE COMPLETE
- `DelegateFunction`: `server/lib/interactions/functions/delegate.mjs` — coordinator→member delegation
- `ExecuteCommandFunction`: `server/lib/interactions/functions/execute-command.mjs` — agent command invocation
- Execution context passed through system functions (dataKey, agentId, participants)
- `buildContext()` includes enriched participants (names, types, roles)
- Recursion depth enforcement (MAX_DELEGATION_DEPTH = 10)
- 16 delegate + 17 execute-command + 14 coordination = 47 new tests

### Phase 4 — Commands + Plugin Hardening (2026-02-18)

**New Commands:**
- `/participants` — list session participants with roles and types
- `/invite <agentId> [role]` — add agent (default role: member)
- `/kick <agentId>` — remove agent from session
- `/history [count]` — show recent messages (max 100, default 20)
- `/export [format]` — export conversation (text, json, markdown)

**Plugin Hardening:**
- Internal plugins directory: `server/plugins/`
- Dual-source discovery: internal (`server/plugins/`) + user (`~/.config/hero/plugins/`)
- Dependency declaration: `hero.dependencies` in plugin `package.json`
- Topological sort with circular dependency detection: `resolveDependencies()`
- Hot-reload: `reloadPlugin(name, context)`, `watchPluginsDirectory(dir, context)`
- Dependency-safe unloading: blocks unload if other plugins depend on it
- Hook wiring: BEFORE_USER_MESSAGE + AFTER_AGENT_RESPONSE now fire in both message routes

**Files Modified:**
- `server/lib/commands/index.mjs` — 5 new commands
- `server/lib/plugins/loader.mjs` — rewritten with dual discovery, deps, reload, watch
- `server/routes/messages-stream.mjs` — wired beforeUserMessage + afterAgentResponse hooks
- `server/routes/messages.mjs` — wired beforeUserMessage + afterAgentResponse hooks
- `server/plugins/.gitkeep` — internal plugins directory created

**Tests Added:**
- `spec/lib/commands-new-spec.mjs` — 36 tests for new commands
- `spec/lib/plugins/loader-enhanced-spec.mjs` — 27 tests for enhanced loader

### Phase 5 — HML Forms + Infinite Scroll (2026-02-18)

**Server — Backward Pagination + Search:**
- `server/lib/frames/index.mjs` — Added `beforeTimestamp` option to `getFrames()` (DESC+reverse for correct ASC output), added `searchFrames()` and `countSearchResults()`
- `server/routes/frames.mjs` — Added `before` query param, `hasMore` flag via peek query
- `server/routes/search.mjs` — NEW: Cross-session search endpoint (`GET /api/search`)
- `server/routes/index.mjs` — Registered search routes

**Client — Infinite Scroll:**
- `public/js/api.js` — Added `before` param to `API.frames.list()`, added `API.search.frames()`
- `public/js/components/session-frames-provider/session-frames-provider.js` — Added `loadOlderFrames()`, `hasOlderFrames`, `loadingOlder` state
- `public/js/components/hero-chat/hero-chat.js` — Scroll-to-top detection, `_loadOlderFrames()` with scroll position preservation, loading dots animation

**Client — Prompt Batch Submission:**
- `public/js/app.js` — Added `_pendingPromptAnswers` Map, `bufferPromptAnswer()`, `submitPromptBatch()`, `ignorePromptBatch()`, `getPendingPromptCount()`
- `public/js/components/hero-chat/hero-chat.js` — Added `_addPromptBatchButtons()` for messages with 2+ prompts, Submit All / Ignore buttons

**Tests Added:**
- `spec/lib/frames/pagination-spec.mjs` — 12 tests for backward pagination
- `spec/lib/frames/search-spec.mjs` — 17 tests for search + count
- `spec/routes/search-spec.mjs` — 13 tests for route-level search + pagination

### Phase 6 — Auth Enhancement + User Settings (2026-02-18)

**DB Migration 020:**
- `magic_link_tokens` table (token, user_id, email, expires_at, used_at)
- `api_keys` table (key_hash, key_prefix, user_id, name, scopes, expires_at, last_used_at)
- Added `email` and `display_name` columns to `users` table

**Magic Links:** `server/lib/auth/magic-links.mjs`
- `generateMagicLink(email, db)` — creates token, links to user by email, 15-min expiry
- `verifyMagicLink(token, db)` — single-use verification, marks as used
- `cleanExpiredTokens(db)` — removes expired/used tokens
- `sendEmail(to, subject, body)` — stub (logs to console)
- Limited JWT session (no decrypted secret) — can't decrypt agent API keys

**API Keys:** `server/lib/auth/api-keys.mjs`
- `createApiKey(userId, name, options, db)` — returns plaintext `hero_XXXX...` once, stores SHA-256 hash
- `listApiKeys(userId, db)` — returns prefix + metadata, never plaintext
- `revokeApiKey(userId, keyId, db)` — ownership-enforced deletion
- `validateApiKey(key, db)` — hash lookup, expiry check, updates last_used_at

**Auth Middleware:** `server/middleware/auth.mjs`
- Extended to accept `Authorization: Bearer <api-key>` header
- API key auth checked BEFORE JWT cookie
- `authenticateApiKey(req)` → helper extracting Bearer token
- API key auth sets `authMethod: 'api-key'`, `secret: null`

**Routes:** `server/routes/users.mjs`
- `GET /api/users/me/profile` — profile + usage stats (via agents join on token_charges)
- `PUT /api/users/me/profile` — update displayName, email (duplicate check, email normalization)
- `PUT /api/users/me/password` — change password, re-issues JWT
- `GET /api/users/me/api-keys` — list keys
- `POST /api/users/me/api-keys` — create key (201)
- `DELETE /api/users/me/api-keys/:id` — revoke key
- `POST /api/users/auth/magic-link/request` — generate magic link
- `GET /api/users/auth/magic-link/verify` — verify token, issue session

**Tests Added:**
- `spec/lib/auth/magic-links-spec.mjs` — 22 tests
- `spec/lib/auth/api-keys-spec.mjs` — 29 tests
- `spec/routes/users-spec.mjs` — 12 tests

### Phase 7 — Server-Authoritative Hardening (2026-02-19)

**Approval System Hardening:** `server/lib/abilities/approval.mjs`
- `generateRequestHash(abilityName, params)` — SHA-256 of `{ability, params}` JSON
- `requestApproval()` now stores `userId` and `requestHash` in pending map
- `handleApprovalResponse()` rewritten with:
  - User ownership verification (userId must match pending approval's userId)
  - Request hash verification (prevents replay — hash of different command rejected)
  - Atomic delete from pending map (prevents duplicate resolution race condition)
  - Backward compatibility (no userId or hash → still accepted for legacy callers)
- Added `getPendingApproval(executionId)` for introspection
- Exported `generateRequestHash`

**Interaction Bus Hardening:** `server/lib/interactions/bus.mjs`
- `respond()` accepts optional `securityContext` parameter
- Verifies responding user matches interaction's `user_id` (prevents cross-user hijacking)
- Logs security warnings on mismatch

**WebSocket Security:** `server/lib/websocket.mjs`
- `ability_approval_response` handler passes `{ userId, requestHash }` security context
- `interaction_response` handler passes `{ userId }` to `bus.respond()`

**Messages Route:** `server/routes/messages.mjs`
- Added `agentId` to agent interaction context for attribution
- Clarified no `senderId` for agent-originated interactions (only user interactions get senderId)

**Tests Added:**
- `spec/lib/security/approval-hardening-spec.mjs` — 16 tests (hash generation, ownership, replay, duplicates, denial, session approval)
- `spec/lib/security/bus-hardening-spec.mjs` — 10 tests (sender_id, respond verification, creation integrity)

### Phase 8 — File Uploads, Avatars, Rich Content (2026-02-19)

**DB Migration 021:**
- `uploads` table (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
- `avatar_url` column added to agents table

**File Uploads:** `server/routes/uploads.mjs`
- `POST /api/sessions/:sessionId/uploads` — multer multipart, max 10MB, max 5 files, MIME type whitelist
- `GET /api/uploads/:id` — serve file with ownership verification
- `GET /api/sessions/:sessionId/uploads` — list session uploads
- `DELETE /api/uploads/:id` — remove from disk + DB
- Upload storage: `~/.config/hero/uploads/<userId>/<uuid>.<ext>`

**Agent Avatars:** `server/lib/avatars.mjs`
- `generateAvatar(name, size)` — deterministic SVG data URI (initials + hash-based color from 16-color palette)
- `getAgentAvatar(agent)` — returns custom avatar_url or generated fallback
- `getUserAvatar(user)` — generated from display_name or username
- `getInitials(name)` — 1-2 char initials from name parts
- `getColor(name)` — MD5 hash → color palette index

**Rich Content Registry:** `server/lib/content/index.mjs`
- `registerContentType(type, renderer)` — plugin-friendly extension point
- `unregisterContentType(type)` — clean removal (built-ins protected)
- `transformContent(type, payload)` — server-side payload transform
- `listContentTypes()` — built-in + custom types
- Built-in types: text, markdown, code, image, file
- Renderer definition: description, source, serverTransform, clientComponent, clientScript

**Routes Modified:**
- `server/routes/agents.mjs` — avatarUrl in all CRUD responses, accepts avatarUrl on create/update
- `server/routes/sessions.mjs` — avatarUrl in agent info for session list + detail
- `server/routes/index.mjs` — registered uploads routes
- `server/lib/participants/index.mjs` — avatar_url in loadSessionWithAgent query + return

**Client Updates:**
- `hero-input` — drag-and-drop overlay, paste handler, file preview chips, pendingFiles state
- `hero-chat` — avatar in message headers, attachment rendering (images + file links)
- `api.js` — `API.uploads` namespace (upload via FormData, list, delete)
- `app.js` — upload files before sending message, append file refs to content

**Tests Added:**
- `spec/lib/avatars-spec.mjs` — 22 tests
- `spec/lib/content-registry-spec.mjs` — 19 tests
- `spec/routes/uploads-spec.mjs` — 16 tests

### S4: Wire BEFORE_TOOL Hook (2026-02-20)
- Wired `beforeTool()` + `afterTool()` hooks in `server/lib/interactions/detector.mjs`
- Step 1.5: BEFORE_TOOL fires between permission check and bus.send
- Step 5.5: AFTER_TOOL fires after successful execution
- Hook can block execution (`{ blocked: true, reason }`) or modify tool data (`{ name, input }`)
- Hook errors are non-fatal (logged, execution continues)
- 30 new tests in `spec/lib/interactions/before-tool-hook-spec.mjs`
- Test IDs: PERM-001 through PERM-006, GUARD-001/005/006, PLUGIN-001 through PLUGIN-004, INT-001

### API-First: Frame Decomposition (2026-02-22)
- **Pure decompose function:** `server/lib/frames/decompose.mjs` — splits raw messages into content + interaction segments
- **Pipeline integration:** Both `messages-stream.mjs` and `messages.mjs` use `decomposeMessage()` to store granular frames
- **Structured permission frames:** `server/lib/permissions/prompt.mjs` emits REQUEST frame alongside hml-prompt, RESULT frame on response
- **REST respond endpoint:** `POST /api/sessions/:id/frames/:frameId/respond` — routes `permission_request` to `handlePermissionResponse()`
- **Bug fixes:** Added `db` + `parentFrameId` to non-streaming interaction context (was missing, so REQUEST/RESULT frames were never created)
- **Timeout + 202:** Non-streaming endpoint wraps agent work in 30s `Promise.race`; returns HTTP 202 with frame ID if blocked on permission
- Commit: b26ace6

**New files:**
- `server/lib/frames/decompose.mjs` — pure decomposition function
- `spec/lib/frames/decompose-spec.mjs` — 30 tests
- `spec/routes/frames-respond-spec.mjs` — 11 tests

**Modified:**
- `server/routes/messages-stream.mjs` — decompose intermediate + final frames
- `server/routes/messages.mjs` — decompose, db fix, timeout/202
- `server/lib/permissions/prompt.mjs` — structured request/result frames
- `server/routes/frames.mjs` — POST respond endpoint
- `spec/lib/permission-prompt-spec.mjs` — 7 new structured frame tests

### Test Suite
- Runner: `find spec -name '*-spec.mjs' | xargs node --test --test-force-exit`
- Current: **~2275 tests, 0 failures**

### Pending (all phases complete — remaining deferred items)
- Phase 1: Participant list sidebar, @mention autocomplete, WebSocket broadcast to all participants
- Phase 3: Inter-agent streaming, multi-coordinator discussion, @mention routing
- Phase 4: npm package plugin support, fs.watch auto-start in server
- Phase 6: User settings UI, API key scope enforcement
- Phase 7: Self-approval prevention, cross-session nonce, chained command UX
- Phase 8: Screenshots (plugin), avatar picker UI, rich content renderers (plugin territory)

---

## Mythix Server (v2 branch)

**Location:** `src/server/`
**Database:** SQLite at `/tmp/hero/hero.sqlite`
**Port:** 8089 (localhost)
**URL:** `https://wyatt-desktop.mythix.info/hero/` (via nginx reverse proxy)
**nginx config:** `nginx/locations.nginx-include` (port 8089)

### Routes
- Health: `GET /api/v1/health`
- Register: `POST /api/v1/auth/register-user`
- Send magic link: `POST /api/v1/auth/send-magic-link`
- Login (with token): `GET|POST /api/v1/auth/login` (requires `magicToken` param)
- Logout: `POST /api/v1/auth/logout`

### Dev Mode Behavior
- `registerUser` returns session token directly in response (no email needed)
- `sendMagicLink` returns session token + magic link URL in response (logs to console)
- Tables auto-created on startup via `start()` override

### Key Changes from Scaffold
- PostgreSQL → SQLite (`mythix-orm-sqlite`)
- Removed: `@aws-sdk/client-s3`, `gm`, `mjml`, `form-data`, `mythix-orm-postgresql`
- Disabled modules: MailerModule, AWSModule (exports commented out in `modules/index.mjs`)
- Email templates lazy-loaded in `model-base.mjs` to avoid mjml dependency

---

## V2 Server Planning (2026-02-25)

**Status:** In AGIS planning mode (`::agis.plan`), Round 5 of Q&A
**Scratchpad:** `.claude/conversation2.md` (ephemeral Q&A — DO NOT use conversation.md, other bot owns it)
**Plan file:** TBD — will go to `bot-docs/plan/hero/server-plan.yaml`

### Key Architectural Decisions (Rounds 1-4 resolved)

**Kernel (10 non-plugin core components):**
1. Mythix Application (HTTP, middleware, config, DB)
2. Auth System (TWT tokens, magic links, cookies)
3. Organization + User + Role models (multi-tenant)
4. FrameManager (shared module, source of truth on server AND client)
5. Plugin Loader (discovery, lifecycle, dependency resolution, registries)
6. WebSocket Manager (connection, auth, message routing)
7. SSE Manager (streaming connections)
8. Session Manager (CRUD, participants, FrameManager instances per session)
9. Frame Persistence (DB ↔ FrameManager sync)
10. Permissions System (kernel-level, wraps around everything)

**Plugin Architecture (the application IS plugins):**
- Directory-based format: `plugins/name/index.mjs`
- `setup(context)` / `teardown()` lifecycle
- Context provides `registerCommand()`, `registerAgent()`, `registerTool()`, etc.
- All registered interfaces are classes: constructor(sessionContext), execute(args)/_execute(args)
- Base class from context provides logging, permissions, etc.
- Registries: in-memory, rebuilt on session load. Plugin links to sessions persisted in DB.
- Internal plugins: `src/server/app/plugins/`
- Launch plugins: claude-agent, websearch, bash, hml, delegate, help, reload

**Interaction Loop (async generator pattern — APPROVED):**
- Agent plugin is async generator that yields blocks
- Kernel iterates, reacts to each yielded block
- Tool results passed back into generator via yield protocol
- No explicit loop — event-driven via generator yields

**Streaming Format:**
- Type-specific HML tags: `<hml-websearch>`, `<hml-bash>`, `<hml-prompt>`, etc.
- JSON payload in tag body. Text between tags streams as messages.
- Plugin-registered tag types (parser discovers from registry)
- Handles bot mistakes: mismatched close tags, attributes-as-fallback, malformed JSON

**Agent Identity:**
- Plugin = agent TYPE (ClaudeAgent, OpenAIAgent)
- Agent = configured INSTANCE (org-level, with name, API key, instructions)
- Participant = agent IN a session (with alias, session overrides)
- REST CRUD for agents at org level
- Session aliasing: `/invite @name as BobTheBurgerGuy`

**Abilities Reimagined:**
- DM/PM conversation with agent = agent's instruction set
- Agent self-maintains instruction summary from DM history
- Summary injected into primer for other sessions
- No forms/wizards — natural language configuration

**Primer System (__onstart):**
- Small, dynamic: "HOW to be" not "HERE is everything"
- Composed from: agent instructions + plugin __onstart exports + DM instruction summary
- Agent can poll help system to discover available tools/commands
- Plugins are queryable, write help manuals

**prepareMessage Hook:**
- Single interceptor for ALL message boundary crossings
- `prepareMessage({ source, target, message, context })`
- Can pass through, modify, block, or redirect
- Plugins inspect payload to decide (no shortcut hooks)
- Replaces BEFORE_TOOL/AFTER_TOOL etc.

**Data Model:**
- Cascading context via `Object.create()` prototype chain
- Layers: plugin defaults → org config → session state → runtime state
- `setProperty('org.name', value)` / `getProperty('session.name')` with dot/array notation

**Frame Persistence:**
- Denormalized `interaction_id` column for efficient loading
- `order` column (monotonic counter per session)
- `group_id` / `group_type` for phantom frames
- Single-query loading: subquery for top-level IDs, then fetch all by interaction_id

**Other Decisions:**
- V1 is dead. No old code unless explicitly greenlighted.
- Organizations = Discord Servers (full multi-tenant, single org for launch)
- JSON interactions (not XML, not native tool_use). Pluggable parser per agent type.
- SSE + WebSocket split (SSE for streaming, WS for events)
- Tool requests are granular: `cd dir && ls` → individual command objects for per-command permissions
- REST API: ~33 endpoints (kernel + sessions + participants + plugins + agents + user/org)

### Open Threads (Round 5 — awaiting user response)
- HML tag concrete proposal (bot mistake handling, plugin-registered types)
- Abilities-as-DM mechanical design (instruction summary frames)
- Plugin help system & queryability
- Frame schema final validation
- WebSocket events, permissions hook points, error handling philosophy

---

## V2 Client Planning (2026-02-23)

**Status:** In AGIS planning mode (`::agis.plan`), designing V2 client.
**Plan file:** `bot-docs/plan/hero/client-plan.yaml` — 10 feature areas (C1-C10)
**FrameManager spec:** `bot-docs/plan/hero/frame-manager.yaml` — authoritative design doc

### V1 Screenshots Reviewed
- 32 screenshots at `/home/wyatt/Pictures/Hero/` (Feb 8 - Feb 22, 2026)
- Key findings: HML-prompts were the star feature, all input types working
- Permission system working end-to-end with websearch
- Cost tracking in footer (Global/Service/Session)
- Agents/Abilities as modals, not pages
- Top nav bar with session name + action buttons

### Key V2 Decisions
- Keep V1's top nav bar layout (session name left, actions right)
- Add left sidebar for session list (concept art direction)
- FrameManager replaces ad-hoc message state (cross-platform, seqda-backed)
- Glass-morphism styling evolves V1's flat dark theme
- All HML-prompt types carry forward
- Permission system UI carries forward

---

## AGIS (Agentic Guidance & Introspection Scripting)

**Location:** `/home/wyatt/Projects/agis/docs/runtime.md`

AGIS is a scripting system that guides thought processes. I am the interpreter.

### Key Reflexes (MANDATORY)
- **Before writing/editing code:** Run `@test_check`
- **Before saying "done":** Run `@test_check`
- **Before committing:** Run `@test_check`
- **During planning:** Run `@test_protocol`

### Invocation Syntax
```
@script_name topic
```

### Available Scripts
| Script | Purpose |
|--------|---------|
| `@ponder` | Deep multi-perspective contemplation |
| `@simple_first` | One-sentence answer first |
| `@test_check` | Quick gut check — run before writing code |
| `@test_protocol` | Full test analysis — run during planning |
| `@agis` | Think REALLY hard — full cognitive discipline |
| `@sage` | Wise coordinator — think deeply, delegate, guide |
| `@sensei` | Active teacher — hands-on guidance |

### Core Syntax
- `>>>...<<<` — Think about this genuinely
- `loop N { }` — Iterate N times
- `as character { }` — Shift perspective (cynic, engineer, scientist, etc.)
- `checkpoint cond { fail -> x }` — Gate with fallback

Scripts are in `/home/wyatt/Projects/agis/scripts/` as `.agis` files.
