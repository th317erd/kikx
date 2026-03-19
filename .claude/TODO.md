# TODO: tool-log.yaml Implementation
# Coordinator: Claude (this bot)
# Parallel: compaction.yaml (other bot — DO NOT touch compaction files)
# Plan: bot-docs/future-plans/tool-log.yaml
# Started: 2026-03-19

## ⚠️ Collision Avoidance Notes
# Files SHARED with compaction bot — coordinate carefully:
#   - src/core/interaction/index.mjs         ← both bots modify this
#   - src/core/routing/base-plugin-class.mjs ← both bots register plugins here
# Strategy: commit tool-log changes first with clear AGIS comments marking
# where compaction hooks go. Pull before every push.

## Phase 1: Foundation — ValueStore Schema
# Owner: Sub-agent A (run in background)
# Independent — can run immediately

- [ ] 1a. Add `note` (STRING 256, nullable, indexed) column to ValueStore model
- [ ] 1b. Add `type` (STRING 64, nullable, indexed) column to ValueStore model
- [ ] 1c. Write/extend spec/core/models/value-store-spec.mjs:
          - create entry with note+type set
          - query by type (exact)
          - query by type (wildcard)
          - query by note (wildcard)
          - null note/type: existing entries unaffected
- [ ] 1d. Run tests — confirm passing
- [ ] MILESTONE: Commit "feat(tool-log): add note+type columns to ValueStore [step 1]"

## Phase 2: ToolLogService — Storage Helper
# Owner: Sub-agent B (run in background, parallel with Phase 1 research)
# Depends on: Phase 1 complete (needs ValueStore columns)

- [ ] 2a. Create src/core/interaction/tool-log-service.mjs
          ToolLogService.storeToolOutput({ sessionID, interactionID, agentID,
            organizationID, toolName, pluginID, toolCallArgs, output, keystore })
          - Generates XID key with prefix 'tl_'
          - value = JSON.stringify({ args: toolCallArgs, output })
          - note = first meaningful string from toolCallArgs (command, query, etc.)
          - type = "tool_log:{pluginID}:{toolName}"
          - Creates ValueStore entry, signs with Ed25519
          - Returns { id, key }
          - Never throws — catches and logs errors, returns null on failure
- [ ] 2b. Write tests in spec/core/interaction/tool-log-interception-spec.mjs:
          HAPPY: stores output, correct fields set, returns {id, key}
          FAILURE: DB write fails → returns null, no throw
          EDGE: empty output, long output, special chars in toolCallArgs

## Phase 3: InteractionLoop Interception
# Owner: Sub-agent C
# Depends on: Phase 2 complete (needs ToolLogService)
# ⚠️ SHARED FILE: src/core/interaction/index.mjs

- [ ] 3a. In _iterateGenerator(), find where tool-result blocks are processed
- [ ] 3b. Inject interception hook:
          After tool executes → call ToolLogService.storeToolOutput()
          Count Unicode chars of output
          If <= 1024: deliver original inline (+ stored)
          If > 1024: deliver pointer JSON instead
- [ ] 3c. Add clear AGIS comments in index.mjs marking where compaction bot adds its hooks
- [ ] 3d. Write tests in spec/core/interaction/tool-log-interception-spec.mjs (extend):
          HAPPY: <= 1024 → inline + stored; > 1024 → pointer + stored
          FAILURE: storeToolOutput returns null → tool still delivered unchanged
          EDGE: exactly 1024 chars → inline; exactly 1025 → pointer
- [ ] MILESTONE: Commit "feat(tool-log): intercept tool outputs in InteractionLoop [steps 2-3]"
                 Note in commit: "⚠️ index.mjs modified — compaction bot: see AGIS comments"

## Phase 4: Internal Tools — tool_log:get + tool_log:search
# Owner: Sub-agent D (can start after Phase 1 complete — uses ValueStore)
# Parallel with Phase 3

- [ ] 4a. Create src/core/internal-plugins/tool-log/index.mjs
- [ ] 4b. Implement GetToolLogTool:
          - Validate id (required, non-empty) → 400 if missing
          - Load ValueStore by key WHERE ownerID=agentID AND namespace='tool_log'
          - 404 if not found; 403 if wrong owner
          - Parse value JSON, extract output
          - Apply content_start/content_end (char slice)
          - Apply content_lines=true → line-based slice
          - Return full response shape (see plan)
- [ ] 4c. Implement SearchToolLogTool:
          - Query ValueStore WHERE ownerType='agent' AND ownerID=agentID AND namespace='tool_log'
          - Apply: query wildcard on type+note, toolName filter, sessionID filter,
            before/after datetime filters
          - Clamp limit to 100; default 10
          - For each result: parse value JSON, apply content slice → content_preview
          - Return empty array (not error) on no matches
- [ ] 4d. Register both tools in setup() function
- [ ] 4e. Register tool-log plugin in base-plugin-class.mjs
          ⚠️ Add comment: "# compaction.yaml will also register frame-search here"
- [ ] 4f. Write tests in spec/core/internal-plugins/tool-log-spec.mjs:
          HAPPY: get owned entry, search by toolName, search by sessionID
          FAILURE: 404/403/400 errors, DB failure, injection attempts
          EDGE: content_lines, content_start > length, no newlines + lines=true,
                same tool twice, two agents same session
- [ ] MILESTONE: Commit "feat(tool-log): tool_log:get and tool_log:search internal tools [steps 4-5]"

## Phase 5: Full Test Suite + Final Polish
# Owner: Coordinator (this bot)

- [ ] 5a. git pull (check for compaction bot changes)
- [ ] 5b. Run full test suite: npm test
- [ ] 5c. Fix any regressions
- [ ] 5d. Verify test counts haven't dropped unexpectedly
- [ ] MILESTONE: Commit "feat(tool-log): finished — all tests passing [tool-log complete]"

## Phase 6: Coordination — Wait for Compaction Bot
# Coordinator polls git pull every ~2 minutes

- [ ] 6a. Poll git pull until compaction bot pushes "finished" commit
- [ ] 6b. Run npm test after compaction bot finishes
- [ ] 6c. Fix any integration issues between tool-log and compaction
- [ ] 6d. Final commit if needed: "fix: post-compaction integration fixes"

## Status: IN PROGRESS — Phase 1 research underway
