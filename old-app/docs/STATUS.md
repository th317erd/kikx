# Current Status

Last updated: 2026-02-15

## In Progress: Mythix-UI Client Migration

**Branch:** `feature/mythix-ui-migration`

### Overview
Migrating the Kikx frontend from vanilla JavaScript to the Mythix-UI Web Component framework for:
- Reactive state management (DynamicProperty)
- Component-based architecture
- Better separation of concerns
- Integration with Interaction Frames system

### Decisions

| Decision | Choice |
|----------|--------|
| Shadow DOM | Light DOM primary, component-scoped styles where sensible |
| Templates | Inline JS (template literals or Element API) |
| State | 3-tier: Global (sessions/agents), Session (frames), Component (local UI) |
| Testing | JSDOM for unit tests, Puppeteer for integration |
| CSS | Global stylesheets remain, component styles where sensible |
| WebSocket | Separate file, app-level instance, per-session + global channels |

### Component Structure

```
public/js/components/
├── kikx-base.js           # ✅ GlobalState + KikxComponent base class
├── kikx-app.js            # ✅ Root shell, auth, routing
├── kikx-sidebar.js        # ✅ Session list, search, archive
├── kikx-chat.js           # ✅ Message area, streaming, scroll button
├── kikx-input.js          # ✅ Message input with send button
├── kikx-websocket.js      # ✅ Standalone WebSocket handler
├── kikx-header.js         # ✅ Top bar, cost display, agent dropdown
└── kikx-modal.js          # ✅ Session, agent, ability modals

spec/components/
├── kikx-base-spec.mjs     # ✅ 15 tests
├── kikx-app-spec.mjs      # ✅ 28 tests
├── kikx-sidebar-spec.mjs  # ✅ 31 tests
├── kikx-chat-spec.mjs     # ✅ 40 tests
├── kikx-input-spec.mjs    # ✅ 34 tests
├── kikx-websocket-spec.mjs # ✅ 32 tests
├── kikx-header-spec.mjs   # ✅ 32 tests
└── kikx-modal-spec.mjs    # ✅ 35 tests
```

### State Tiers

```
GlobalState (Utils.dynamicPropID)
├── heroUser           # Current authenticated user
├── heroSessions       # All sessions list
├── heroAgents         # All agents list
├── heroAbilities      # System + user abilities
└── heroCurrentSession # Currently selected session

SessionState (DynamicProperty on kikx-chat)
├── frames             # Compiled frames from server
├── streamingFrame     # Current streaming message
└── isTyping           # Typing indicator state

ComponentState (local DynamicProperty)
├── Modal open/close states
├── Form field values
└── Scroll position
```

### Build Order (Top-Down)
1. ✅ `kikx-base.js` - Infrastructure (GlobalState, KikxComponent base class)
2. ✅ `kikx-app.js` - Root shell with auth, routing
3. ✅ `kikx-sidebar.js` - Session list, search, archive
4. ✅ `kikx-header.js` - Top bar, cost display
5. ✅ `kikx-chat.js` - Chat view, message rendering, streaming
6. ✅ `kikx-input.js` - Message input, commands, queue
7. ✅ `kikx-websocket.js` - WebSocket handler
8. ✅ Modals (session, agent, ability)

### Completed Components

**kikx-base.js** - Core infrastructure
- `GlobalState` object with reactive DynamicProperty values
- `KikxComponent` base class extending MythixUIComponent
- Convenience methods: `setGlobal()`, `subscribeGlobal()`, `debug()`
- Light DOM by default (no Shadow DOM)

**kikx-app.js** - Root application shell
- Route parsing (`parseRoute()`) with base path support
- View switching (login, sessions, chat)
- Authentication state management
- WebSocket connection lifecycle
- Initial data loading (sessions, agents, abilities)

**kikx-sidebar.js** - Session list
- Session filtering by search query
- Visibility toggle (show/hide archived and agent sessions)
- Empty states (no agents, no sessions, no results)
- Session hierarchy with depth-based indentation
- Archive/restore toggle
- Global cost display

