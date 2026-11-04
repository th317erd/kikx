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
| received (agent fed) | `content.delivery: 'received'`, `content.deliveryAt: <ms>` | shared success treatment (`kikx-frame--status-success`) + `data-delivery` + `aria-label` — no inset, no caption |

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
- `src/client/components/frame-delivery-status.mjs` — **new**, 81 lines at landing, 101 now
  (the success-treatment change in `086a75fb` added the status modifier)
- `src/client/components/kikx-frame-item.mjs` — `applyFrameDelivery(this, frame)`
- `src/client/components/kikx-user-message-frame.mjs` — `_updateDelivery()` (aria/title)
- `src/client/styles/app.css`, `src/client/styles/frame-colors.css` — modifier + token

Specs (5, all new):
- `spec/core/runtime/user-message-delivery-spec.mjs` (11 tests)
- `spec/core/agents/user-message-delivery-wiring-spec.mjs` (3 tests)
- `spec/client/frame-delivery-status-spec.mjs` (11 tests)
- `spec/client/user-message-delivery-dom-spec.mjs` (4 tests)
- `spec/ui/puppeteer/user-message-delivery-puppeteer.mjs` (1 test, real Chromium) — added
  after this record was first written, to close the rendering gap §Known limits described

Specs (2, new — the V7 seam, added after the review that found V7 unproven):
- `spec/server/user-message-delivery-route-spec.mjs` (2 tests) — real HTTP POST through
  `createServer` against the real runtime and store. Deliberately a sibling file rather than
  an extension of `spec/server/create-server-spec.mjs`: that file is 2218 lines against the
  800-line hard cap (which `spec/architecture/source-file-size-spec.mjs` enforces over `src/`
  only, so specs like this one are not scanned), and the unit lane glob `spec/**/*-spec.mjs`
  (`scripts/test-lanes.mjs:14`) picks a sibling up with no registration step. Inclusion was
  verified rather than assumed: the full unit-lane run
  (`.gate/route/unitlane.exit` `UNITLANE_EXIT=0`, 3188 tests / 3158 pass / 0 fail / 30
  skipped) contains both of this spec's test titles exactly once. Matching is by title
  because the default reporter prints no file path for a passing test — a filename grep
  returns nothing even when the spec ran, which is the trap that would have let me claim
  coverage I had not checked.
- `spec/ui/puppeteer/composer-delivery-transition-puppeteer.mjs` (1 test, real Chromium) —
  plan V7 itself: typed composer -> real route -> neutral -> provider fed -> received, all
  asserted on the DOM. Builds the production stack (in-memory AeorDB under the real
  `FrameStore`) and hands it to the fixture, which is why it can reach a state the default
  stagehand fixture cannot. Registered with no registration step, like every sibling: the
  Puppeteer glob (`scripts/test-lanes.mjs:42`) was **24** files when this was measured and is
  **28** at `e329297f`, all calling `fixture.close()`.

## Results (exit codes captured to files, never read through a pipe)

| Check | Exit | Counts |
|---|---|---|
| server spec | 0 | 11 / 11 |
| wiring spec (real `FrameRouter`) | 0 | 3 / 3 |
| client helper spec | 0 | 11 / 11 |
| client DOM spec | 0 | 4 / 4 |
| existing client specs (regression) | 0 | 34 / 34 |
| existing core specs (regression) | 0 | 42 / 42 |
| `documentation-spec` gate | 0 | 6 / 6 |
| `test-lane-coverage-spec` gate (10 tests) + `chat-view-window-spec` | 0 | 16 / 16 |
| delivery Puppeteer spec, real Chromium | 0 | 1 / 1 (2 267 ms) |
| full Puppeteer lane, 22 files incl. it | 0 | 25 / 25 (30 665 ms) |
| route spec, real HTTP route (2 tests) | 0 | 2 / 2 |
| route spec, negative controls A/B/C | 1 / 1 / 1 | red for the intended reason, restored |
| full Puppeteer lane, **23 files**, uncontended | 0 | 26 / 26 (30 210 ms) |
| V7 transition spec, real Chromium (solo) | 0 | 1 / 1 (1 697 ms) |
| V7 transition spec, negative control A: hook disabled | 1 | red for the intended reason — never reaches `received`; 20 000 ms wait exceeded |
| V7 transition spec, negative control B: runtime default flipped to `received` | 1 | red for the intended reason — `actual: 'received'`, `expected: 'neutral'` |
| all 8 delivery specs together, uncontended (`CONCURRENT=0`) | 0 | 34 / 34 |
| full Puppeteer lane, **24 files** incl. the V7 transition spec, uncontended | 0 | 27 / 27 (33 296 ms) |
| same lane re-run on the **shipping** bytes (`19d3edc8`), uncontended | 1 (the known flake — see below) | 26 / 27 (29 553 ms) — sole red is the known `filtered-lazy-scroll` race |

