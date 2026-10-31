---
title: Browser-lane decision
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
---
# Browser test lane: which one to keep

**Date:** 2026-10-30
**Question (owner):** "Let's please use only one... whichever works the best for tests (Puppeteer or Stagehand)"
**Recommendation:** **Playwright** as the sole long-term lane. Do **not** delete Puppeteer yet — port its 16 unique specs first. Drop Stagehand.

---

## 1. Measured state, all three lanes, same host, same HEAD

| Lane | Specs | Tests | Deps | Runs here? | Latest result |
|---|---|---|---|---|---|
| `ui:playwright` | 13 | 18 | `playwright` only | **Yes** | **18/18 pass, EXIT=0** (5 of 6 full-lane runs on disk); 17/18 once, pre-merge |
| `ui:puppeteer` | 17 | 20 | `puppeteer-core` only | **Yes** | **20/20 pass, EXIT=0 in all 14 full-lane run results on disk** — 4 pre-commit (§7.1 plus `.gate/te4/lane-full.log`), 2/2 at committed `379bac1c` (`.gate/v18/`), 1/1 at committed `4b2e5dff` (`.gate/v22/lane.exit`), and 7 more lanes postdating the red below (`.gate/v33`, `.gate/te16coord`, all of `.gate/te17`, and te12's own lanes 2 and 3); **a 3-way concurrent triple at `a205609f` was 2/3** (`.gate/te12/head-lane{1,2,3}.log`: pass 20 / fail 0, pass 20 / fail 0, pass 19 / fail 1), the single red being `commit-runtime-event-puppeteer.mjs:65` — a 10 s boot `waitForSelector` — which passes solo in 2.3 s (`.gate/v28/commit-solo1.log`); `frame-window` itself passed in all three lanes at 34.2/34.3/34.6 s — after `frame-window` was rewritten to remove the eager-preload race; the rewritten spec alone is also 3/3 green at the committed bytes `a40bd6bf` and 3/3 again at `4b2e5dff` (`.gate/v21/post.{1,2,3}.log`). Before that rewrite the same lane was 4/6 green, 2 red (19/20); a second matched-load 3-way triple at `a330fbfe` was **3/3 with the same wall profile** (37309/37067/37234 ms vs te12's 37205/35827/37602 ms), so the red is non-reproduced under matched load rather than cleared (§7) |
| `ui:stagehand` | 26 | 28 | `@browserbasehq/stagehand` | **No** | **28/28 fail, EXIT=1** (fresh run at `9e9ec60d`; AeorDB `:6830` refused) |

Import counts are exclusive — `grep -ho "from '...'"` yields exactly one browser
package per lane (`playwright`, `puppeteer-core`, `@browserbasehq/stagehand`), so
there is no hidden cross-dependency between them.

### Why Stagehand is disqualified on evidence, not preference

**Measured, not assumed.** A full-lane run of `ui:stagehand` at `9e9ec60d`
(`node scripts/run-test-lanes.mjs ui:stagehand`, `.gate/v6/stagehand-empty.log`)
reports `tests 28 / pass 0 / fail 28 / skipped 0` and `LANES_EXIT=1`. All 28 die on
`AeorDBError: AeorDB request failed: fetch failed` / `ECONNREFUSED 127.0.0.1:6830`,
raised at `spec/ui/stagehand/stagehand-test-utils.mjs:52` (`exchangeAPIKey`) reached
via `:33` (`loadStagehandOpenAIAPIKey`). Not one test has ever passed here.

**Correction to an earlier version of this report.** It claimed "every spec skips and
the lane exits 0 having asserted nothing". That is false on this host, and the
mechanism explains why: the guard only takes its `t.skip` branch when *neither* a
Chrome binary nor any key is available. `findChromeExecutable()` resolves
`/opt/google/chrome/chrome`, and `AEORDB_ROOT_KEY` is present in `.env.dev`, so the
key path is entered, the `:6830` exchange throws, and the spec fails rather than
skipping. The `skipped 0` counter in the log is the proof that no skip branch ran.
"Silent zero-test pass" describes a host with no Chrome *and* no root key; it is not
what this host does.

**The EMPTY guard is real but unexercised.** `4b55c74e` added it to
`scripts/run-test-lanes.mjs` (`executed = tests - skipped - failed`; any lane with
`executed === 0` sets `LANES_EXIT=1`). The code is correct and it is the right
behaviour, but `spec/scripts/test-lane-coverage-spec.mjs` asserts nothing about it
(`grep EMPTY` returns no hits) and no run on this host has ever entered that branch.
Treat it as untested rather than proven.

**What disqualifies Stagehand is simpler and unchanged:** it needs a paid
`OPENAI_API_KEY` plus a live AeorDB on `:6830`, neither is present, and it has
never produced a single passing test on this machine. Zero passing tests in a lane's
history is enough to keep it out of the gate.

## 2. The two viable lanes barely overlap

Exactly **one** file stem is common to both lanes: `thinking-rack`. The globs are
disjoint (`*-playwright.mjs` vs `*-puppeteer.mjs`). `npm test` now runs
`scripts/run-test-lanes.mjs` with no lane argument (`4b55c74e`), so it takes
`DEFAULT_LANE_NAMES` = `unit` + `ui:playwright`: Playwright is inside the default
gate, Puppeteer and Stagehand remain outside it.
The overlap is a name, not a spec: **zero test titles are shared**
(`comm -12` over the two title lists is empty), and the two `thinking-rack` files
assert different things. Treat the stem count as a floor on duplication, not a
measure of it — differently named tests can still overlap.

