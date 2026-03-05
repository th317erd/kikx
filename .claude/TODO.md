# Phase B: Multi-Actor — Reactive Frame Engine

**Baseline:** 1303 tests, all passing

## Step B1: Add Author Fields to Frame Value Object
- [ ] Add `authorType` and `authorID` to Frame constructor (default `null`)
- [ ] Write tests in `src/shared/spec/frame-author-spec.mjs`
- [ ] Verify all 1303+ tests pass

## Step B2: Structural ACL Commit Validator
- [ ] Create `src/core/permissions/structural-acl-validator.mjs`
- [ ] Write tests in `spec/core/permissions/structural-acl-validator-spec.mjs`
- [ ] Verify all tests pass

## Step B3: Frame Creation Through FrameManager (The Pivot)
- [ ] Add `_createFrame()` helper to InteractionLoop
- [ ] Update `getFrameManager()` on SessionManager to accept commitValidator
- [ ] Refactor all frame creation sites to use `_createFrame()`
- [ ] Write tests in `spec/core/interaction-frame-commits-spec.mjs`
- [ ] Verify all tests pass

## Step B4: Per-Agent Refs
- [ ] Add ref management in startInteraction/iterateGenerator
- [ ] Write tests in `spec/core/agent-ref-spec.mjs`
- [ ] Verify all tests pass

## Step B5: Session Scheduler
- [ ] Create `src/core/scheduling/session-scheduler.mjs`
- [ ] Create `src/core/scheduling/agent-resolver.mjs`
- [ ] Write tests in `spec/core/scheduling/session-scheduler-spec.mjs`
- [ ] Verify all tests pass

## Step B6: Message Assembly v2
- [ ] Update `_buildMessages()` with `forAgentID` parameter
- [ ] Add multi-agent primer additions
- [ ] Write tests in `spec/core/message-assembly-v2-spec.mjs`
- [ ] Verify all tests pass

## Step B7: Controller + Transport Integration
- [ ] Wire SessionScheduler into InteractionController
- [ ] Update WebSocket transport for scheduler events
- [ ] Extend integration specs
- [ ] Verify all tests pass

## Step B8: Stop/Interrupt as Commit
- [ ] Add `stop` frame type
- [ ] Update cancelInteraction to create stop frame via FrameManager
- [ ] Write tests in `spec/core/stop-as-commit-spec.mjs`
- [ ] Verify all tests pass
