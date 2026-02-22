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

## Verification
- [x] `npm test` — 2275 tests, 0 failures
- [ ] Browser smoke test (last)