- Playwright-only: 12 specs — `aeor-framework`, `agent-view`, `answer-feedback`,
  `emoji-picker`, `emoji-picker-keys`, `inbox-draft-preservation`,
  `inbox-frame-visual-parity`, `inbox-question`, `plugin-main-app`,
  `plugin-view-focus`, `team-manager`, `thread-scrollview`
- Puppeteer-only: 16 specs — `agent-progress-full-text`, `commit-runtime-event`,
  `composer-state-preservation`, `coordination-wake`, `deleted-sessions`,
  `empty-thread-recovery`, `frame-bottom-scroll`, `frame-filter-popup`,
  `frame-window`, `hidden-frame-filter`, `mention-message`, `mobile-layout`,
  `raw-markdown`, `todo-card-load`, `tool-output-overflow`, `user-message-markdown`

**This is why "just delete the lane you like less" is the wrong move.** Choosing
Playwright and deleting Puppeteer today would drop 16 specs — thread rendering,
frame windowing, mobile layout, tool cards, markdown — to zero coverage. The
recommendation is therefore *port, then remove*, not *switch*.

## 3. Why Playwright wins the port target

- **18 tests today vs 20, but a narrower failure surface.** Playwright's 18 tests
  were green in 5 of the 6 full-lane runs recorded on disk; the single red run
  failed one spec (`aeor-framework`, see §6). That red run finished 16:13:36,
  **before** the origin merge was committed here at 16:21:13 (`.gate/zav-pl-head.log`
  vs `git log 5910fc4f`), so it describes a tree this branch no longer has. The
  three post-merge runs are green. Puppeteer was red in **every** full run for the
  whole of this session until its specs were repaired, going 13/18 → 20/20.
- **One dependency, and removing the lane would not remove the others.**
  Playwright bundles its own browser. Puppeteer's *lane* imports only
  `puppeteer-core` and needs a system Chrome at `/opt/google/chrome/chrome`
  (`findChromeExecutable()` reads `KIKX_STAGEHAND_CHROME_PATH`, `CHROME_PATH`, then
  system paths — `CHROME_BIN` is inert), so it breaks on any host without Chrome
  and every spec `t.skip()`s. Playwright here still drives system Chrome, so this
  is a smaller advantage than it first appears: **both lanes skip when Chrome is
  absent.** Note also that `puppeteer-extra` and `puppeteer-extra-plugin-stealth`
  are declared dependencies imported by **production** code
  (`src/core/tools/puppeteer-browser-service.mjs:4-5`), not by this lane, so
  deleting the Puppeteer *specs* would not drop them from `package.json`.

- **But two Playwright specs hard-depend on a sibling checkout, and no Puppeteer
  spec does.** This cuts the other way and was missing from an earlier draft of
  this section. `aeor-framework-playwright.mjs:98` asserts the aeor-web-components
  checkout exists (`AEOR_WEB_COMPONENTS_DIR`, default `~/Projects/aeor-web-components`),
  and `inbox-frame-visual-parity-playwright.mjs:286` asserts the vendored
  stylesheets are present. Both `assert`, so on a host without that checkout they
  **fail** rather than skip — Playwright is 2 of 13 specs less portable than its
  "bundles its own browser" story implies. The one Puppeteer file that names the
  path (`frame-window-puppeteer.mjs:14`) mentions it only in a comment explaining
  why that spec reads constants from source; it has no runtime dependency. This
  does not flip the recommendation — 11 of 13 Playwright specs are self-contained,
  and the two that are not are testing framework and vendoring concerns that
  legitimately need a real browser — but Playwright's portability advantage is
  narrower than the bullet above states, and a host without the checkout would
  turn the lane red for reasons unrelated to `kikx`.
- Playwright's auto-waiting assertions are structurally less prone to the failure
  class that dominated this triage (§4).
- Already the default in `npm test` (`DEFAULT_LANE_NAMES = ['unit','ui:playwright']`).
- **Fairness note:** Playwright's specs mostly assert visibility, text and
  navigation. Ten of Puppeteer's 17 specs assert computed style or geometry
  (`getComputedStyle`, `getBoundingClientRect`), which is why Puppeteer absorbed
  almost all the breakage. That is a difference in what the lanes *test*, not proof
  that one tool is better. Both drive the same Chrome 155.

## 4. The failure class — one disease, in both lanes

Every failure triaged this session was **the spec acted before the product's
asynchronous path completed**, or asserted a value the product no longer produces.

| Spec | Real cause | Evidence |
|---|---|---|
| `agent-progress-full-text` | asserted `rgb()` strings against `oklch()`+`color-mix()`, which Chrome 155 serialises as `color(srgb …)`; and asserted a lilac paint the mood band overrides | negative control forced `frameMoodBand` → `''`, went red |
| `frame-window` | hard-coded `<= 80` from `24b0065e`; the cap is now 120 | `git log -S` on the literal |
| `tool-output-overflow` | measured a `display:none` subtree (`clientWidth 0`, `scrollWidth 0`), so `0 > 0` could never hold | before/after reveal: 836 vs 2043 |
| `todo-card-load` | dispatched its reveal against an empty NodeList before mount | 15013 ms → 6 ms with a mount wait |
| `frame-bottom-scroll` | measured `scrollHeight - scrollTop - clientHeight` in the same tick as the rAF-eased `_scrollFramesToBottom` | 400 ms wait flipped it green |
| `commit-runtime-event` | scrolled with a synthetic `new Event('scroll')`, which the product **cannot** distinguish from its own programmatic placement | see §5 |