The lane total matters more than the single spec: a green in isolation does not show the
new spec coexists with the other 23. It was first measured RED (24/25) and then green on a
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
5. **The composer spec asserted a literal Chromium never returns.** It compared the
   computed `::after` content to `'normal'`; with no matching rule Chromium reports
   `'none'`, so the assertion was red on **any** tree, feature or not. Both caption rules
   were then scoped to `.kikx-frame--UserMessage.kikx-frame--delivery-received`
   (`app.css:697`, `:701` as the file stood at the time — those rules were deleted by
   `086a75fb`; see "Visual treatment" below), and the three assertions before it
   (neutral, no modifier, `box-shadow: none`)
   all passed — which is how the defect was localised to the assertion rather than the
   product. Fixed by porting the shipped spec's `captionText()` normaliser
   (`user-message-delivery-puppeteer.mjs:133-137`), which maps both `'none'` and `'normal'`
   to `''` and so tightens to "exactly no caption" instead of relaxing to a literal.
   Control: unscoping the caption rule turns it red with `'Received' !== ''`.
6. **The composer spec stranded a browser.** It was the only one of 23 Puppeteer files with
   no `fixture.close()`, so the run never released its handle. Now 23/23 close their
   fixture and the spec exits in ~1.4 s instead of being killed.

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
`MUTANT_GREP_COUNT=0`. That md5 is the plugin blob at `0e44653a`; at `ba4046b3` the same
file is `5b73abd5`, because the merge `1bf5a74c` brought in main-side edits to it. The
control's identity is commit-scoped — compare it against the commit it was run on, not
against today's tip.

## Visual treatment: the inset/caption contract was replaced

Upstream `086a75fb` (*fix(delivery): render received messages with the success frame
treatment*) retired the bespoke visual this record originally described — an accent left
inset plus a `"RECEIVED"` caption — and replaced it with the **shared success treatment**
every other successful frame already uses. This is a shipped behaviour change made by
someone else after this record was written; the present-tense descriptions above have been
corrected to match it, and the paragraphs that describe measurements taken *before* it are
left as measured, with the superseded test title called out where it appears.

What ships now:

- `frameDeliveryModifier()` emits ` kikx-frame--delivery-received kikx-frame--status-success`
  for a received `UserMessage` (`src/client/components/frame-delivery-status.mjs`), so the
  item reports `data-frame-status="success"` like any other successful frame.
- The colour lives in the shared `.kikx-frame--status-success` tokens
  (`src/client/styles/frame-colors.css`), while `.kikx-frame--UserMessage`
  deliberately keeps its blue type/border/body hue. The message body therefore stays
  blue and only the status/striped header corner turns green; there is no edge accent
  and no `::after` caption rule anywhere.
- `src/client/styles/app.css` contains **zero** `delivery` references — the 25 deleted
  lines were the inset and caption rules, and since `8be6c75d` it is a pure `@import` entry,
  so the whole sheet is checked by the `stylesheet-links-spec` gate (15 / 15 green) rather
  than by reading one file. Anything citing `app.css:697`/`:701` for the
  caption is describing the retired visual (that region is now `.kikx-user-message__text`
  and `.kikx-user-message__prompt`, which `8be6c75d` moved into
  `src/client/styles/app-composer.css:242`/`:246`).
- The stored word is unchanged: `content.delivery: 'received'`, never `success`, never
  `content.status`. The client *renders* with the success vocabulary while *storing* on its
  own axis — the separation this record exists to protect is intact.

Re-measured on the shipping bytes (`495e161b`), quiet box:

- Unit half, 5 delivery specs (`frame-delivery-status`, `user-message-delivery-dom`,
  `user-message-delivery-wiring`, `user-message-delivery`, `user-message-delivery-route`):
  `DELIV_UNIT_EXIT=0`, **31 / 31, 0 fail, 0 skipped** (`.gate/sync3/deliv-unit.{log,exit}`,
  pre-state and spec md5s in `.gate/sync3/deliv-unit-pre.txt`).
