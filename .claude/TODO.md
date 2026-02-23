# API-First: Frame Decomposition + Structured Permission Frames + REST Response

## Phase 1: Frame Decomposition (Pure Function)
- [x] Write tests: `spec/lib/frames/decompose-spec.mjs` (30 tests)
- [x] Implement: `server/lib/frames/decompose.mjs`
- [x] All decompose tests passing

## Phase 2: Wire Decomposition Into Message Pipeline
- [x] Update `server/routes/messages-stream.mjs` — use decomposer for agent message storage
- [x] Update `server/routes/messages.mjs` — use decomposer
- [x] Verify `server/lib/frames/context.mjs` works with decomposed frames (no changes needed)
- [x] Integration tests passing

## Phase 3: Structured Permission Request Frames
- [x] Update `server/lib/permissions/prompt.mjs` — emit structured request + result frames
- [x] Update `spec/lib/permission-prompt-spec.mjs` with structured frame tests (7 new tests)

## Phase 4: REST Endpoint for Frame Responses
- [x] Write tests: `spec/routes/frames-respond-spec.mjs` (11 tests)
- [x] Add `POST /:sessionId/frames/:frameId/respond` to `server/routes/frames.mjs`
- [x] All endpoint tests passing

## Phase 5: Bug Fixes
- [x] 5a: Add `db: db` + `parentFrameId` to interaction context in `messages.mjs`
- [x] 5b: Non-streaming endpoint: `Promise.race` with 30s timeout + 202 on pending permission

## Phase 6: Post-Compaction Startup Re-injection
- [x] Re-inject `__onstart_` startup abilities after compaction in `loadFramesForContext`
- [x] Write tests for startup re-injection after compaction (4 new tests)
- [x] All tests passing (2251 tests, 0 failures)

## Phase 7: Route HML websearch through permission engine
- [x] Replace abilities approval (`checkApprovalRequired`/`requestApproval`) with permission engine in messages-stream.mjs
- [x] Permission prompt shows as "⚡ Permission Request" (system frame, not agent)
- [x] Agent name appears in permission description (not "agent #8")
- [x] CSS: agent header/footer text white, 14px, bold

## Phase 8: Permission Prompt Answer Bug Fixes
- [x] Permission prompt answers stored as hidden (don't clutter conversation)
- [x] Permission prompt answers skip agent turn (agent doesn't respond to "Answering 1 prompt...")
- [x] `allow_once` no longer creates persistent rule (was effectively "allow twice")
- [x] Applied to both streaming and non-streaming endpoints

## Verification
- [x] `npm test` — 2349 tests, 0 failures
- [ ] Browser smoke test (last)