## 5. `commit-runtime-event`: a product-honest explanation

`onFrameListScroll()` (`src/client/components/kikx-frame-scroll.mjs:789-791`):

```js
let programmatic = Date.now() < (app._ignoreFrameScrollUntil || 0);
```

When `programmatic` is true, the handler skips the entire break-the-pin branch. The
window is opened by an initial bottom placement (`:171`, `+1000 ms`) and refreshed
on every step of the bottom-follow loop (`:691`, `:721`, `+220 ms`).

A synthetic `new Event('scroll')` sets neither `_ignoreFrameScrollUntil = 0` nor
`_frameListUserGestureUntil`; only real input does
(`_onFrameListUserInterrupt`: `wheel` / `touchmove` / `keydown`, `:551-580`).
So a fake scroll during that window is discarded and the viewport is re-placed at
the bottom.

**This is not a user-facing bug.** Measured three ways in one browser:

| Trial | What happened | scrollTop after 500 ms |
|---|---|---|
| A: synthetic event, immediately after connect | yanked back to bottom in 50 ms | 3196 (bottom) |
| B: **real wheel**, same instant | **held** — ignore window cleared to 0 | 1996 |
| C: synthetic event after 1500 ms settle | stays at top | **0** |

A human scrolling up is respected (B). The old spec was measuring its own fake
input (A). Fixed by scrolling with `page.mouse.wheel()` and waiting for arrival,
which is also what a user actually does.

## 6. `aeor-framework`: one known intermittent, in a sibling repo

`.gate/zav-pl-head.log` records `ZAV_PL_HEAD_EXIT=1` — Playwright 17/18 — with:

```
AssertionError: component regressions failed: Error: updatePage did not apply
the changed item
  at assert (test/behaviour/scrollview.mjs:8:25)
```

**Correction to an earlier draft of this report:** Playwright has *not* "never been
red on this host". It was red once, on this spec.

What the failure actually is:

- The check lives in a **different repo**, `/home/wyatt/Projects/aeor-web-components`
  (override: `AEOR_WEB_COMPONENTS_DIR`). `kikx2` serves it over a throwaway HTTP
  port and drives it with `playwright`. Nothing under `kikx2/test/` is involved,
  which is why grepping this checkout for the file returns nothing.
- `updatePage()` (`components/aeor-scrollview.js:293-309`) ends in
  `this._scheduleRender()` — rendering is **deferred** — while the framework's own
  test asserts `textContent.includes('updated')` after a bare `await wait(0)`.
  That is the same class of race as §4, now inside the framework's suite.
- Reproduced rate: **1 red in ~6 full runs**. Five consecutive isolated runs of
  just this spec were 5/5 green (`.gate/det-aeor-1..5.log`), so it needs a loaded
  box to surface, not an isolated one. 47 stale Chrome processes were resident on
  this host during the red run.
- Framework `src/` and `test/` trees were **clean** at the time — this is committed
  framework code, not a dirty working tree.

So: real, intermittent, and **not fixable from inside `kikx2`**. The honest options
are to raise the framework's wait to a `waitFor`-style poll, or to accept and track
it. Either way it is upstream of this repo.

## 7. What is proven vs not

**Proven**
- Playwright 18/18 EXIT=0 and Puppeteer 20/20 EXIT=0 at HEAD `8722b4e1`,
  sequentially, no Chrome contention. The Puppeteer half was re-measured
  after the `frame-window` rewrite landed: **2/2 concurrent full-lane runs,
  20/20 each, `LANE_1=0` / `LANE_2=0`, at committed HEAD `379bac1c`**, clean
  tree, no other lane running (`.gate/v18/lane-{1,2}.log`, `lane.exit`).
  Playwright was not re-run at `379bac1c`; its last measured full-lane greens
  are `18/18 EXIT=0`, 3× post-merge (see below). Re-measured since, so this is no
  longer an inference from an unchanged `src/`: **`PW_LANE_EXIT=0`, `tests 18 / pass 18 /
  fail 0 / skipped 0`, zero `✖`, 9.7 s at HEAD `5ef7e0a4`** (`.gate/v36/pw-lane.log`,
  `.gate/v36/pw-lane.exit`), run directly rather than through
  `scripts/with-aeordb-token.mjs`. That is one more green run, not a soak.
