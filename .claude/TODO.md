# Phase 3 — V2 Differentiators (Steps 20-25) ✅ COMPLETE

Build order: 21 → 24r → 25 → 22 → 23 → 20

## Step 21 — Future-Plan File (Housekeeping)
- [x] Create `bot-docs/future-plans/device-approval-auth.yaml`

## Step 24r — Plugin Path Configuration
- [x] 24r-a: Plugin loader resilience (try/catch in loadAll, `_failed` Map, `getFailedPlugins()`)
- [x] 24r-b: `KIKX_PLUGIN_PATHS` env var support in `kikx-core.mjs`
- [x] Tests: `spec/core/plugin-loader-spec.mjs` additions (~4 tests)
- [x] Tests: `spec/core/core-entry-spec.mjs` additions (~3 tests)

## Step 25 — prepareMessage Hook
- [x] 25a: Hook registry (`_hooks` Map, `registerHook`, `getHookHandlers`, `getHooks`)
- [x] 25b: Plugin context (`registerHook` in `_buildPluginContext()`)
- [x] 25c: HookRunner (`src/core/hooks/hook-runner.mjs` + `src/core/hooks/index.mjs`)
- [x] 25d: Wire into KikxCore (`_loadPlugins()`)
- [x] 25e: Hook execution in InteractionLoop (4 hook points)
- [x] Tests: `spec/core/hooks/hook-runner-spec.mjs` (~20 tests)
- [x] Tests: `spec/core/plugin-loader-spec.mjs` additions (~8 tests)
- [x] Tests: `spec/core/interaction-loop-spec.mjs` additions (~12 tests)

## Step 22 — Full Permissions OOP
- [x] 22a: Permissions base class (`src/core/permissions/permissions-base.mjs`)
- [x] 22b: PermissionDeniedError (`src/core/permissions/permission-denied-error.mjs`)
- [x] 22c: PermissionEngine enhancements (toolClass, deny=throw, safety net, custom matching)
- [x] 22d: `riskLevel` on PluginInterface
- [x] 22e: Refactor ShellPermissions to extend Permissions
- [x] 22f: Wire `toolClass` into InteractionController
- [x] 22g: Catch PermissionDeniedError in InteractionLoop
- [x] 22h: Update permissions/index.mjs exports
- [x] Tests: `spec/core/permissions/permissions-base-spec.mjs` (~8 tests)
- [x] Tests: `spec/core/permissions/permission-engine-spec.mjs` additions (~15 tests)
- [x] Tests: `spec/core/internal-plugins/shell/shell-tool-spec.mjs` additions (~5 tests)
- [x] Tests: `spec/core/interaction-loop-spec.mjs` additions (~5 tests)

## Step 23 — Interaction Resumability Enhancements
- [x] 23a: Tool execution error recovery in `_iterateGenerator()`
- [x] 23b: Processed flag defense-in-depth in `_buildMessages()`
- [x] 23c: WebSocket ping/pong (30s interval)
- [x] Tests: `spec/core/interaction-loop-spec.mjs` additions (~14 tests)
- [x] Tests: `spec/server/transport/websocket-spec.mjs` additions (~4 tests)

## Step 20 — Abilities as DM
- [x] 20a: Model changes (Agent.dmSummary, Session.type + Session.dmAgentID)
- [x] 20b: DmSummarizer (`src/core/dm/dm-summarizer.mjs` + index.mjs)
- [x] 20c: System prompt injection in AgentInterface.getSystemPrompt()
- [x] 20d: Session manager `createSession()` update for type/dmAgentID
- [x] 20e: DM controller + routes
- [x] Tests: `spec/core/dm/dm-summarizer-spec.mjs` (~12 tests)
- [x] Tests: `spec/core/agent-interface-spec.mjs` additions (~4 tests)
- [x] Tests: `spec/core/core-entry-spec.mjs` model additions (~4 tests)
- [x] Tests: `spec/server/routes-spec.mjs` additions (~6 tests)

## Final
- [x] Run full test suite (`npm test`) — all non-DB tests pass (DB tests require Node 22.5+)
- [ ] Git commit