**kikx-chat.js** - Chat messages area
- Message list rendering with role classes
- Hidden message filtering and type badges
- Tool use and tool result rendering
- Streaming message support with typing indicator
- Scroll-to-bottom button
- Debounced rendering to prevent loops
- Token estimation display

**kikx-input.js** - Message input
- Auto-resizing textarea
- Command detection (/ prefix)
- Message queue for busy state
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)
- Loading state management

### Tests
All components have comprehensive test suites in `spec/components/`:
- `kikx-base-spec.mjs` - 15 tests
- `kikx-app-spec.mjs` - 28 tests
- `kikx-sidebar-spec.mjs` - 31 tests
- `kikx-chat-spec.mjs` - 40 tests
- `kikx-input-spec.mjs` - 34 tests
- `kikx-websocket-spec.mjs` - 32 tests
- `kikx-header-spec.mjs` - 32 tests
- `kikx-modal-spec.mjs` - 35 tests

Total: **930 tests passing**

### Notes
- HTML sanitization: Server-side (jsdom) + client-side defense-in-depth (see `server/lib/html-sanitizer.mjs`)
- Keep existing `api.js` functions, update as needed
- Per-session WS connections + global updates for sessions/agents/abilities

---

## Recent Changes

### Markdown → HTML Migration (2026-02-16)

Replaced markdown rendering with direct HTML output from agent, sanitized server-side.

**Changes:**
- Agent now outputs HTML directly (h1-h6, p, ul/ol, strong, em, code, etc.)
- Server-side HTML sanitization using jsdom (`server/lib/html-sanitizer.mjs`)
- Client-side defense-in-depth sanitization in `markup.js`
- Removed markdown-it dependency from frontend
- Renamed `markdown.css` → `content.css`
- Agent instructions (`__onstart_.md`) rewritten from 501 to 163 lines

**Security:**
- Whitelist-based tag filtering (see `.claude/TODO.md` for full list)
- Dangerous tags removed completely (script, iframe, form, etc.)
- Event handlers stripped (onclick, onerror, etc.)
- Dangerous URLs neutralized (javascript:, vbscript:, data:text/html)
- 105 sanitizer tests covering XSS vectors, encoding attacks, stress tests

**Files:**
- `server/lib/html-sanitizer.mjs` - Server-side sanitizer (jsdom)
- `public/js/markup.js` - Client-side sanitizer + HML processing
- `public/css/content.css` - Message content styling (renamed from markdown.css)
- `spec/lib/html-sanitizer-spec.mjs` - 105 security tests

### HML Prompt Known Issues (2026-02-15)

Three issues have been identified with the HML Prompt interaction flow:

**Issue 1: AI Sends Duplicate `update_prompt` Interactions**
- When user submits a prompt answer, the system sends an `<interaction>` to update the prompt
- The AI agent also sees this and sends its OWN `update_prompt` interaction
- The AI's duplicate fails with "Prompt not found in message" (already updated)
- The error gets displayed as JSON in the chat

**Issue 2: System Interaction Results Displayed in Chat**
- The `update_prompt` interaction result (including errors) is displayed as a "streaming element"
- System interactions like `update_prompt` should be silent/hidden from chat display

**Issue 3: Prompt May Not Turn Green Immediately**
- When `processMessageStream()` calls `renderMessages()`, all messages are re-rendered from `state.messages`
- If `updatePromptInState()` fails to find/update the message, the DOM element gets replaced with original HTML without `answered` attribute
- After page reload, prompts show correctly because database has correct state

**Related Files:**
- `public/js/components/hml-prompt/hml-prompt.js` - Line 674 sets answered attribute
- `public/js/app.js` - `updatePromptInState()` (lines 1063-1105)
- `public/js/streaming.js` - `renderStreamingElement()` displays interaction results
- `server/lib/interactions/functions/prompt-update.mjs` - Server-side prompt update

### HML Prompt Web Component (Complete)
Full-featured inline prompt component with multiple input types.