- Browser half, 3 delivery Puppeteer specs: `DELIV_BROWSER_EXIT=0`, **3 / 3, 0 fail**
  (`.gate/sync3/deliv-browser.{log,exit}`), titles as emitted:
  `a message typed into the real composer renders neutral, not received` (1 737 ms),
  `a typed message flips from neutral to received in the browser when the agent is fed`
  (2 166 ms), `Puppeteer renders received user messages with the shared success treatment`
  (3 071 ms).
- `:3001` serves the new bytes, not a stale process: `frame-delivery-status.mjs`
  200 / 4 522 B / `50fd9d79`, `frame-colors.css` 200 / 15 960 B / `8382adfa` — each equal
  to its disk md5. `app.css` was 200 / 87 083 B / `3299b297` when this was measured;
  `8be6c75d` has since split it into a 15-line `@import` entry (601 B / `5b76a13e`) over ten
  part-files, so that figure is now historical. Re-measured after the split, still equal to
  disk: `app.css` 200 / 601 B / `5b76a13e`, `app-composer.css` 200 / 10 467 B / `2467be61`.

Two record defects this section closes. First, the table row and two prose blocks claimed
the inset/caption visual as current, which stopped being true at `086a75fb`; a record that
describes a retired visual as shipped is the same defect class as the falsified counts
already corrected here. Second, the paragraph describing the transition spec claimed the
accent transition "is waited out" so a mid-flight sample could not pass. The current spec
has no settle wait and asserts colour by inequality, which a mid-flight sample *does*
satisfy — so that reassurance was describing machinery that no longer exists. It is now
stated as the bound it is rather than as a guarantee it is not.

Lane size has also grown twice since: the Puppeteer glob was **27** files at `495e161b` and
is **28** files at `e329297f` (28/28 call `fixture.close()`), not the 24 measured in the
earlier verdicts below. Those counts are left as recorded — they were true of the lane as it
stood then — but they no longer describe the lane's current size.

## Known limits (stated, not laundered)

- **Browser rendering is now measured; end-to-end is NOT.** The earlier version of this
  record said the CSS had never been rendered in a browser. That is no longer true:
  `user-message-delivery-puppeteer.mjs` asserts the shared success class, that the status
  token resolves to the delivery token, that the body/type hue stays blue while the striped
  header changes, that the announced label is present, that there is **no** caption, and that a revert clears
  both the modifier and the success class — in real Chromium. (The inset/caption wording
  this paragraph used before the shared-success treatment landed is superseded; see
  "Visual treatment: the inset/caption contract was replaced" below.)
  It seeds frames and emits `frame.updated` directly, so it exercises the rendering and the
  live event path, not the composer.

