# UserMessage delivery status — implementation record

Date: 2026-11-01
Baseline commit: `8b4e5b35` (`plan(client): user-message delivery status (neutral -> received)`)
Owner authorization: *"let's scope it only to USER messages for now. Continue with implementation please."*

Landed as `0e44653a` (feature) and `6e1209a4` (this record indexed); pushed to `origin/main`.

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
- `spec/ui/puppeteer/user-message-delivery-puppeteer.mjs` (1 test, real Chromium) — added
  after this record was first written, to close the rendering gap §Known limits described

Specs (1, new — route seam, added after the review that found V7 unproven):
- `spec/server/user-message-delivery-route-spec.mjs` (2 tests) — real HTTP POST through
  `createServer` against the real runtime and store. Deliberately a sibling file rather than
  an extension of `spec/server/create-server-spec.mjs`: that file is already 2218 lines
  against an 800-line hard guideline, and the unit lane glob `spec/**/*-spec.mjs`
  (`scripts/test-lanes.mjs:14`) picks a sibling up with no registration step. Inclusion was
  verified rather than assumed: the full unit-lane run
  (`.gate/route/unitlane.exit` `UNITLANE_EXIT=0`, 3188 tests / 3158 pass / 0 fail / 30
  skipped) contains both of this spec's test titles exactly once. Matching is by title
  because the default reporter prints no file path for a passing test — a filename grep
  returns nothing even when the spec ran, which is the trap that would have let me claim
  coverage I had not checked.

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
| `test-lane-coverage-spec` gate | 0 | 16 / 16 |
| delivery Puppeteer spec, real Chromium | 0 | 1 / 1 (2 267 ms) |
| full Puppeteer lane, 22 files incl. it | 0 | 25 / 25 (30 665 ms) |
| route spec, real HTTP route (2 tests) | 0 | 2 / 2 |
| route spec, negative controls A/B/C | 1 / 1 / 1 | red for the intended reason, restored |

The lane total matters more than the single spec: a green in isolation does not show the
new spec coexists with the other 21. It was first measured RED (24/25) and then green on a
repeat run — see §The lane red, below. That is written down because the red was real.

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

- **Browser rendering is now measured; end-to-end is NOT.** The earlier version of this
  record said the CSS had never been rendered in a browser. That is no longer true:
  `user-message-delivery-puppeteer.mjs` asserts the computed inset, that it resolves to the
  delivery token, the `::after` caption text, the announced label, and that the accent
  settles back to `none` on revert — in real Chromium.
  It seeds frames and emits `frame.updated` directly, so it exercises the rendering and the
  live event path, not the composer.

- **The route seam is now proven; the typed-in-browser seam is not, and is not provable on
  the current harness.** Plan V7 asked for "send a message and watch it go neutral then
  received". That sentence is now split into the two halves it always contained, and only
  the honest half is claimed:

  *The server half is proven.* `spec/server/user-message-delivery-route-spec.mjs` POSTs to
  the real `/api/v1/sessions/:id/messages` through the real `createServer`, the real
  `FrameRuntime` and the real `FrameStore`, and asserts on the frame the runtime stored —
  not on the response body, which a bug could stamp differently from what it saved. Stored
  `content.delivery === 'neutral'` with **no `deliveryAt` key at all** (asserted with
  `Object.hasOwn`, so `null` and `0` would both fail), then `received` with a finite
  `deliveryAt` once the provider is actually fed. "Before the provider is fed" is a held
  state rather than a race: the harness parks the first `await` inside `routeAgent`
  (`agentManager.getAgent`) behind a gate, releases it, and awaits `router.flush()`, so the
  transition is causally ordered. No timers, no retry loops.

  *The browser half is not.* `startStagehandUIServer` pre-resolves the plugin load
  (`stagehand-test-utils.mjs:208` `pluginLoadPromise: Promise.resolve()`), so
  `agent-route-frame-plugin.mjs` never loads, and the stub `appendUserMessage`
  (`stagehand-test-utils.mjs:444`) hand-builds `content: { text }` with no `delivery` key.
  No provider is ever fed in that harness, so nothing could legitimately write `received`.
  A composer-driven Puppeteer assertion would therefore be testing a stub, and re-implementing
  the transition inside the stub to make it pass would be the same class of defect as the
  fake-`dataset` element already recorded above. It is left unwritten on purpose. Closing it
  needs a fixture whose runtime is the real runtime — a harness change, not a spec change.

### The lane red, recorded rather than smoothed

The first 22-file lane run after adding the spec was **RED**: 24 pass / 1 fail
(`LANE22_EXIT=1`). The failure was not this feature — the delivery test passed in 5 314 ms.
It was `filtered-lazy-scroll-puppeteer.mjs:55`, "the viewport jumped more than one local
frame group (frame_1196 -> frame_594)", in a spec with zero delivery references, authored by
an earlier unrelated commit.

Attribution, measured not assumed: that spec **passes solo** (exit 0, 5 710 ms), and the
full lane **passes on repeat** (25/25, exit 0) with that same spec still taking 15 301 ms —
slower than the 15 918 ms red run and green anyway. So it is duration-independent and
load-insensitive in this band: it is an intermittent race in that spec, not a cliff this
feature pushed it over. It is a pre-existing flake and is left unfixed here rather than
folded into this changelog.

Corollary worth keeping: a single lane run cannot certify a green for a suite that contains
a known race. One green after one red is evidence of intermittency, not of a clean suite.
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
- The `filtered-lazy-scroll` intermittent above, deliberately out of scope.
