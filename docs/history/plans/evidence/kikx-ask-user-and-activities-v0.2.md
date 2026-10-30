# DoD evidence — `ask-user` / Questions / Activities plan (v0.2)

> **Historical planning evidence.** This captures the repository state inspected on 2026-10-17, before later implementation work. Paths, line numbers, and “no implementation” claims are not current guidance.

Purpose: record the truth/proof artifacts behind plan v0.2 so a stranger can trace every claim to
an inspected file/line and re-run the checks. This is a *planning* artifact; no implementation
exists (verified below).

Baseline inspected this revision (2026-10-17):
- Repo: `/home/wyatt/Projects/kikx-workspace/kikx2` @ `d685ebd`; working tree dirt:
  [`kikx-ask-user-and-activities.md`](../historical/kikx-ask-user-and-activities.md)
  (the associated plan) and the owner-owned
  [`2026-10-14 database migration report`](../../migrations/2026-10-14-database-port-5434.md).
- Dev server: `curl http://127.0.0.1:3001/health` ->
  `{"ok":true,"ready":true,"services":{"database":true},"memory":{"enabled":false,...}}`.

## 1. No existing implementation (claim: this is a greenfield feature)

Command: `grep -rln 'ask-user|askUser|questionID|question-routes|QuestionsStore|questions-store' src spec`
Result: **no matches** -> no `ask-user-tool.mjs`, no `question-routes.mjs`, no `QuestionsStore`.

## 2. Code contracts the plan depends on (file:line, inspected)

| Claim | Evidence |
| --- | --- |
| Todo store is one doc per agent under `/kikx/agents/<id>/todo.json` | `src/core/agents/agent-todo-store.mjs` `todoPath()` |
| Per-turn `todoState` injection point | `src/core/agents/agent-route-frame-plugin.mjs:204` (load), `:224` (`runParams.todoState`) |
| Brief renders todo count | `src/core/plugins/agent-brief-template.mjs:246` (`resolveBriefTodo`, `context.todoState?.items`) |
| Single-target wake bypass | `src/core/agents/agent-route/targeting.mjs` `resolveRouteTargets()` returns `[targetAgentID]` when it is a participant |
| `appendUserMessage` does NOT set `targetAgentID` | `src/core/runtime/frame-runtime.mjs:301` — builds frame from `recipients`, no `targetAgentID` |
| `appendUserMessage` cancels autonomous wakes (live steer) | `src/core/runtime/frame-runtime.mjs:309` -> `cancelAutonomousWakes` in `src/core/runtime/frame-runtime-sessions.mjs:24` |
| `cancelAutonomousWakes` only cancels autonomous kinds | `frame-runtime-sessions.mjs:24` filters `isAutonomousContinuation` |
| `user-answer` must NOT be autonomous | `src/core/runtime/autonomous-chain.mjs:14` `AUTONOMOUS_CONTINUATION_KINDS = ['exec-wake-on-completion','send','agent-respond-and-continue']` |
| AeorDB has `list`/`entries` (rebuildable index) | `src/core/aeordb/aeordb-connection.mjs:133` (`list`), `:155` (`entries`); `aeordb-client.mjs:86` `listDirectory` |
| AeorDB has NO conditional write | `src/core/aeordb/aeordb-client.mjs` methods: `getFile/putFile/patchFile/deleteFile/queryFiles/searchFiles/listDirectory` — no `If-Match`/etag |
| Reference contract is `{type,id}` only, no enum | `src/core/tools/tool-execution-service.mjs:387` `resolveToolReferences`, `:407` `normalizeToolReferences`; precedent `src/core/tools/session-tools.mjs:260` |
| Runtime event emit channel | `src/core/runtime/frame-runtime.mjs:419` `emitRuntimeEvent` |
| Client SSE event types (no replay) | `src/client/components/runtime-events-connection.mjs:18` `RUNTIME_EVENT_TYPES` = connected, heartbeat, session.saved, frame.added/updated/phantom, commit, tokens.updated |
| Frame component registration is a plain array | `src/core/tools/register-built-in-tools.mjs:103` `BUILT_IN_FRAME_COMPONENTS`; `todo-get` in `BUILT_IN_TOOLS` at `:93` |
| Plugin base class | `src/core/plugins/plugin-interface.mjs:8`; `referencesFor()` at `:19` |
| Deferral guard the prompt must not trip | `src/core/plugins/agent-tool-definitions.mjs:174` `AVOIDABLE_DEFERRAL_PATTERNS`; enforced `agent-loop-state.mjs:179` |
| Sidebar baseline | `src/client/components/kikx-shell-builders.mjs:206` `buildRunnerShell`, `:214` `h2('Workspace')` |
| Session list page cap 50 | `src/server/routes/session-routes.mjs` GET `/api/v1/sessions` `parsePositiveInteger(..., 50)` |

## 3. File-size hotspots (debt quantification)

`wc -l`: `src/core/tools/session-tools.mjs` = **798** (hard limit 800 — do not append);
`src/client/components/kikx-shell-builders.mjs` = **520** (soft limit 500 — new work in new files);
`src/core/tools/register-built-in-tools.mjs` = 137; `src/core/plugins/agent-brief-template.mjs` = 282.
Project limits (`AGENTS.md`): 500 soft / 800 hard.

## 4. Decisions resolved with evidence (v0.2)

- **D-6 ->** per-status open-index doc + per-agent mirror (rebuildable via `list`); route cache
  rejected (no conditional write, single-process, not rebuildable). Plan §3.2.
- **D-7 ->** questions do NOT appear in a todo panel. Evidence: the only todo surfaces are tool
  renderers (`src/client/components/tool-renderers/todo-summary.mjs`, `tool-use-base.mjs`,
  `built-in-tool-uses.mjs`); there is no standalone todo panel to extend. Plan §3.3.
- **D-9 ->** one wake per answered question keyed on `questionID`, carrying group context;
  per-group rejected (needs an unbuilt round-completion predicate; can withhold a partial answer).
  Plan §5.3.

## 5. Adversarial-review findings (plan §13)

Chief risk: `appendUserMessage` does not carry `targetAgentID` (`frame-runtime.mjs:301`) — the
targeted wake needs a small contract extension; this is the most likely silent failure. Secondary:
TOCTOU on concurrent answers (no conditional write in AeorDB -> per-id mutex); event replay gap
(client must fetch-on-connect); `AUTONOMOUS_CONTINUATION_KINDS` coupling needs a regression test.

## 6. Test runner (for §16 executability)

`package.json` `test` = `timeout 120 node --test --test-timeout=30000 'spec/**/*-spec.mjs'`
(Node test runner, not mocha). A single spec runs as
`node --test --test-timeout=30000 spec/core/questions/question-store-spec.mjs`.

## 7. Limitations / remaining work

- The prod bot's `kikx-ask-user-and-activities.zav-draft.md` is still outstanding; this joint merge
  is pending. No prod-side review has occurred.
- S1–S5 stability commits (`b54cd80`, `079cce4`, `ec3bd2f`) are landed but not independently reviewed
  and not shipped to prod; S3/S4/S5 review pass open.
- No implementation started; owner authorization required before P1.