**Supported Types:**
- `text` - Free-form text input (default)
- `number` - Numeric input with min/max/step
- `color` - Color picker with OK button
- `checkbox` - Single yes/no checkbox
- `checkboxes` - Multi-select checkbox group
- `radio` - Radio button group
- `select` - Dropdown menu with OK button
- `range` - Slider with value display

**Features:**
- Shadow DOM encapsulation for styling isolation
- Inline display (newlines around tags collapsed to spaces)
- OK button for non-keyboard inputs (color, select, checkbox, range)
- JSON options via `<data>` element (hidden via CSS)
- `<p>` tag unwrapping to maintain inline flow
- Answered state with green styling
- Persists answers to database via interaction system

**Usage with options:**
```html
<hml-prompt id="color" type="select">
  Pick a color
  <data>[{"value":"red","label":"Red"},{"value":"blue","label":"Blue"}]</data>
</hml-prompt>
```

**Files:**
- `public/js/components/hml-prompt.js` - Web Component implementation
- `public/js/markup.js` - Tag conversion, newline collapsing, `<p>` unwrapping
- `public/css/content.css` - Inline display, `<data>` hiding
- `server/lib/interactions/functions/prompt-update.mjs` - Server-side update handler
- `server/lib/processes/__onstart_.md` - Agent instructions for all types

**Interaction flow:**
1. AI outputs `<hml-prompt>` in response (with optional `<data>` for options)
2. User interacts with input and clicks OK (or presses Enter for text/number)
3. Frontend sends user message with `<interaction>` tag containing `update_prompt` payload
4. Server executes interaction, updates original message in database
5. On reload, prompt renders in answered state

### Scroll Behavior Improvements (Complete)
Changed scroll behavior to prevent jarring jumps while reading older messages.

**Changes:**
- `scrollToBottom()` now only scrolls if user is already near bottom (auto-follow)
- `forceScrollToBottom()` added for explicit actions (button click, user sends message)
- Scroll-to-bottom button repositioned to center horizontally
- Chevron icon centered within button

**Files changed:**
- `public/js/app.js` - Split scroll functions, updated event handlers
- `public/css/chat.css` - Button positioning with `left: 50%; transform: translateX(-50%)`

### User Message Interaction Processing (Complete)
Server now processes `<interaction>` tags in user messages, not just AI responses.

**Use case:** When user answers an `<hml-prompt>`, the frontend sends an interaction to update the original message.

**Files changed:**
- `server/routes/messages-stream.mjs` - Added interaction detection/execution after storing user message

### Token Charges SQL Fix (Complete)
Fixed SQL error "no such column: a.api_key" in usage routes.

**Problem:** The `agents` table has `encrypted_api_key`, not `api_key`.

**Files changed:**
- `server/routes/usage.mjs` - Changed `a.api_key` to `a.encrypted_api_key`

### Test Suite Unification (Complete)
Unified all test files to use Node.js built-in test runner (`node:test`). Previously some files used Jest-style syntax without proper imports.

**Files converted:**
- `spec/lib/encryption-spec.mjs` - 17 tests for password/key encryption
- `spec/lib/config-path-spec.mjs` - 10 tests for config directory paths
- `spec/lib/agents/base-agent-spec.mjs` - 14 tests for base agent class
- `spec/lib/plugins/hooks-spec.mjs` - 15 tests for plugin hooks
- `spec/lib/plugins/loader-spec.mjs` - 11 tests for plugin loading

**New test file:**
- `spec/routes/usage-spec.mjs` - 30 tests for token charges system

**Total test count:** 177 tests across 8 spec files

**Run tests:** `npm test`

### Token Charges System (Complete)
Implemented comprehensive token/cost tracking per API call with Global, Service, and Session spend views.

**New Database Tables:**
- `token_charges` - Records every API call with agent_id, session_id, message_id, tokens, cost
- Added `private` column to messages for user-only messages (not sent to agent)

**Usage Display (3 lines in header):**
- **Global Spend:** Total cost across ALL agents for the user
- **Service Spend:** Total cost for all agents sharing the same API key
- **Session Spend:** Cost for the current session only

