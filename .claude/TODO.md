# Puppeteer E2E Testing — Completed Features

## Step 1: Setup & Login ✅
- [x] Verify server is running at `https://wyatt-desktop.mythix.info/kikx/`
- [x] Navigate to login page
- [x] Log in as `test-bot@kikx.com` / `securePass123`
- [x] Verify dashboard/session list loads (sidebar with agents, sessions, status bar)

## Step 2: Abilities System ✅
- [x] Create a new session with `test-claude` agent
- [x] Send a message instructing the agent to update its abilities
- [x] Agent requests permission for `memory:getAgentConfig` → approve
- [x] Agent requests permission for `memory:updateAgentConfig` → approve
- [x] Verify agent responds acknowledging the ability change
- [x] Start a NEW session with `test-claude` to verify abilities persist across sessions
- [x] Agent responds in pirate speak when asked about weather (abilities working!)

### Bugs Found & Fixed:
1. **Missing `agentID` in body** → no agent processing (201 not 202)
2. **`agentID` not injected into tool execution** → `UpdateAgentConfigTool` failed
   - Fix: inject agent context for ALL tool calls, not just `system:command`
3. **`toolUseID` casing mismatch** → Anthropic API 400 on permission replay
   - Plugin emits `toolUseId` (camelCase), core stored `toolUseID` (uppercase)
   - Fix: accept both casings in core + plugin
4. **Abilities not in primer** → `resolvedAgent` plain object missing `hasAbilities()`
   - Fix: preserve convenience methods on resolved agent
5. **Silent error swallowing** → errors only stored as frames, no console output
   - Fix: added `console.error()` in `_iterateGenerator` catch block

## Step 3: Inter-Agent Streaming ✅
- [x] Create multi-agent session via API (test-claude + test-claude-2)
- [x] Send message, both agents respond
- [x] Agent 2 sees Agent 1's response in context (inter-agent streaming confirmed)
- [x] UI renders all 3 interactions (user + 2 agents) with correct attribution
- [x] SSE Connected once session loaded

### Bug Found & Fixed:
6. **Scheduling plugin lazy-resolution test regression** — 6 tests failed after lazy-resolution fix
   - Root cause: FrameRouter scheduling plugin auto-calls `onCommit` on merge,
     conflicting with tests that manually call `onCommit`
   - Fix: Added `silent: true` to test merges, `markComplete` cleanup, updated test expectations

## Step 4: Agent Deliberation / Child Sessions ✅
- [x] Send message instructing agent to use `cross-session:createSession`
- [x] Permission request for high-risk tool → approve
- [x] Tool executes: child session created with parentSessionID + linkedFrameID
- [x] `session-link` frame appears in parent session
- [x] Child session has initial message from agent
- [x] UI shows permission request (Processed), session-link card, and agent response

### Bugs Found & Fixed:
7. **Scheduler double-trigger in single-agent sessions** — scheduling plugin queued
   trigger for primary agent (already handled by controller), then re-triggered on
   interaction end with no resolve context → crypto decrypt failure
   - Fix: Added `markActive()` to SessionScheduler; controller marks primary agent
     active before starting interaction; always set resolve context (not just multi-agent)

## Step 5: Agent Memory Context ✅
- [x] Create fresh session with test-claude agent
- [x] Ask about weather — agent explicitly references "my abilities section" and responds in pirate speak
- [x] Confirms agent config (abilities) persists across sessions via DB → PrimerAssembler injection
- [x] UI renders pirate response with interactive form (location input)
- [x] No server errors — `markActive` fix prevents double-trigger

### No new bugs found.

---

## Summary

**All 5 E2E steps complete.** 7 bugs found and fixed across 2 sessions:
- Bugs 1-5: Abilities system (Step 2)
- Bug 6: Scheduling plugin test regression (Step 3)
- Bug 7: Scheduler double-trigger / crypto error (Step 4)

All 2311 unit tests pass. All features verified end-to-end via Puppeteer + API.