- **Historical: `frame-window` WAS intermittently red under the lane's default
  concurrency — 2 red in 6 runs, not "red".** *This bullet records a flake that
  has since been fixed at the source; see §7.1 for the current state and the
  post-fix runs. Do not quote it as the lane's present behaviour.* All six runs at
  HEAD `d2598f42`, clean tree, no other lane running;
  `git diff 6c923a3f..d2598f42 -- src/` is empty, so this was not a merge
  regression:

  | run | mode | result |
  | --- | --- | --- |
  | `.gate/v8/pp.log` (16:51) | concurrent (default) | `EXIT=1`, 19/20 |
  | `.gate/v10/pp.log` (16:54) | concurrent (default) | `EXIT=1`, 19/20 |
  | `.gate/v15/pp.log` | concurrent (default) | `EXIT=0`, 20/20 |
  | `.gate/v15/pp-{2,3,4}.log` | concurrent (default) | `EXIT=0`, 20/20 each |
  | `.gate/v11/pp-serial.exit` | `--test-concurrency=1` | `EXIT=0`, 20/20 |

  **An earlier revision of this section claimed "Puppeteer is green only when the
  lane is serialised". That was wrong** and is retracted: four consecutive
  concurrent runs were green. The failure was a race, not a serialisation
  requirement, and it must not be quoted as a deterministic red. §7.1 then
  removed the race itself, so neither reading applies to the lane as it stands.

  The failing assertion is `rendered window is bounded by the page cap (140 <= 120)`
  at `frame-window-puppeteer.mjs:109:12`. The tell is duration: the red at
  `.gate/v8` failed in 7915 ms while the green at `.gate/v15` passed in 8195 ms —
  near-identical elapsed, opposite verdict. Mechanism, sampled in a real browser
  (`.gate/v12/probe.log`, 9 samples): <=300 ms after `window_msg_139` appears the
  DOM holds **20** items with `windowStart 120` and page 0 unloaded; from ~550 ms
  on it stably holds **140** with `windowStart 0` and page 0 loaded (120 + 20
  items). The spec samples at a fixed `delay(300)`, which straddles that transition.

- **Historical — the old assertion before the `f9ae9d05` rewrite.** It was
  semantically wrong, which is why it both raced and could not catch a cap
  regression; §7.1 records the replacement. The spec conflated two constants that
  merely share the value 120:
  - `kikx-chat-view.mjs:474` — `pageSize: MAX_RENDERED_FRAMES` handed to
    `KikxChatScrollView`, but on the **shared** path that is *not* the page size:
    `createKikxPageContext` (`kikx-chat-scrollview.mjs:27`) hard-codes
    `pageSize: PAGE_SIZE`, and `_mountPagedSource` (`:94`) prefers
    `this.pageContext.pageSize || this.pageSize`. So `MAX_RENDERED_FRAMES` never
    reaches the page source; it only sets `this.pageSize`, the divisor that
    turns a page index into `windowStart`.
  - `kikx-chat-view.mjs:359-360` — `_resolveWindow`'s default `maxRendered`,
    reached only on the **legacy** path that `_canUseShared()` (`:411-415`) bypasses.
    The header comment at `:12-15` ("only a recent window is kept in the DOM")
    describes that legacy path.

  Arithmetic: `FRAME_COUNT` 140 with `PAGE_SIZE` 120 is **two** pages, so a fully
  loaded thread is 140 items and `count <= 120` is false *by construction*. The
  assertion therefore measures "has page 0 finished loading yet" — exactly what the
  fixed `delay(300)` was racing. It is also why the `120 -> 800` mutation survived
  the old spec (§ "A surviving mutation"): with the cap at 800 the 140-frame
  fixture is one page, `140 <= 800` passes, and the DOM size is unchanged. The
  same defect explains the mutation's symptom in the rewrite — with the divisor
  desynchronised from `PAGE_SIZE`, `windowStart` lands at 4000 in a 700-frame
  session while the DOM still starts at frame 600, which is exactly the
  mismatch §7.1 now asserts.

  Whether the 140-item settled DOM is intended page granularity or a missed trim is
  an **open product decision**, not a spec defect. Waiting for settle without a
  product change makes the spec deterministically red; weakening the assertion to
  get a green was how the `120 -> 800` mutation survived in the first place.
  Tracked as todo 15848cf2, which subsumes 55fe281e.

  **The settled DOM is bounded by page count, not by the frame constant.** Same
  probe, three fixture sizes, sampled to ~2 s, no user scroll at any point:

  | frames | pages | settled items in DOM | pages loaded | `windowStart` |
  |---|---|---|---|---|
  | 140 | 2 | **140** | 2 of 2 (0,1) | 0 |
  | 600 | 5 | **480** | 4 of 5 (1-4) | 120 |
  | 2000 | 17 | **440** | 4 of 17 (13-16) | 1560 |

  So the idle preload materialises the newest **4 pages** (`4 x PAGE_SIZE = 480`
  items, less when the tail page is partial). That is where the 140 comes from at
  the spec's fixture size, and it means `MAX_RENDERED_FRAMES = 120` bounds the
  *frame-state* window, **not** the rendered DOM on the shared scrollview path.
  The DOM is still bounded — it does not grow with session length, 440 at 2000
  frames vs 480 at 600 — but the bound is 4x the constant `898a33b0` set when it
  chose "render 120 initial frames instead of 200".

  **Neither cap constant bounds this path.** `MAX_TOTAL_RENDERED_FRAMES = 800`
  (`kikx-chat-view.mjs:17`) is the other constant a reader might assume is the
  backstop, and it also never reaches the shared scrollview: all five of its uses
  (`:205`, `:211`, `:291`, `:327`, `:359`) sit on the legacy path that
  `_canUseShared()` (`:411-415`) bypasses. `syncFrames` returns at `:183`, before
  `:205`/`:211`; `expandOlderFrames` and `expandNewerFrames` delegate and return
  at `:276-277` and `:312-313`, so the legacy bodies holding `:291` and `:327` are
  never entered, and `showLatestFrames` does the same at `:346-347`; the only two
  `_resolveWindow` call sites (`:217`, `:443`)
  are both downstream of a legacy-only return (`:183`, and `_renderFull`'s shared
  early-return at `:418-421`). On the paged path the bound is therefore
  `PAGE_SIZE` plus the idle preload depth and nothing else — "the DOM is bounded"
  is a statement about preload arithmetic, not about a configured cap.

  Which of these is intended is a product decision: (a) 4 pages of eager preload is
  deliberate read-ahead and `MAX_RENDERED_FRAMES` is simply a state-window
  constant, or (b) the preload should be trimmed to honour the documented render
  cap. This report does not decide it. What it does establish is that **the
  pre-rewrite spec could not distinguish them**: its assertion sampled at 300 ms,
  before the preload lands, and the assertion arithmetic (`140 <= 120`) is
  unsatisfiable once both pages are loaded — which is also why the `120 -> 800`
  mutation survived it rather than being caught. The §7.1 rewrite does not decide
  the product question either; it asserts only the observable contract
  (`windowStart` equals the first mounted index), which both options satisfy and
  a desynchronised cap violates.