**API Endpoints:**
- `GET /api/usage` - Returns global spend
- `GET /api/usage/session/:sessionId` - Returns global, service, and session spend
- `POST /api/usage/charge` - Record a token charge
- `POST /api/usage/correction` - Add a cost correction
- `GET /api/usage/history` - Get charge history

**Query Logic:**
1. Get current session's agent
2. Get that agent's encrypted api_key
3. Find ALL agents with matching api_key (same service account)
4. Sum charges for all matching agents = Service Spend
5. Sum charges for just this session = Session Spend

**Files changed:**
- `server/database.mjs` - Migrations 012 (token_charges), 013 (messages.private)
- `server/routes/usage.mjs` - Complete rewrite with new endpoints
- `server/routes/messages-stream.mjs` - Record charges on each API call
- `public/index.html` - 3-line spend display in headers
- `public/js/state.js` - globalSpend, serviceSpend, sessionSpend state
- `public/js/api.js` - fetchSessionUsage, recordCharge functions
- `public/js/app.js` - loadSessionUsage, updated cost display logic
- `public/css/layout.css` - Stacked usage display styling

### TODO List Updates (Complete)
Implemented several improvements from the project TODO list.

**Scroll-to-Bottom Button:**
- Added a chevron button that appears when user scrolls up in chat
- Button floats in the bottom-right corner of the messages container
- Click scrolls smoothly to the latest message
- Auto-hides when user is near the bottom

**Files changed:**
- `public/index.html` - Added scroll-to-bottom button element
- `public/js/state.js` - Added button and chatMain element references
- `public/js/app.js` - Added `isNearBottom()`, `updateScrollToBottomButton()`, scroll event handler
- `public/css/chat.css` - Added `.scroll-to-bottom-btn` styling

**Header Usage Display:**
- Moved cost/token display from floating position to header bar
- Shows two line items: Global usage and Session usage
- Session usage only visible in chat view
- Global usage fetched on authentication and updated in real-time

**Files changed:**
- `public/index.html` - Added usage display elements to both headers
- `public/js/state.js` - Added `globalCost` state object
- `public/js/api.js` - Added `fetchUsage()` function
- `public/js/app.js` - Rewrote `updateCostDisplay()`, added `loadGlobalUsage()`
- `public/js/routing.js` - Call `loadGlobalUsage()` on authentication
- `public/css/layout.css` - Added `.header-usage` styling
- `public/css/chat.css` - Removed old floating cost display

**Usage Correction Command:**
- Added `/update_usage <cost>` command for correcting token tracking
- User provides actual API cost, system calculates and stores correction
- Corrections are persisted in new `usage_corrections` database table
- Usage API now includes corrections in totals

**Files changed:**
- `server/database.mjs` - Added migration 011 for `usage_corrections` table
- `server/routes/usage.mjs` - Added correction endpoints, updated GET to include corrections
- `server/routes/index.mjs` - Registered usage routes
- `public/js/api.js` - Added `createUsageCorrection()` function
- `public/js/app.js` - Added `handleUpdateUsageCommand()`, registered command

**Improved Memory Compaction:**
- Enhanced compaction prompt to capture comprehensive context
- Now generates TODO lists during compaction
- Improved snapshot loading with clearer context markers

**Files changed:**
- `server/lib/compaction.mjs` - Updated `buildCompactionPrompt()` and snapshot loading

**Debug Logging for Hidden Messages:**
- Added console logging to help debug "Show hidden messages" checkbox
- Logs message counts when loading sessions and toggling checkbox

### Web Search Banner Timing Fix (Complete)
Fixed critical issue where the "Web Search: Pending" banner appeared simultaneously with search results instead of immediately when the search started.

**Root causes identified and fixed:**
1. **SSE event parsing bug** - `eventType` and `eventData` were reset on every chunk, breaking events that span multiple chunks. Moved variables outside the parsing loop.
2. **Interaction events timing** - Now send `interaction_started` at `<websearch>` opening tag (not closing tag) for immediate banner display.
3. **Nginx buffering** - Added `gzip off`, `proxy_cache off`, `chunked_transfer_encoding on` to prevent SSE buffering.
4. **Event loop yielding** - Added `setImmediate()` yield between sending events and blocking operations.

