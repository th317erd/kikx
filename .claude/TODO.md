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

- [ ] Add `getConfig()` to Agent model returning `{ riskLevel: 'medium' }`
- [ ] Tests: `spec/core/models/agent-config-spec.mjs`

## Step 2: Session Constraints (`maxInteractions`, `endsAt`)

- [ ] Add `maxInteractions` (integer, nullable) and `endsAt` (datetime, nullable) to Session model, bump version to 2
- [ ] Commit-level constraint enforcement (commitValidator): archive session when hit
- [ ] Create `session-constrained` system frame before archiving
- [ ] Only agent-authored commits count toward `maxInteractions`
- [ ] Tests: `spec/core/models/session-constraints-spec.mjs`
- [ ] Tests: `spec/core/session/constraint-enforcement-spec.mjs`

## Step 3: Per-Agent Interaction Loops

- [ ] Change `InteractionLoop._active` key from `sessionID` to `${sessionID}:${agentID}`
- [ ] Allow concurrent agent interactions in same session
- [ ] Update `isActive()` to support both session-level and agent-level checks
- [ ] SessionScheduler: trigger all agents with pending refs concurrently
- [ ] Tests: `spec/core/interaction/per-agent-loop-spec.mjs`
- [ ] Tests: `spec/core/scheduling/concurrent-trigger-spec.mjs`

## Step 4: Session Ancestry Queries + Caching

- [ ] `SessionManager.getAncestryChain(sessionID)` — bulk-load ancestry via recursive query
- [ ] `SessionManager.getNearestUserAncestor(sessionID)` — find closest ancestor with user
- [ ] Cache per session (ancestry is immutable)
- [ ] Tests: `spec/core/session/ancestry-spec.mjs`
- [ ] Tests: `spec/core/session/nearest-user-ancestor-spec.mjs`

## Step 5: Permission Walk-Up in PermissionEngine

- [ ] `checkPermission()` queries rules across all ancestor sessions (via cached ancestry)
- [ ] Guard on `agent.getConfig().riskLevel` — throw on non-medium
- [ ] Closest ancestor match wins
- [ ] Tests: `spec/core/permissions/permission-walkup-spec.mjs`

## Step 6: `CrossSessionPermissions` Class

- [ ] Create `src/core/internal-plugins/cross-session/cross-session-permissions.mjs`
- [ ] `createSession` always requires explicit approval (no rule matching)
- [ ] `postToSession` to parent auto-approved if agent is parent participant (logic-based)
- [ ] Wire into CreateSessionTool and PostToSessionTool via `getPermissionsClass()`
- [ ] Tests: `spec/core/internal-plugins/cross-session/cross-session-permissions-spec.mjs`

## Step 7: Cross-Session Permission Approval

- [ ] `PermissionHandler.hardBreak()`: create permission-request in nearest user ancestor
- [ ] `pending-action` stays in requesting (child) session
- [ ] `approve()`: commit tool-result to requesting session's FrameManager
- [ ] No user in ancestry → deny immediately
- [ ] Tests: `spec/core/interaction/cross-session-permission-spec.mjs`

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
