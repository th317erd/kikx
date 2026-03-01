# Kikx Project Todo

## Completed
[x] Markdown → HTML migration - Agent outputs HTML, server-side sanitization (105 tests)
[x] Startup abilities (`_onstart_*` pattern) - implemented and working
[x] Abilities system consolidation (processes + functions = abilities)
[x] Hidden messages feature - startup messages hidden from UI but sent to AI
[x] Streaming HML parser with progressive element detection
[x] Fixed streaming freeze issue (message_complete always fires)
[x] Session status system - replaced `archived` boolean with flexible `status` column
[x] Parent session hierarchy - `parent_session_id` for agent sub-sessions
[x] Session UI grouping - child sessions indented under parents
[x] Session status styling - archived (red hue), agent (blue hue)
[x] Renamed "Processes" to "Abilities" throughout the UI
[x] "Ask Always" permission system for commands
[x] Command abilities: /ability, /session, /agent (with user approval)
[x] Have every dynamic "function" or "command" wrapped in an async permission layer
[x] "Default Processes" in Agent config should have a "Select All" checkbox
[x] Refresh processes list when Agent config dialog opens
[x] `/skill` command for creating named process abilities
[x] Show agent name (not "Assistant") in chat bubbles
[x] Allow agent to suggest commands for user to copy/paste (explicit control)

## In Progress

### Interaction Frames Implementation

**Phase 1: Database Foundation** ✅ COMPLETE
- [x] Create `frames` table with new schema (migration 014)
- [x] Drop old `messages` table (migration 015)
- [x] Write frame CRUD functions (server/lib/frames/index.mjs)
- [x] Tests for frame operations (36 tests passing)

**Phase 2: Frame Core Library** ✅ COMPLETE
- [x] `createFrame()`, `getFrames()`, `getFramesBySession()` - implemented
- [x] `compileFrames()` — replay/compilation logic - implemented
- [x] Target ID parsing utilities - implemented (prefix:id format)
- [x] Tests for compilation - 36 tests covering all scenarios

**Phase 3: Server-Side Frame Loop** ✅ COMPLETE
- [x] Refactor `messages-stream.mjs` to create frames
- [x] Frame-based context builder for agent calls - `server/lib/frames/context.mjs`
  - `loadFramesForContext()` - Load frames for AI context
  - `getFramesForDisplay()` - Get frames with compiled state
  - `buildConversationForCompaction()` - Format for summarization
  - `countMessagesSinceCompact()` - Count messages for compaction trigger
- [x] API endpoint: `GET /api/sessions/:id/frames` - implemented
  - GET /sessions/:id/frames - List frames with filters
  - GET /sessions/:id/frames/stats - Frame statistics
  - GET /sessions/:id/frames/:frameId - Single frame
- [x] Frame broadcast helpers - `server/lib/frames/broadcast.mjs`
  - `createAndBroadcastFrame()` - Core function
  - `createUserMessageFrame()`, `createAgentMessageFrame()`, `createSystemMessageFrame()`
  - `createRequestFrame()`, `createResultFrame()`, `createCompactFrame()`, `createUpdateFrame()`
- [x] Updated `compaction.mjs` to use frames
- [x] Updated `sessions.mjs` to use frames for message counts and previews
- [x] Updated `messages.mjs` (non-streaming) to use frames
- [x] Updated `conditional.mjs` to use frames for prompt detection
- [x] Updated `prompt-update.mjs` to update frame payloads
- [x] Tests for frame broadcast helpers (12 tests)

**Phase 4: WebSocket Protocol** (Pending - client update deferred)
- [ ] Change WS to emit frames (including phantoms)
- [ ] Fetch frames via API on load, WS for real-time
- [ ] Tests for frame streaming

**Phase 5: Interactions & Commands** (Pending - client update deferred)
- [ ] Refactor websearch to emit request/result frames
- [ ] Other commands follow same pattern
- [ ] Parent/child frame relationships
- [ ] Tests for interaction chains

**Phase 6: Compaction** ✅ COMPLETE
- [x] Trigger compaction logic (using `countMessagesSinceCompact`)
- [x] Agent generates compact frame (using `createCompactFrame`)
- [x] Load-from-compact logic (using `loadFramesForContext`)
- [x] Compaction module fully migrated to frames

**Notes:**
- Client updates deferred (big plans coming)
- Keep code plugin-ready (modular, clean interfaces)
- Code in `server/lib/frames/`

---

## Architecture: Interaction Frames

### Problem Statement
The application has grown complex. The hml-prompt implementation struggles because there are too many moving parts between frontend rendering, server-side state, and persistence that don't compose well. We need to tighten up the agent layer with better separation of concerns.