**New features:**
- `interaction_update` event - Updates banner content when full query is known
- Elapsed time display - Banner shows "Completed in X.Xs" instead of just "Complete"
- Text shadows on message content and timestamps for improved readability

**Files changed:**
- `server/routes/messages-stream.mjs` - Restructured websearch handling with proper event timing
- `public/js/api.js` - Fixed multi-chunk SSE parsing, added `interaction_update` handler
- `public/js/app.js` - Added `onInteractionUpdate`, `formatElapsedTime`, `updateInteractionBannerContent`
- `public/js/markup.js` - Removed duplicate websearch banner rendering (now handled by interaction events)
- `nginx/locations.nginx-include` - SSE buffering prevention settings
- `public/css/chat.css` - Text shadow on timestamps
- `public/css/content.css` - Text shadow on message content

### UI/UX Improvements (Complete)
Various improvements to the chat interface and styling.

**CSS changes:**
- Fixed `white-space: pre-wrap` causing large gaps (changed to `normal`, kept `pre-wrap` on code blocks)
- Fixed horizontal text overflow with `min-width: 0` and `overflow-wrap: break-word`
- Balanced line-heights: body text 1.4, list items 1.35, headings 1.2
- Zero vertical margins for tight, consistent spacing
- Added dedicated link color variables (`--link`, `--link-hover`, `--info`)
- Fixed bullet point overflow with `list-style-position: inside`

**Link handling:**
- All links now open in new tabs (`target="_blank"`)
- Added `rel="noopener noreferrer"` for security
- Links use new light blue color (`#64b5f6`) that fits the dark theme

**Message timestamps:**
- "Just now" only shows for first 5 minutes
- After 5 minutes, shows human-readable time (e.g., "2:30 PM", "yesterday 4:15 PM")

### Content Accumulation Fix (Complete)
Fixed issue where interaction responses would replace original message content.

**Problem:** When an agent sent a message with an `<interaction>` tag, the follow-up response would completely replace the original text.

**Solution:** Server now accumulates all content segments (initial message + follow-up responses) and combines them in the final output.

**Changes:**
- `server/routes/messages-stream.mjs` - Track `contentSegments` array instead of replacing `currentContent`
- Added regex to strip leaked feedback format (`[@system:...]`) from final output
- Clean up extra whitespace in combined content

### System Prefix Rename (Complete)
Changed system ability prefix from `system_` to `_` for cleaner naming.

**Changes:**
- Renamed `act.md` → `think.md`
- Updated `isSystemProcess()` to check for `_` prefix
- Changed `system_web_search` → `_web_search`
- Updated validation to prevent user abilities starting with `_`

### Abilities UI Enhancements (Complete)
- Added "applies" field to ability edit modal (describes when to use the ability)
- Added type badges: green "function", purple "command", blue "ability"
- Fixed user abilities not showing in list (added `loadUserAbilities()` call)
- Added sessionStorage persistence for modal draft fields

### Interactions System (Complete)
Implemented a unified InteractionBus system for agent↔system↔user communication with function registration pattern.

**New files:**
- `server/lib/interactions/bus.mjs` - Central message bus with pub/sub
- `server/lib/interactions/function.mjs` - Base InteractionFunction class
- `server/lib/interactions/detector.mjs` - Detects interactions in agent responses
- `server/lib/interactions/functions/system.mjs` - Routes @system target interactions
- `server/lib/interactions/functions/websearch.mjs` - Web search function
- `spec/lib/interactions/interactions-spec.mjs` - 60 comprehensive tests

**Key concepts:**
- `InteractionFunction` base class with static `register()` method
- `PERMISSION` constants: ALWAYS, ASK, NEVER
- Dynamic agent instructions via `buildAgentInstructions()`
- Function classes registered with `registerFunctionClass(Class)`

### Message Types (Complete)
Added message type system for filtering hidden messages in UI.

**Database changes:**
- Migration 008: Added `type` column (message, interaction, system, feedback)
- Index on (session_id, type) for efficient queries

