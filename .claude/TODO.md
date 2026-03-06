# Wire SessionScheduler into Live Flow

## Steps

- [x] **Step 1**: Enrich `interaction:end` with agentID in InteractionLoop (3 emission sites)
- [x] **Step 2**: Emit `commit` event from `_createFrame` in InteractionLoop
- [x] **Step 3**: Add resolve context storage to SessionScheduler (`_resolveContexts` Map)
- [x] **Step 4**: Add `buildCallbacks` to AgentResolver (factor from InteractionController)
- [x] **Step 5**: Primer injection for first-time agents (check agentRefExists)
- [x] **Step 6**: Create SchedulerOrchestrator (new file)
- [x] **Step 7**: Modify InteractionController (stash resolve context, pass agentCount)
- [x] **Step 8**: Wire in Application (create AgentResolver, SchedulerOrchestrator, start)
- [x] **Step 9**: Tests (orchestrator spec + scheduler spec updates)
- [x] **Step 10**: Run `npm test` and verify all pass (1421 tests, 0 failures)
