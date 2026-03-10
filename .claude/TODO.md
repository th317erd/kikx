# Follow-Up: Thread UI, Session-Links, Plugin Wiring, and Gaps

Previous work: Session Relationships, Cross-Session Tools, and Thread Support (committed `ad21e8c` on `v2`).

## Items 1-6 (from next-steps list)

### 1. Thread Client UI ✅
- [x] Reply button on interaction bubbles
- [x] Reply banner on message input (with cancel)
- [x] Reply count badges on parent messages
- [x] Reply context indicator on child messages
- [x] parentId in send-message event flow
- [x] 13 UI tests (6 interaction + 7 message-input)

### 2. Session-Link Frame Rendering ✅
- [x] `kikx-session-link` WebComponent (clickable card)
- [x] `session-link` case in `_renderFrame()`
- [x] `participant-joined`/`participant-left` hidden from chat
- [x] 6 component tests

### 3. Wire Cross-Session Plugin into Plugin Loader ✅
- [x] Verified: FilesystemPluginProvider auto-discovers all plugins — no changes needed

### 4. Self-Reference Guard on parentSessionID ✅
- [x] Guard in `SessionManager.createSession()`
- [x] Test in `session-relationships-spec.mjs`

### 5. listSessions Frame Content Search (Stopgap) ✅
- [x] In-memory FrameManager content search in `ListSessionsTool._execute()`
- [x] 3 tests in `cross-session-spec.mjs`

### 6. Command-Tool Unification ✅
- [x] `registerCapability()` API on PluginRegistry
- [x] CommandHandler resolves capabilities by slash command alias
- [x] InteractionController.executeTool resolves capabilities by name
- [x] HelpIndex includes capability entries
- [x] Migrated `/invite` → `invite` capability (slash + tool)
- [x] Migrated `/reload` → `reload` capability (slash + tool)
- [x] Updated `system:command` bridge to resolve capabilities
- [x] Updated agent instructions for direct capability usage
- [x] 21 new tests (12 registry + 6 command-handler + 3 help-index)

## Status
- **All 6 items complete.** 1961/1962 tests pass (1 pre-existing failure in participant-lifecycle-spec.mjs).
