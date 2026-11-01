# UserMessage delivery status — implementation record

Date: 2026-11-01
Baseline commit: `8b4e5b35` (`plan(client): user-message delivery status (neutral -> received)`)
Owner authorization: *"let's scope it only to USER messages for now. Continue with implementation please."*

## What shipped

A message the operator types carries a two-valued delivery state.

| State | Stored as | Visible |
|---|---|---|
| neutral (default) | `content.delivery: 'neutral'` | nothing added — the shipped grey bubble is byte-identical |
| received (agent fed) | `content.delivery: 'received'`, `content.deliveryAt: <ms>` | accent left inset + "RECEIVED" caption + `data-delivery` + `aria-label` |

## Why the stored word is `received`, not `success`

`success` is the generic frame-status word meaning "this tool step succeeded"
(`SUCCESS_STATUSES`, `tool-frame-summary.mjs:19`); `complete`/`completed` are members of
`TERMINAL_CONTENT_STATUSES` (`frame-engine.mjs:18-29`), which
`normalizeLifecycleState` reads on every merge and turns into
`state.lifecycle.status = 'closed'` — a durable closure of a frame the person authored.

Both hazards are now *tested*, not just commented:
- `marking delivery does not close the frame lifecycle` — asserts `lifecycle` stays null;
- `the negative control: writing content.status does close the lifecycle` — asserts the
  same fixture writing `content.status = 'complete'` DOES produce
  `{status:'closed', reason:'complete'}`.

The control was inert on first write and had to be fixed: `FrameEngine.merge` silently
skips any input without a `type` (`frame-engine.mjs:71-72`), so the control's partial
frame changed nothing and "passed" while proving the opposite. A guard whose control does
not fire is not evidence.

## Scope: operator-typed messages only

Owner ruling, and it is also the structural answer. `appendFrame` writes transport messages
under their **own registered frame type** (`frame-runtime.mjs:452-466`), so `type ===
'UserMessage'` already means "a person typed this". The stamp is therefore gated on the
frame **type**, in `withDeliveryState()` (`frame-runtime.mjs`), not on `authorType` — the
content builder it wraps serves every frame type, so stamping inside the builder would have
tagged transport frames too. Covered by
`a non-UserMessage frame type is never given a delivery state`.

Hidden `UserMessage` coordination wakes are excluded on both halves
(`supportsFrameDelivery` client-side, `hidden` guard server-side).

## Where the transition happens

`AgentRouteFramePlugin.routeAgent`, immediately before
`for await (runProviderWithRetry(...))` (`agent-route-frame-plugin.mjs:346`) —
**after** the cancellation (`:322`) and steering (`:328`) guards, because those return
before any provider call, so a message that hits them was never fed. Wrapped in `try/catch`:
a display concern must never fail a real turn.

## Files

Production (6):
- `src/core/runtime/frame-runtime.mjs` — `withDeliveryState()` + call site
- `src/core/runtime/frame-runtime-prompts.mjs` — `markFrameDelivered()` (uncommitted from the
  earlier interrupted attempt; verified working by spec, not assumed)
- `src/core/agents/agent-route-frame-plugin.mjs` — the hook
- `src/client/components/frame-delivery-status.mjs` — **new**, 76 lines
- `src/client/components/kikx-frame-item.mjs` — `applyFrameDelivery(this, frame)`
- `src/client/components/kikx-user-message-frame.mjs` — `_updateDelivery()` (aria/title)
- `src/client/styles/app.css`, `src/client/styles/frame-colors.css` — modifier + token

Specs (4, all new):
- `spec/core/runtime/user-message-delivery-spec.mjs` (11 tests)
- `spec/core/agents/user-message-delivery-wiring-spec.mjs` (3 tests)
- `spec/client/frame-delivery-status-spec.mjs` (6 tests)
- `spec/client/user-message-delivery-dom-spec.mjs` (4 tests)

## Results (exit codes captured to files, never read through a pipe)

| Check | Exit | Counts |
|---|---|---|
| server spec | 0 | 11 / 11 |
| wiring spec (real `FrameRouter`) | 0 | 3 / 3 |
| client helper spec | 0 | 6 / 6 |
| client DOM spec | 0 | 4 / 4 |
| existing client specs (regression) | 0 | 34 / 34 |
| existing core specs (regression) | 0 | 42 / 42 |
| `documentation-spec` gate | 0 | 6 / 6 |
| `test-lane-coverage-spec` gate | 0 | 10 / 10 |

### Spec defects found and fixed while proving (recorded, not hidden)

1. **The lifecycle negative control was inert.** `FrameEngine.merge` silently skips
   any input without a `type` (`frame-engine.mjs:71-72`), so the control's partial
   frame changed nothing and "passed" while proving the opposite of its claim. Fixed
   with a full frame; the control now asserts `{status:'closed', reason:'complete'}`
   and fails if it does not see it.
2. **A hand-rolled fake element lied.** It modelled `dataset` as a plain object while
   `removeAttribute()` touched a separate map. `mini-dom` reflects `dataset` as a live
   Proxy over `data-*` (mini-dom.mjs:160-177). Replaced the stub with real `mini-dom`
   elements — the third stub-fidelity problem in this session, which is why the tests
   now use the real thing.
3. `appendUserMessage` returns an envelope `{session, frame, commit, wakePending}`
   (`frame-runtime.mjs:611-620`), not a bare frame. Two assertions were reading the
   envelope.
4. The wiring harness mints its own session id; hardcoding `ses_1` produced a 404.

None of these changed production code. Each was a test that could not have seen the
thing it claimed to check.

### Scope correction made during implementation

The first attempt stamped `delivery` inside `buildUserMessageContent`, which serves
**every** appended frame type — that would have tagged transport-authored messages too,
against the owner's "USER messages only" ruling. Moved to `withDeliveryState()`, gated on
`type === 'UserMessage'`. Tested by
`a non-UserMessage frame type is never given a delivery state`.

### Negative control on the hook

Mutated `agent-route-frame-plugin.mjs` to skip `markFrameDelivered` behind an env flag,
ran the wiring spec: **`NEGCTL_EXIT=1`**, the "provider is fed" assertion failed, the two
never-fed tests still passed. So the green is the hook working, not the test being blind.
Restored: before/after md5 both `98dc7209382ecdb7633237a721a72394`, `RESTORED=yes`,
`MUTANT_GREP_COUNT=0`.

## Known limits (stated, not laundered)

- **No browser measurement.** The DOM proof is `mini-dom`, not a real page. The CSS
  (accent inset, `::after` caption) has never been rendered in a browser; only the class
  and attribute that trigger it are proven.
- **No end-to-end live run.** Nothing here proves the transition against a real provider
  over the real event gateway; the wiring spec uses a recording provider through the real
  router.
- **`kikx-frame-item.mjs` is 824 lines**, over the 800 hard guideline before this change
  (816 at baseline). My delta is +8. Splitting it is a separate, unauthorized refactor.
- Retry ladder: marking is idempotent (asserted — second call writes no new commit), so a
  retry cannot produce a second `frame.updated`. Not tested against a real retrying
  provider.
- Delivery is one-way. There is no `failure` state; a message that is never fed simply
  stays `neutral`, which is truthful but does not distinguish "queued" from "dropped".

## Not done, deliberately

- No `failure`/`error` delivery state (owner asked for two states).
- No backfill: historical messages stay `neutral`.
- `recordModelPrompt`'s dead-in-production status left untouched.
- Nothing committed or pushed (standing rule for this role).