- **Three consecutive Playwright full-lane greens post-merge**: `.gate/final-pl.log`
  16:21:40, `.gate/post-cre-pl.log` 16:25:01, `.gate/v2-pl.log` 16:28:16, each
  18/18 `EXIT=0`.
- Per-spec negative controls for every spec changed, each going red at the original
  assertion and green after the fix.
- No `src/` file was modified by any test fix. `git diff --stat` touches specs and
  docs only.
- The lane gate is honest: `scripts/run-test-lanes.mjs` reports PASS/FAIL/EMPTY with
  executed counts and exits non-zero if any selected lane fails, so a lane that
  asserts nothing can no longer read as green.

### 7.1 The `frame-window` race is now removed, not tolerated

The race above was a **spec** defect with a measurable mechanism, so it was fixed
at the source rather than serialised around. `frame-window-puppeteer.mjs` changed
as follows (base `f9ae9d05`; `src/` unmodified, so the product under test is the
committed product):

- Fixture 140 → **700 frames (6 pages)**. At 140 frames two pages hold the
  whole thread, so "bounded" was true only during the ~300 ms transient; at 700
  it is true in every state, so no sample timing is load-bearing.
- **Both fixed `delay()` calls are gone.** The spec now uses
  `waitForFunction` (50 ms poll) to wait for the oldest frame and for the settled
  count, so there is no window to straddle.
- The reveal uses a **real wheel gesture** (`page.mouse.wheel`), not
  `dispatchEvent(new Event('scroll'))`. Measured: a fresh profile is scroll-locked
  (`DEFAULT_LOCKED = true`), and the pin is only broken inside
  `onFrameListScroll()`'s `userGesture` branch, reached only from real input
  listeners. A synthetic scroll leaves the thread locked and the product
  correctly snaps back to the bottom (`.gate/fw3/synthetic.log`: items 100,
  `has0 false` at +250 ms and +3000 ms) while a wheel reaches 700 items with
  frame 0 mounted in 250 ms (`.gate/fw3/wheel.log`). This is the same trap
  already documented in `commit-runtime-event-puppeteer.mjs`.

Evidence. **Provenance:** `src/` is exactly `f9ae9d05` (both files md5-verified).
The three lane runs below ran at 17:12:19–17:13:50 on the working-tree spec
(`b5f58acb…`), i.e. before commit `a40bd6bf` (17:15:52) recorded those same bytes;
the spec's mtime never moved after 17:12:08, so the committed blob is the content
those runs executed. That inference is now backed by direct measurement rather
than by mtime ordering: a spec-only triple re-run *after* the commit
(`.gate/v16/committed.{1,2,3}.log`, `committed.exit`) is 3/3 green — `1=0`,
`2=0`, `3=0`, `pass 1 / fail 0` each, 8194–8458 ms — at `a40bd6bf`, where
`md5sum` of the working file equals `git show HEAD:` (`b5f58acb…`). No other lane
was running.

| what | file | result |
| --- | --- | --- |
| spec x3 | `.gate/fw3/green/run{1,2,3}.log`, `exits.txt` | `RUN1/2/3=0`, `pass 1 / fail 0` each, 8166–8435 ms |
| whole lane, default concurrency, x3 | `.gate/fw3/lane{,2,3}.log`, `lane.exit` | `LANE_EXIT=0`, `LANE2_EXIT=0`, `LANE3_EXIT=0`, `tests 20 / pass 20 / fail 0` each |
| spec x3 **at committed bytes** `a40bd6bf` | `.gate/v16/committed-{1,2,3}.log`, `committed.exit` | `1=0`, `2=0`, `3=0`; `pass 1 / fail 0` each, 8194–8458 ms |
| idle stability, 59 samples / 12 s | `.gate/fw3/idle12s.log` | `IDLE_EXIT=0`, `peak_items=460`, never reaches frame 0 |

**Not proven / open**
- **Long-run determinism for either lane.** Single green runs are not a
  stability claim. `frame-window` is now 3/3 green alone on the working tree, 3/3
  green alone at the **committed** bytes `a40bd6bf` (`.gate/v16/committed.*`),
  and 3/3 green inside the full 20-test concurrent lane (§7.1), which retires the
  earlier "green in isolation, red in the lane" split — but that is 9 runs in two
  modes, not a soak. The solo triples are measured at the committed bytes
  `a40bd6bf`; the whole-lane triples at `.gate/v15` predate the commit by
  minutes, but two further whole-lane concurrent runs were measured **at
  committed HEAD `379bac1c`** (`.gate/v18/`: `LANE_1=0`, `LANE_2=0`, 20/20
  each), so the lane-green claim no longer rests on pre-commit runs.
- `tool-output-overflow` ran 3/3 green in isolation
  (`.gate/det6/to-{1,2,3}.log`); its lane behaviour is still untested.