### Core Idea: Event Sourcing for Conversations
All conversation activity becomes immutable "interaction frames" — like git commits or database binlog entries. The current state is *derived* by replaying frames from the beginning (or from a checkpoint).

**Principles:**
1. Server-side is 100% self-contained, can run headless
2. Frontend is just a frame renderer/subscriber
3. Single source of truth — replay frames = exact state
4. The "agent loop" is tight and isolated

**Analogy:** Git for conversations. Each frame is a commit. State is built by replaying commits.

---

## Pending
[ ] Retry on specific errors - auto-retry agent API calls on transient failures (ETIMEDOUT, connection reset, 529, etc.) with exponential backoff
[ ] Debug "Show hidden messages" checkbox - debug logging added, needs user testing to verify behavior
[ ] Add token scalar setting for adjusting cost calculation ratio (mentioned in update_usage requirements)

## Recently Completed (2026-02-08)
[x] Mythix-UI Component Refactoring - Phase 2 complete
    - Created `kikx-main-controls.js` - consolidates header action buttons (horizontal/vertical layouts)
    - Created `KikxModalAbilities` - abilities list with System/User tabs
    - Created `KikxModalAgents` - agents list with edit/delete
    - Created `KikxModalAgentConfig` - JSON configuration editor for agents
    - Updated `kikx-header.js` to use `<kikx-main-controls>` component
    - Removed ~235 lines of old modal HTML from index.html
    - Cleaned up state.js (~62 lines of modal element references removed)
    - Cleaned up app.js (~350 lines of modal functions removed)
    - Fixed event naming: `show-modal` for consistency across components

## Recently Completed (2026-02-07)
[x] Nginx config: Added /mythix-ui/ location block for mythix-ecosystem libraries
[x] Client-side cleanup: Moved cost utilities (formatTokenCount, calculateCost, formatCost) to utils.js
[x] Client-side cleanup: Converted debug TRACE statements to use debug() function in app.js and api.js
[x] Client-side cleanup: Added showSystemMessage() helper, reduced app.js by 116 lines (27 patterns consolidated)
[x] `<hml-prompt>` Web Component - full-featured inline user prompts
    - All input types: text, number, color, checkbox, checkboxes, radio, select, range
    - JSON options via `<data>` element for select/radio/checkboxes
    - OK button for non-keyboard inputs (color, select, checkbox, range)
    - Inline display (newlines collapsed, `<p>` tags unwrapped)
    - `<data>` element hidden via CSS
    - Select dropdown improved styling (white background, dark text)
    - Persistence working via interaction system

## Recently Completed (2026-02-06)
[x] Token charges system - records every API call with agent_id, session_id, message_id, cost
[x] 3-line spend display: Global Spend (all agents), Service Spend (same API key), Session Spend
[x] Private messages column - for user-only messages not sent to agent
[x] Compacting memory - improved prompt to capture comprehensive context AND generate TODO lists
[x] Add "Chevron Down" button to jump to bottom of chat - floats at bottom-right, auto-hides when near bottom
[x] Add `/update_usage <cost>` command - stores corrections in database, adjusts tracking to match actual spend
[x] Unit tests for token charges system - 30 tests covering cost calculation, spend queries, corrections
[x] Unified test runner - converted all spec files from Jest to Node.js built-in test runner (177 tests total)
[x] Scroll behavior improvements - auto-follow only when near bottom, force scroll on user message
[x] Scroll-to-bottom button repositioned - centered horizontally, chevron centered in circle
[x] Fixed SQL error in usage routes - changed `api_key` to `encrypted_api_key`
[x] User message interaction processing - server now executes `<interaction>` tags in user messages

## Architecture Notes
- **Abilities** = verbal "guides" for the agent, applied when the agent feels they should
- **Sources**: builtin, system, user, plugin
- **Hidden messages**: `hidden=1` in messages table, filtered in frontend but sent to AI
- **Startup abilities**: `_onstart_*` pattern, `__onstart_` runs first (double underscore = higher priority)

## Work Process Notes
- Use Browser automation MCP (Puppeteer) for visual debugging, and testing all HTML changes (that can be verified via unit tests)
- Use Test Driven Development ALWAYS... decide what you want to build, write important test coverage for whatever it is that you are building, and then write the system to pass the tests. Use Browser automation MCP (Puppeteer) when you are debugging things (real time), use JSDOM, or whatever framework is needed to properly test your work.
- Always keep in mind Wyatt's skills and quirks (/home/wyatt/.claude-config/quirks.md), and apply them when writing code or planning tasks.
