# Agent Deliberation via Child Sessions

## Previously Completed (Streaming Foundation)

- [x] Participant `role` field (coordinator/member) on Participant model
- [x] SessionManager: `addParticipant` with role, `updateParticipant`, `getCoordinators()`
- [x] Streaming identity: SSE events carry `agentID`, `authorType`, `authorID`
- [x] Multi-agent streaming display: per-agent typing indicators, delta routing
- [x] Cross-session StreamRelay: delta forwarding across session boundaries

## Step 0: Cleanup Wrong-Approach Code

- [ ] Delete `src/core/scheduling/discussion-orchestrator.mjs`
- [ ] Delete `spec/core/scheduling/discussion-orchestrator-spec.mjs`
- [ ] Delete `spec/core/scheduling/discussion-integration-spec.mjs`
- [ ] Revert `discussion` frame branch in `src/core/interaction/message-history.mjs`
- [ ] Revert coordinator detection in `src/core/internal-plugins/scheduling/index.mjs`
- [ ] Revert discussion rendering in `src/client/components/kikx-session-page/kikx-session-page.mjs`
- [ ] Rename `multi-coordinator-protocol.yaml` → `agent-deliberation.yaml` with new content
- [ ] Update `inter-agent-streaming.yaml` with `related` link
- [ ] Create `danger-level-permissions.yaml`
- [ ] Create `agent-memory-context.yaml`
- [ ] Create `applicable-permitters.yaml`
- [ ] Create `constraint-warnings.yaml`
- [ ] Full test suite pass after cleanup

## Step 1: `agent.getConfig()` Stub

- [x] Add `getConfig()` to Agent model returning `{ riskLevel: 'medium' }`
- [x] Tests: `spec/core/models/agent-config-spec.mjs`

## Step 2: Session Constraints (`maxInteractions`, `endsAt`)

- [x] Add `maxInteractions` (integer, nullable) and `endsAt` (datetime, nullable) to Session model, bump version to 2
- [x] Commit-level constraint enforcement (commitValidator): archive session when hit
- [x] Create `session-constrained` system frame before archiving
- [x] Only agent-authored commits count toward `maxInteractions`
- [x] Tests: `spec/core/models/session-constraints-spec.mjs` (14 tests)
- [x] Tests: `spec/core/session/constraint-enforcement-spec.mjs` (24 tests)

## Step 3: Per-Agent Interaction Loops

- [x] Change `InteractionLoop._active` key from `sessionID` to `${sessionID}:${agentID}`
- [x] Allow concurrent agent interactions in same session
- [x] Update `isActive()` to support both session-level and agent-level checks
- [x] SessionScheduler: trigger all agents with pending refs concurrently
- [x] Tests: `spec/core/interaction/per-agent-loop-spec.mjs` (15 tests)
- [x] Tests: `spec/core/scheduling/concurrent-trigger-spec.mjs` (9 tests)

## Step 4: Session Ancestry Queries + Caching

- [x] `SessionManager.getAncestryChain(sessionID)` — iterative walk-up via parentSessionID chain
- [x] `SessionManager.getNearestUserAncestor(sessionID)` — find closest ancestor with user frame (authorType === 'user')
- [x] `SessionManager.clearAncestryCache(sessionID)` — invalidates cache for session and any chains containing it
- [x] Cache per session (ancestry is immutable, no TTL)
- [x] Tests: `spec/core/session/ancestry-spec.mjs` (14 tests)
- [x] Tests: `spec/core/session/nearest-user-ancestor-spec.mjs` (14 tests)

## Step 5: Permission Walk-Up in PermissionEngine

- [x] `checkPermission()` queries rules across all ancestor sessions (via cached ancestry)
- [x] Guard on `agent.getConfig().riskLevel` — throw on non-medium
- [x] Closest ancestor match wins
- [x] Tests: `spec/core/permissions/permission-walkup-spec.mjs` (24 tests)

## Step 6: `CrossSessionPermissions` Class

- [ ] Create `src/core/internal-plugins/cross-session/cross-session-permissions.mjs`
- [ ] `createSession` always requires explicit approval (no rule matching)
- [ ] `postToSession` to parent auto-approved if agent is parent participant (logic-based)
- [ ] Wire into CreateSessionTool and PostToSessionTool via `getPermissionsClass()`
- [ ] Tests: `spec/core/internal-plugins/cross-session/cross-session-permissions-spec.mjs`

## Step 7: Cross-Session Permission Approval

- [ ] Write tests first (TDD red phase): `spec/core/interaction/cross-session-permission-spec.mjs`
  - [ ] Permission request in child session with no user → appears in parent session
  - [ ] Permission request walks up multiple levels to find user session
  - [ ] No user in ancestry → immediate denial
  - [ ] Approval in parent routes tool-result to child session's FrameManager
  - [ ] Denial in parent routes denial to child session
  - [ ] Child session retains pending-action frame locally
  - [ ] Permission request in session WITH a user → stays in same session (backward compat)
  - [ ] Edge case: parent session FrameManager not loaded
- [ ] Implement `PermissionHandler.hardBreak()` cross-session awareness
  - [ ] Check if current session has user frames
  - [ ] If no user, call `SessionManager.getNearestUserAncestor(sessionID)`
  - [ ] Create `permission-request` frame in ancestor's FrameManager
  - [ ] Keep `pending-action` frame in child's FrameManager
  - [ ] Store `requestingSessionID` in permission-waiting state
  - [ ] If no user ancestor, deny immediately
- [ ] Implement `approve()` cross-session routing
  - [ ] Commit tool-result to requesting (child) session's FrameManager
  - [ ] Use `requestingSessionID` from waiting state
- [ ] Implement `deny()` cross-session routing
  - [ ] Commit denial frames to requesting (child) session's FrameManager
- [ ] Run cross-session-permission tests → green
- [ ] Run interaction-loop-spec → no regression

## Step 8: `createSession` Tool Extension

- [ ] Add `initialMessage` and `constraints` to createSession inputSchema
- [ ] Creating agent → coordinator, others → members
- [ ] `initialMessage` creates first frame authored by creating agent
- [ ] Agent-created child: default constraints if none specified
- [ ] Tests: `spec/core/internal-plugins/cross-session/create-session-extended-spec.mjs`

## Step 9: Integration Test

- [ ] Full end-to-end: create child session → concurrent agents → postToSession → permissions
- [ ] Tests: `spec/core/integration/child-session-deliberation-spec.mjs`
- [ ] Full test suite pass
