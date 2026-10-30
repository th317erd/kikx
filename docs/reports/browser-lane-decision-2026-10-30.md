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
| `ui:puppeteer` | 17 | 20 | `puppeteer-core` only | **Yes** | **20/20 pass, EXIT=0** (4 consecutive post-merge full-lane runs) |
| `ui:stagehand` | 26 | 28 | `@browserbasehq/stagehand` | **No** | **never executed on this host** |

Import counts are exclusive — `grep -ho "from '...'"` yields exactly one browser
package per lane (`playwright`, `puppeteer-core`, `@browserbasehq/stagehand`), so
there is no hidden cross-dependency between them.

### Why Stagehand is disqualified on evidence, not preference

All 26 Stagehand specs gate on `loadStagehandOpenAIAPIKey()`. `OPENAI_API_KEY` is
unset and AereoDB on `:6830` is not listening, so **every spec skips** and the lane
exits **0 having asserted nothing**. That is the "PASS having executed zero tests"
defect in its purest form: it reports success by doing no work. It also drives a
real browser through a paid model, so it is slow and non-deterministic even when
it can run. It is the one lane with **zero** measurements behind it.

## 2. The two viable lanes barely overlap

Exactly **one** file stem is common to both lanes: `thinking-rack`. The globs are
disjoint (`*-playwright.mjs` vs `*-puppeteer.mjs`), so `npm test` never sees either.
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
  sequentially, no Chrome contention.
- **Four consecutive Puppeteer full-lane greens, all post-merge,** by log mtime:
  `.gate/final-pp.log` 16:21:28, `.gate/v2-pp.log` 16:28:04, `.gate/zav-pp-det3.log`
  16:30:07, `.gate/zav-pp-det4.log` 16:30:18 — each `tests 20 / pass 20 / fail 0 /
  skipped 0` and `EXIT=0`. The merge was committed at 16:21:13 and `6c923a3f` is an
  ancestor of every fix commit (`9b911866`'s parent *is* `6c923a3f`), so these runs
  describe the merged tree, not the local one. The last two ran after `9675efb3`,
  which touches this report only.
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

**Not proven / open**
- **Long-run determinism for either lane.** Both have now shown a membership flip
  at least once. Single green runs are not a stability claim.
- `aeor-framework`'s intermittent (§6), which lives upstream.
- The 16 Puppeteer-only specs have not been ported. Until they are, Puppeteer is
  load-bearing and must stay.
- Stagehand's 28 tests have never run here; whether they pass is unknown, not green.

## 8. Recommendation

1. **Keep both lanes for now.** Both are green; deletion costs 16 specs of coverage.
2. **Drop Stagehand.** It cannot run on this host, and when it cannot run it
   silently reports pass. If it is kept, its specs must fail loudly when the key is
   missing rather than skip.
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

## 10. What would change this recommendation

- If the 16 Puppeteer-only specs are ported and green in Playwright, Puppeteer has
  no unique coverage left and the "keep both" half of this recommendation expires.
- If Playwright's `aeor-framework` intermittent turns out to be *caused* by this
  repo's usage rather than the framework's own deferred render, the "Playwright has
  a narrower failure surface" argument weakens.
- If `OPENAI_API_KEY` and AereoDB become available, Stagehand's 28 tests could be
  measured for the first time. Disqualification here is on *unavailability and
  silent pass*, not on measured failure.