- ~~A surviving `MAX_RENDERED_FRAMES` mutation~~ — **resolved by the §7.1 rewrite.**
  The mutation run (`.gate/fw3/mut-max800.exit`, 17:12:41) executed the
  working-tree spec whose bytes commit `a40bd6bf` later recorded; it was not
  re-run post-commit. History: setting the constant from 120 to 800 left the spec GREEN
  because `count <= MAX_RENDERED_FRAMES` was satisfiable by any cap >= 20. The
  rewritten spec asserts `windowStart === first mounted index` instead, which the
  mutation breaks (`.gate/fw3/mut-max800.exit` = `1`). Tracked as todo `15848cf2`
  (subsuming `55fe281e`), now closed on that evidence.
- **`PAGE_SIZE` now has behavioural coverage too, and the fixture guard is gone.**
  The first page-size probe was not behavioural: `assert.ok(FRAME_COUNT > PAGE_SIZE * 2)`
  fired 1.8 ms in, before Chromium launched, so no DOM assertion ever ran
  (`.gate/fw3/mut-pagesize800.exit`). That guard checked the constant against the
  fixture rather than the product against behaviour, so it was deleted and the spec
  now observes the DOM under whatever page size is configured. Measured at `4b2e5dff`:
  `PAGE_SIZE 120 -> 800` fails in-browser after 876 ms on
  `the window holds the whole thread (700 === 700)` at `:258`, and
  `MAX_RENDERED_FRAMES 120 -> 800` still fails on
  `windowStart 4000 !== first mounted 600` at `:262` (`.gate/fw4/`). Both mutations
  restored byte-identically (`RESTORED=yes`, three md5s equal in `*.restore.txt`).
  Caveat: at `PAGE_SIZE 800` the whole 700-frame thread is one server page, so
  "bounded" is vacuous there — the probe proves the constant reaches the mount path,
  not that trimming works at multi-page sizes.
- **The settled-idle assertion is not a duplicate of the initial one.** Measured at
  `PAGE_SIZE 120` with a 700-frame fixture: the initial snapshot is 100 frames
  (`windowStart 600`, newest page only) while the settled idle snapshot is 460
  (`windowStart 240`, after read-ahead), identical across 111 samples over 12 s with
  no decrease (`.gate/te9/base120.log`, `BASE120_EXIT=0`). Both pass only because
  460 sits 240 below `FRAME_COUNT`; that headroom, not a frame cap, is what the
  assertion rests on.
- **The settled-idle assertion has never been observed to fail *first*, and cannot be
  made to without reordering the spec.** A `PAGE_SIZE 180` probe (700 frames -> 4
  pages) was run with every assertion evaluated observationally, so none aborted the
  others (`.gate/te9/pagesize180.probe.log`, `PROBE_EXIT=0`; real spec run
  `PAGESIZE180_SPEC_EXIT=1` at `:262`, no timeout). Result: `initial.count` 160 passes
  the bound, and `settled.count` 700 **fails** `settled: the settled idle window is
  bounded` — so the assertion encodes a real property and is not vacuous. But
  `SETTLED_IS_FIRST_TO_FIRE=false`: at 180 the earlier
  `windowStart === first mounted index` identity at `:262` breaks first
  (`3 x 120 = 360` vs `3 x 180 = 540`), because `_mountPagedSource` divides by the
  constructor `pageSize` (`MAX_RENDERED_FRAMES`) while pages mount at `PAGE_SIZE`.
  A prediction recorded before that run — that 180 would make `settled` the first
  assertion to fire — was **falsified** by it. The honest statement is: *the settled
  assertion covers a later state and would catch a page-size regression, but it has
  not been shown to fire before the `windowStart` identity at any page size that
  keeps the initial bound true.* Making it fire first needs an assertion-order
  restructure, which is a spec-shape change that was deliberately not made.
- **`SINGLE_PAGE_THREAD` gates no assertion, and no positive-equality form was added
  to it.** The constant at spec `:107` is arithmetic (`PAGE_SIZE >= FRAME_COUNT`,
  which is `false` at shipped constants, so a branch body would be unreachable except
  under a mutation). Its only two live references are those two message sites and
  they neither skip nor enable a check. A literal `assert.equal(count, FRAME_COUNT)`
  was proposed for that branch and declined: the shipped strict inequality at `:258`
  already fails under the `PAGE_SIZE 800` mutation with a message naming `PAGE_SIZE`
  as the governor, so a second assertion on the same predicate would add churn to a
  spec whose green and red behaviour had already been measured twice, and buy no
  discriminating power.

- The `tool-output-overflow` mutation (force a visible scrollbar) was designed but
  never run, so that spec's discriminating power is unmeasured, not proven.