**UI changes:**
- "Show hidden messages" checkbox in chat toolbar
- Type badges for hidden messages (system, interaction, feedback)
- CSS styling for hidden message visibility

### UI Rename: Processes → Abilities (Complete)
Renamed "Processes" to "Abilities" throughout the user interface for consistency with the abilities system.

**Files changed:**
- `public/index.html` - Button labels, modal titles, form elements
- `public/js/app.js` - State variables, functions, DOM element references
- `public/css/agents.css` - CSS class names

### Ask Always Permission System (Complete)
Implemented a permission wrapper for commands that requires user approval every time.

**New files:**
- `server/lib/abilities/loaders/commands.mjs` - Command abilities loader
- `server/lib/operations/handlers/command.mjs` - Command operation handler

**Command abilities registered:**
- `command_ability` - Create, edit, delete abilities (Ask Always)
- `command_session` - Create, archive, spawn sessions (Ask Always)
- `command_agent` - List, configure, delete agents (Ask Always)

**How it works:**
- Commands use `autoApprovePolicy: 'never'` which means user approval is always required
- AI can invoke commands via the `command` operation handler
- Each invocation triggers the approval flow via WebSocket

### Session Status & Parent Hierarchy (Complete)
Replaced the boolean `archived` column with a flexible `status` system and added parent-child session relationships.

**Database changes:**
- Migration 006: Added `status` column (NULL, 'archived', 'agent', etc.)
- Migration 006: Added `parent_session_id` column for session hierarchy
- Migrated existing `archived=1` rows to `status='archived'`

**API changes:**
- GET /api/sessions now accepts `showHidden=1` (also supports legacy `archived=1`)
- Sessions are ordered with children grouped under their parents
- New PUT /api/sessions/:id/status endpoint for status updates
- All session responses include `status`, `parentSessionId`, `depth` fields

**Frontend changes:**
- Sessions list shows child sessions indented under parents
- Archived sessions have a red hue background
- Agent sessions have a blue hue background and "agent" badge
- Toggle button now shows/hides all hidden sessions (archived + agent)

### Hidden Messages Feature (Complete)
Implemented "suppressMessage" functionality to hide `__onstart_` messages from the chat UI while still sending them to the AI.

**Changes made:**
- `server/database.mjs` - Added migration 005_messages_hidden (adds `hidden` column to messages table)
- `server/routes/messages-stream.mjs` - Startup messages now stored with `hidden=1`
- `server/routes/messages.mjs` - Startup messages now stored with `hidden=1`, GET endpoint includes hidden flag
- `server/routes/sessions.mjs` - GET /:id includes hidden flag in messages response
- `public/js/app.js` - `renderMessages()` filters out hidden messages from display
- `docs/api.md` - Updated to document hidden field on messages
- `docs/server.md` - Updated to document hidden messages feature

## Architecture

### Interactions System

The interactions system replaces the old operations system with a unified message bus:

```
Agent Response
      │
      ▼
┌─────────────────┐
│ Detector        │ Finds @target(method, args) patterns
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ InteractionBus  │ Routes to registered handlers
└────────┬────────┘
         │
         ├─→ @system → SystemFunction router
         │              │
         │              ├─→ websearch → WebSearchFunction
         │              ├─→ bash → BashFunction
         │              └─→ ... (registered functions)
         │
         ├─→ @user → User notification
         │
         └─→ @agent → Message queue for agent
```

### Function Registration

Functions self-register with metadata:

```javascript
class WebSearchFunction extends InteractionFunction {
  static register() {
    return {
      name: 'websearch',
      permission: PERMISSION.ALWAYS,
      schema: {
        query: { type: 'string', required: true },
      },
      examples: [
        { method: 'search', args: { query: 'hiking boots' } },
      ],
    };
  }
}

registerFunctionClass(WebSearchFunction);
```

## Previous Session Work

- Fixed streaming export error (`EXECUTABLE_ELEMENTS` not exported from stream-parser.mjs)
- Fixed streaming freeze issue (UI stuck with typing indicator)
- Made `message_complete` event always fire, even on empty/error responses
- Made `finalizeStreamingMessage()` idempotent in frontend
