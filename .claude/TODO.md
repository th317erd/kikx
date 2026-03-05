# Phase B: Multi-Actor — Reactive Frame Engine

**Baseline:** 1303 tests, all passing
**Final:** 1327+ tests, all passing

## Step B1: Add Author Fields to Frame Value Object ✅
- [x] Add `authorType` and `authorID` to Frame constructor (default `null`)
- [x] Write tests in `src/shared/spec/frame-author-spec.mjs` (6 tests)
- [x] Verify all tests pass

## Step B2: Structural ACL Commit Validator ✅
- [x] Create `src/core/permissions/structural-acl-validator.mjs`
- [x] Write tests in `spec/core/permissions/structural-acl-validator-spec.mjs` (24 tests)
- [x] Verify all tests pass

## Step B3: Frame Creation Through FrameManager (The Pivot) ✅
- [x] Add `syncOrderCounter()` to FrameManager
- [x] Add `_createFrame()` helper to InteractionLoop
- [x] Update `getFrameManager()` on SessionManager to accept commitValidator
- [x] Refactor all frame creation sites to use `_createFrame()`
- [x] Write tests in `spec/core/interaction-frame-commits-spec.mjs` (9 tests)
- [x] Verify all tests pass

## Step B4: Per-Agent Refs ✅
- [x] Add `_ensureAgentRef()` and `_advanceAgentRef()` to InteractionLoop
- [x] Write tests in `spec/core/agent-ref-spec.mjs` (7 tests)
- [x] Verify all tests pass

## Step B5: Session Scheduler ✅
- [x] Create `src/core/scheduling/session-scheduler.mjs`
- [x] Create `src/core/scheduling/agent-resolver.mjs`
- [x] Write tests in `spec/core/scheduling/session-scheduler-spec.mjs` (15 tests)
- [x] Verify all tests pass

## Step B6: Message Assembly v2 ✅
- [x] Update `_buildMessages()` with `forAgentID` parameter
- [x] Add multi-agent primer additions to PrimerAssembler
- [x] Write tests in `spec/core/message-assembly-v2-spec.mjs` (12 tests)
- [x] Verify all tests pass

## Step B7: Controller + Transport Integration ✅
- [x] Wire SessionScheduler into Application (`src/server/application.mjs`)
- [x] Add `getSessionScheduler()` to ControllerBase
- [x] Write integration tests in `spec/core/scheduler-integration-spec.mjs` (6 tests)
- [x] Verify all tests pass

## Step B8: Stop/Interrupt as Commit ✅
- [x] Update `cancelInteraction()` to create stop frame via FrameManager
- [x] Add stop-frame handling to SessionScheduler (`_handleStopFrames`, `_cancelAgent`)
- [x] Stop frame already excluded from message assembly (done in B6)
- [x] Write tests in `spec/core/stop-as-commit-spec.mjs` (7 tests)
- [x] Verify all tests pass (1327 tests, 0 failures)

## Phase B Complete 🎉
All 8 steps implemented and tested.