- **The lane is not 3/3 green under 3-way concurrency at `a205609f`, and the red is a
  boot timeout, not this work.** `.gate/te12/head-lane1.log` fails
  `Puppeteer commit bursts do not rebuild the thread or move the viewport` with
  `TimeoutError: Waiting for selector kikx-frame-item[data-frame-id="frame_24"]`,
  cause `Waiting failed: 10000ms exceeded`, at `commit-runtime-event-puppeteer.mjs:65`
  — the *boot* wait, 16.5 s into the test, before any commit-burst assertion runs.
  The same spec is green solo in 2285 ms with the same command
  (`.gate/v28/commit-solo1.log`, `COMMIT_SOLO1_EXIT=0`), and green in lanes 2 and 3
  at 21.5 s and 21.7 s. Note what those two passes mean: even when it *passed*, the
  full lane inflated this spec from 1.96 s to 21.5 s (~11x), so its fixed 10 s boot
  budget sits inside the lane's own noise band and failed in 1 of 3 runs. A causal
  sentence here previously read "the 10 s boot budget is contended by two sibling
  Chrome instances" — **that is falsified below and has been removed.** That spec is
  untouched by this work (`git diff --name-only a40bd6bf..HEAD` lists only
  `frame-window-puppeteer.mjs` and this report) and was last changed by `8722b4e1`,
  which introduced its real-wheel scroll. **Not fixed here** — it is a different
  spec's timeout budget, and widening it would mask rather than diagnose boot cost.
  It is the honest qualifier on any "the lane is green" claim at this HEAD.
  **A reproduction attempt under sustained contention did NOT reproduce it, and that
  null does not clear the failure.** `.gate/te13/sust-probe.log` ran the same ladder
  under 19 concurrent holders (`HOLD_MS=25000`) with the probe starting 8 s late: it
  finished in 8536 ms with all work phases totalling ~530 ms against 496 ms solo
  (`fixture_server` 15 ms, `puppeteer_launch` 199 ms, `goto_domcontentloaded` 38 ms,
  `wait_frame_24` 238 ms) — nowhere near the budget. Two methodology limits make this a
  null rather than an exoneration: (a) the ladder allows **20000 ms** on
  `wait_frame_24` where the failing spec allows **10000 ms** (`.gate/te13/ladder.mjs:117`
  vs `commit-runtime-event-puppeteer.mjs:65`), so an inflation of up to 2x reads as a
  ladder success; and (b) the holders idle *after* booting, while the real failure has
  three siblings in their **boot phase simultaneously**. A 20-way concurrent boot ladder
  spanned 3337–5341 ms (`.gate/te13/c20-*.log`), also under budget. So the phase that
  absorbs the cost remains unmeasured; the reproduction gap is recorded, not papered over.
  Three targeted reproductions of the *sibling-contention* model all came back green, so
  that model is falsified rather than merely unproven (`.gate/te14/`, prediction written to
  disk before each launch): (a) **3 concurrent copies of only this spec** — `LANE1/2/3_EXIT=0`,
  test bodies 2311 / 2337 / 2317 ms against a 1949 ms solo control, ~19% inflation against
  te12's 16.5 s; runner wall 3080 ms < summed lane durations 8133 ms, so the overlap is
  proven rather than assumed; (b) **the same copy under two 700-frame `frame-window`
  siblings** — green at 2030 ms with boot 612 ms vs 542 ms solo (fixture 18 ms, launch
  208 ms, goto 54 ms, `frame_24` 283 ms; ~13% inflation); (c) the earlier te13 ladder, whose
  null is separately discounted above. Copies were staged under `.gate/te14/` with the shared
  fixture import rewritten to an absolute path, because a relative `../stagehand/` import from
  that directory dies in ~158 ms with `ERR_MODULE_NOT_FOUND` — and the staged copy was
  itself control-run green in 2321 ms, so the passes are not module artefacts.
  **The third model — sequential boot churn across the full 20-spec lane — has now been
  measured, and it separates into a confirmed mechanism and a non-reproduced failure.**
  `.gate/te17/` ran te12's exact command three times concurrently with only additive
  `__mark` calls: budgets untouched, `timeout: 10000` count 3 before and after, spec
  restored to `95b1bfbf…` and proven by md5 in both directions, prediction on disk before
  launch. Load was matched, not merely similar — wall 37309 / 37067 / 37234 ms against
  te12's 37205 / 35827 / 37602 ms, mean parallelism 7.87 / 8.24 / 8.09. All three lanes
  were green (20/20, zero `TimeoutError`), so pre-registered P1 held and the red was
  **not reproduced**.
  The phase ladder does show, for the first time, that contention lands squarely on the
  budgeted call. Measured against the same instrument in a single lane
  (`.gate/te16coord`): cumulative puppeteer launch 592 ms → 2715–4597 ms (4.6–7.8x);
  cumulative goto 1536 ms → 4664–7585 ms (3.0–4.9x); cumulative boot-to-`frame_24`
  3503 ms → 9956–13001 ms (2.8–3.7x); and the selector wait that actually carries the
  budget, `frame_24` minus goto, 1967 ms → **4229–5560 ms (2.2–2.8x)**. So the mechanism
  is real and was previously unmeasured. But it peaked **4440 ms short of the 10000 ms
  budget**, in the same wall-time band that produced te12's timeout — which is why this
  is recorded as *non-reproduction with a bound*, not as an exoneration. The bound is the
  finding: contention alone, measured at matched load, does not reach the budget, so the
  red also requires something outside this trial — the unseparated host background load,
  or a rarer event layered on it. Two lanes' boot paths also exceeded 10000 ms *in total*
  (10224, 13001) while the test still passed, because the fixed budget is on the selector
  call alone; a boot path slower overall than the budget does not by itself fail.
  Related null worth keeping: test-body duration does not predict the outcome. Lane 3
  spent 19040 ms in this test — longer than te12's failing 16507 ms — and passed.
  **Fleet context, re-derived from source rather than the earlier classification file:**
  `commit-runtime-event` is the *only* spec in the 17 with both `goto` (`:63`) and its first
  boot selector (`:65`) at 10000 ms. An earlier claim in this session that `mention-message`
  also held both at 10000 was **wrong**: its `goto` is 10000 (`:49`) but its first selector is
  15000 (`:51`), as is its `_startupSettled` poll (`:57`), and its only 10000 selector (`:63`)
  is post-boot. So the narrow boot budget is a singleton, not a fleet pattern.
