# Phase C2: Migrate Scheduling to Router

## Status: COMPLETE

## Overview
Convert SchedulerOrchestrator logic into the routing system.
The scheduling plugin registers for user-message frames and
triggers agent interactions. SessionScheduler absorbs trigger
queue management and interaction:end handling.

## Steps

### Step 1: Auto-connect FrameRouter to session FrameManagers
- [x] Modify `SessionManager.getFrameManager()` to connect FrameRouter
- [x] Pass session context `{ id: sessionID }` to `connectTo()`
- [x] Add tests for auto-connection

### Step 2: Enhance SessionScheduler with trigger queue
- [x] Add `_pendingTriggers` Map to SessionScheduler
- [x] Add `queueTrigger(sessionID, agentID)`
- [x] Add `dequeueTrigger(sessionID)` → `{ agentID }` or `null`
- [x] Add `clearTriggers(sessionID)`
- [x] Add `hasPendingTriggers(sessionID)`
- [x] Add `connectToInteractionLoop(interactionLoop, agentResolver)` for interaction:end handling
- [x] Move `_triggerNext()` and `_triggerAgent()` from orchestrator
- [x] Add tests for new methods

### Step 3: Create scheduling internal plugin
- [x] Create `src/core/internal-plugins/scheduling/index.mjs`
- [x] SchedulingPlugin extends BasePluginClass
- [x] Register `type:user-message` selector in setup()
- [x] In process(): check authorType=user, call scheduler.onCommit(), queue triggers
- [x] Add tests

### Step 4: Wire into Application (replace orchestrator)
- [x] Remove SchedulerOrchestrator creation from Application
- [x] Call `scheduler.connectToInteractionLoop()` instead
- [x] FrameRouter auto-connects via SessionManager
- [x] Verify all scheduling still works

### Step 5: Adapt existing tests
- [x] Write C2-specific tests (trigger queue, connectToInteractionLoop, plugin, auto-connect)
- [x] All existing scheduling tests pass
- [x] All 1566 tests pass (0 failures)

### Step 6: Commit
- [ ] Commit with descriptive message