- **The typed-in-browser seam is now proven too - the earlier "not provable" claim was
  wrong, and this record says so.** Plan V7 asked for "send a message and watch it go neutral
  then received". It was previously split into two halves with only the server half claimed,
  on the stated ground that the browser half could not be reached "without a fixture whose
  runtime is the real runtime - a harness change, not a spec change". That ground was
  **false**, and the correction is worth recording precisely because the wrong version was
  written down as a limit rather than a guess.

  What was actually true: the *default* stagehand fixture cannot reach `received` - it
  pre-resolves the plugin load and its stub `appendUserMessage` writes no `delivery` key. But
  that is a property of the default configuration, not of the harness.
  `startStagehandUIServer` accepts a caller-supplied `frameRuntime`
  (`stagehand-test-utils.mjs:188`), and `createServer` only constructs its own runtime when the
  context does not already have one (`create-server.mjs:485`). Passing the production stack
  through therefore needed **no harness change at all** - only a spec that builds the stack and
  hands it over, which is what `spec/ui/puppeteer/composer-delivery-transition-puppeteer.mjs`
  now does. The limit was over-stated by one word ("harness" where "default harness" was
  meant), and that one word hid a reachable proof.

  The three halves, each proven at a different seam:

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

  *The browser half is proven by building the stack instead of accepting the default.*
  `spec/ui/puppeteer/composer-delivery-transition-puppeteer.mjs` types into the real composer,
  sends through the real `POST /api/v1/sessions/:id/messages`, and hands the fixture a real
  `FrameStore` (over an in-memory AeorDB), real `FrameRuntime`, real `FrameRouter` and the real
  `AgentRouteFramePlugin` registered explicitly by selector. Only the provider is a double, and
  it stands in for a model, not for the delivery logic - the transition itself is produced by
  production code (`agent-route-frame-plugin.mjs:341` -> `frame-runtime-prompts.mjs:85`).

  Determinism, not sleeping: the runtime appends with `flushRouter: false`, so routing
  continues after the 201 and "neutral" could otherwise be a race the browser wins by luck.
  The spec parks the secrets-carrying `agentManager.getAgent` lookup - the one the plugin makes
  immediately before constructing the provider - behind an explicit gate, asserts the neutral
  DOM state with `providerRuns` still empty, then releases the gate and waits for the DOM to
  reach `received`.

  What it asserts, on the DOM rather than on an exit code: the typed bubble renders
  `data-delivery="neutral"` with no received modifier, no success class, `data-frame-status`
  absent, `box-shadow: none`, no `::after` caption, no bubble `data-delivery` and no
  `aria-label`; the same DOM node (`data-frame-id` identical, `isConnected` true) then
  becomes `received` with the modifier **and** `kikx-frame--status-success` applied,
  `data-frame-status="success"`, `aria-label="Received by the agent"`, still no caption;
  `--kikx-frame-status-color` equals the delivered `--kikx-frame-delivery-color` so a
  hardcoded grey cannot pass; `providerRuns` equals exactly that frame id; and the stored
  frame carries `received` plus a finite `deliveryAt`, so the picture agrees with the server
  state.

  Honest bound on the colour half: the header assertion is an **inequality**
  (`after.headerBackground !== before.headerBackground`) and the body/type assertion is an
  **equality** (`after.background === before.background`) sampled after the spec
  waits for `data-delivery` to become `received`. There is no explicit settle wait in the
  current spec, and a mid-transition sample satisfies an inequality. The token assertion
  (`statusColor === deliveryColor`) is a custom-property read, which CSS transitions do not
  animate, so it is exact. What this cannot claim: that the colour has fully settled at
  assertion time — only that it differs and that the token resolves. The earlier version of
  this record described a settle wait; that machinery is gone with the inset.

  *What a composer spec can honestly prove, and does.*
  `spec/ui/puppeteer/composer-delivery-neutral-puppeteer.mjs` types into the real composer,
  lets the send reach the fixture runtime, and asserts the rendered bubble: explicit
  `data-delivery="neutral"`, no received modifier, `box-shadow: none`, no `::after` caption,
  and no announced "received" label. It also asserts the boundary out loud — that the stored
  frame has **no** `delivery` key in this harness, so the neutral it observes is the client
  default, not a server stamp. That is the honest extent: it pins the display contract for a
  real typed message and nothing more. It remains worth keeping alongside the transition spec:
  it pins the neutral default on the *default* harness, which is the shape every other
  browser spec runs in, so a regression that made the client stop defaulting to neutral would
  be caught there rather than only in the heavier production-stack fixture.

### The lane red, recorded rather than smoothed

The first 22-file lane run after adding the spec was **RED**: 24 pass / 1 fail
(`LANE22_EXIT=1`). The failure was not this feature — the delivery test passed in 5 314 ms.
It was `filtered-lazy-scroll-puppeteer.mjs:55`, "the viewport jumped more than one local
frame group (frame_1196 -> frame_594)", in a spec with zero delivery references, authored by
an earlier unrelated commit.

Attribution, measured not assumed: that spec **passes solo** (exit 0, 5 710 ms) and the
full lane **passes on repeat** (25/25, exit 0) with the same spec still taking 15 301 ms, so
it is an intermittent race inside that spec rather than a cliff this feature pushed it over.

Do **not** over-read the duration. The 15 918 ms red, the 15 301 ms green and the 16 902 ms
red seen in a later 23-file run all happened while **other browser lanes from parallel
sessions were running in this same checkout** (measured: two `node --test
spec/ui/puppeteer/*-puppeteer.mjs` roots plus ~107 live Chrome processes). Timing under that
contention is not a clean measurement of this spec, so "load-insensitive" is not proven —
only "passes solo, passes in-lane on repeat" is. A contended red is not evidence of a
regression and a contended green is not a certificate; the flake stays out of scope either
way. Re-measure on an idle machine before drawing any stronger conclusion.

**That re-measurement has since been done.** With no other test process running —
`concurrent_node_test=0` recorded immediately before the run, alongside `HEAD=ba4046b3`,
`files=23` and the spec md5s (`.gate/node-eng-validate/quietlane-pre.txt`) — the full
23-file lane passed **26 / 26, exit 0, 30 210 ms**
(`.gate/node-eng-validate/quietlane.{log,exit}`, `QUIETLANE_EXIT=0`). `filtered-lazy-scroll`
**passed inside that same quiet lane at 17 139 ms**, and both delivery tests passed in it at
line 11 (composer-neutral, 6 563 ms) and line 51 (accent, never a recolour, 6 166 ms). What
that supports: the reds coincided with contention and the green with a quiet machine, which is
consistent with a load-sensitive race rather than a spec that only passes alone. What it does
**not** support: that the flake is gone. The observed sequence is red (22-file lane), green
(repeat), red again in a 23-file lane, and now green on a quiet machine — a distribution that
still contains reds, so the spec stays recorded as intermittent and out of scope. The quiet
green is one sample, not a fixed flake.