- `aeor-framework`'s intermittent (§6), which lives upstream.
- The 16 Puppeteer-only specs have not been ported. Until they are, Puppeteer is
  load-bearing and must stay.
- Stagehand's 28 tests have never run here; whether they pass is unknown, not green.

## 8. Recommendation

1. **Keep both lanes for now.** Both are green; deletion costs 16 specs of coverage.
2. **Drop Stagehand.** Measured at `9e9ec60d`: 28/28 fail, 0 pass, 0 skipped, on a
   refused AeorDB connection. It needs a paid key plus a live `:6830` and has never
   passed a single test here, so it can gate nothing. If it is kept it must be given
   credentials and a live AeorDB, because a lane that always fails is as useless as
   one that always silently passes.
3. **Port the 16 Puppeteer-only specs to Playwright**, highest-value first:
   `frame-window`, `frame-bottom-scroll`, `tool-output-overflow`,
   `frame-filter-popup`, `hidden-frame-filter`, `mobile-layout`,
   `agent-progress-full-text`, `commit-runtime-event`.
   Port the *assertion*, not the tool. Carry the async-ordering lessons with them.
4. **Remove the Puppeteer lane only after** its unique specs are ported and green —
   and note the owner added two of those specs himself on 2026-10-30
   (`hidden-frame-filter` in `81c6f2f8`, `raw-markdown` in `d0b32190`), so this is
   live work, not dead weight.
5. **Track the `aeor` intermittent upstream.** It is the only red Playwright has
   produced, and it is in the framework repo's own suite, not in a `kikx2` spec.

## 9. Coordinator validation of the Test-Eng triage

The `todo-card-load` repair was delivered by a delegated agent and then re-proved
here independently rather than accepted on its report. Its message cited
`HEAD 4233fa2e`, which is three commits stale; every check below was therefore run
at the shipped tree.

| Check | Command | Result |
|---|---|---|
| Fix is green, twice | `node --test --test-timeout=60000 spec/ui/puppeteer/todo-card-load-puppeteer.mjs` | `EXIT=0` ×2, `tests 1 / pass 1 / fail 0 / skipped 0` (`.gate/v3/todo-1.log`, `todo-2.log`) |
| Negative control really ran a browser | spec replaced in place by `git show 5910fc4f^:` (md5 `93ebfbaf…`), run, then `git checkout --` to md5 `7d4b218e…` | `EXIT=1`, `fail 1`, `duration_ms 16252`, `TimeoutError: Waiting for selector kikx-todo-tool-use .kikx-todo-item__title` at `todo-card-load-puppeteer.mjs:101:5` (`.gate/v3/todo-negctl2.log`) |
| Fix is spec-only | `git show --stat 5910fc4f` | one file, `+51 / −7`, 0 under `src/` |

The first attempt at that control was invalid and is recorded so the mistake is not
repeated: the original spec was copied to `.gate/v3/`, where its relative import
`../stagehand/stagehand-test-utils.mjs` does not resolve. It exited 1 in 158 ms with
`ERR_MODULE_NOT_FOUND` — a red that proves nothing. A negative control must be run
in the directory whose imports it needs, and a fast failure must be read before it
is counted.

### 9.1 Independent corroboration of the four older repairs

`Kikx-Test-Eng` re-ran the four previously-repaired specs at `38aec6e4` and rebuilt
a negative control for each, restoring every file byte-identically afterwards. This
is stronger evidence than the coordinator's own controls, because each red fired on
its **named assertion** rather than on a missing module or a load error — the exact
mistake recorded above.

| Spec | Green | Control exit | Control failed on |
|---|---|---|---|
| `commit-runtime-event` | `1/1` `EXIT=0` | `1` | `expected the list scrolled to the top before the commit burst` |
| `frame-bottom-scroll` | `1/1` `EXIT=0` | `1` | `the thread reaches its bottom` |
| `frame-window` | `1/1` `EXIT=0` | `1` | `older reveal remains bounded (140)` |
| `tool-output-overflow` | `1/1` `EXIT=0` | `1` | `the collapsed command is clipped horizontally` |

`AssertionError=1 / TimeoutError=0` for all four, i.e. no control red was a timeout
masquerading as a failure. Restoration verified by `md5sum` against
`git show HEAD:` for each path (`match=YES` ×4) with `git diff --stat` empty.

Its full-lane run at the same tree is a fifth consecutive Puppeteer green:
`TE4_LANE_FULL_EXIT=0`, `tests 20 / pass 20 / fail 0 / skipped 0`,
`duration_ms 10673.6`, 17 spec files, `--- any failures: NONE`,
`--- any skipped: NONE`.

## 10. What would change this recommendation

- If the 16 Puppeteer-only specs are ported and green in Playwright, Puppeteer has
  no unique coverage left and the "keep both" half of this recommendation expires.
- If Playwright's `aeor-framework` intermittent turns out to be *caused* by this
  repo's usage rather than the framework's own deferred render, the "Playwright has
  a narrower failure surface" argument weakens.
- If `OPENAI_API_KEY` and AeorDB become available, Stagehand's 28 tests could be
  measured for the first time. Disqualification here is on *unavailability and
  silent pass*, not on measured failure.