Lane size note: the Puppeteer glob was **24** files at the time of these verdicts, not 22 —
the composer spec and the V7 transition spec below had joined it. All 24 were collected with
no registration step (`scripts/test-lanes.mjs:42`). It is **28** at `e329297f`.

How the 24-file verdict binds to the shipped bytes: two measurements, each hash-bound.

1. `.gate/v7/lane.{log,exit}` — `LANE_EXIT=0`, 27 / 27, 33 296 ms, run with
   `PRE_CONCURRENT_NODE_TEST=0`. `.gate/v7/lane-pre.txt` recorded `PRE_TRANSITION_MD5=3fd59a8e`
   and `PRE_DOC_MD5=9e77af38` before it started, and those are exactly the blobs committed as
   `e8468625`. Inside it the V7 transition spec passed at 9 015 ms, the composer-neutral spec
   at 9 113 ms, the accent spec at 5 045 ms, and `filtered-lazy-scroll` at 17 149 ms.
2. `.gate/coord15/lane3.log` — the same 24 files re-run on the **shipping** bytes. A
   comment-only correction (`stagehand-test-utils.mjs:189` -> `:188`) moved the transition
   spec from `3fd59a8e` to `19d3edc8`, so measurement 1 no longer described what ships.
   `lane3-pre.txt` recorded `PRE_SPEC=19d3edc8`, `PRE_DOC=dacf41d7`, `PRE_FILES=24`,
   `PRE_FIXTURE_CLOSE=24`, `PRE_CONCURRENT_NODE_TEST=0`, with `POST_SPEC=19d3edc8` after.
   Result: 27 tests / 26 pass / 1 fail, and all three delivery tests green — composer-neutral
   8 147 ms, V7 neutral->received 7 416 ms, accent-never-a-recolour 4 931 ms. The single red is
   the same `filtered-lazy-scroll` race (`frame_1196 -> frame_594`), zero delivery references.

Exit code on measurement 2: `.gate/coord15/lane3.exit` holds `LANE3_EXIT=1`, written at the
same instant as the log (11:30:10). `1` is the honest value and it is not a delivery failure —
26 of 27 passed and the one red is the known `filtered-lazy-scroll` race, so the exit encodes
that flake. The run's verdict sidecar (`lane3-verdict.txt`) had recorded `EXIT_MISSING`, but it
was written at 11:29:55, fifteen seconds **before** the lane terminated; the exit file existed by
the time the run finished. This paragraph originally shipped "no `.exit` file" as a standing
limit — that was true of the sidecar's moment, not of the artefact on disk, and is corrected
here. The `26 / 27` figure is still read from the log's own reporter block
(`.gate/coord15/lane3.log`, md5 `390c8b31`), because the exit alone would only say "not all
green".

One reading hazard in `lane3-pre.txt`: it also records `PRE_PUPPETEER=3`, which looks like three
competing browser processes and would contradict "uncontended". It is the `pgrep -f` self-match
already recorded earlier in this file — the count matches the shell and subprocesses whose own
command lines contain the string "puppeteer", not browsers. Measured both ways on this host:
a naive `/proc/*/cmdline` scan for "puppeteer" returns exactly one hit, this session's own
`bash -lc`; filtering on `comm` to exclude shells gives zero. So the lane had
`node --test` count 0 and no browser of its own, and "uncontended" rests on the node-test axis,
not on that stale number.


Corollary worth keeping: a single lane run cannot certify a green for a suite that contains
a known race. One green after one red is evidence of intermittency, not of a clean suite.
- **`kikx-frame-item.mjs` was 822 lines** at the time of this feature, over the 800 hard
  guideline (816 at baseline; the feature commit is +6, measured with `git show --numstat`).
  It is **764 lines now**: `d497ce06` split it, which closes the debt this record carried.
  The line cap **is** gated as of `425a3700` — `spec/architecture/source-file-size-spec.mjs`,
  `HARD_CAP = 800`, currently 1 / 1 green. That gate scans `src/` JavaScript and CSS only, so
  `spec/` files such as the 2218-line `spec/server/create-server-spec.mjs` are not covered by
  it. The earlier wording here ("no gate enforces the line cap") was true when written and is
  no longer true.
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
